// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { WorkspaceShell } from '../../renderer/components/WorkspaceShell'
import { workflowStageAtom } from '../../renderer/components/atoms'
import { activeAgentSessionIdAtom, agentMessagesFamily, currentProjectAtom, globalUserErrorAtom } from '../../renderer/agent-atoms'
import { workspaceScene } from '../../renderer/lib/workspace-scene'
import type { Project } from '../../shared/types'
afterEach(() => { cleanup(); delete window.electronAPI })
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
describe('软件剧场的完整性', () => {
  it('places a scope confirmation in the main stage with a single actionable choice', () => {
    const store = createStore(), select = vi.fn()
    store.set(currentProjectAtom, { project_id: 'scope-p', name: '课程笔记', mode: 'longterm' } as Project)
    store.set(workflowStageAtom, 'blocked_for_user_decision')
    render(<Provider store={store}><WorkspaceShell decisionKind="lean_scope" decisionScope={{ goal: '课程笔记', usage: '本机浏览器', features: [{ id: 'F-001', description: '自动保存', expected: '重开保留' }], constraints: [], out_of_scope: [] }} cardOptions={[{ id: 'confirm', label: '按这份做' }]} onCardOptionSelect={select} /></Provider>)
    const panel = screen.getByRole('region', { name: '需求确认' })
    expect(panel.closest('.theatre-product')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '按这份做' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: '确认需求' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '按这份做' })); expect(select).toHaveBeenCalledTimes(1)
  })
  it('the action-first region keeps the sole real sketch confirmation callback and disables it while confirming', () => {
    const store = createStore()
    store.set(currentProjectAtom, { project_id: 'footer-project', name: '测试草图', mode: 'quick' } as Project)
    store.set(workflowStageAtom, 'sketch_ready')
    const confirm = vi.fn()
    const view = render(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://footer-project/00_UX/ux-sketch.html" onConfirmSketch={confirm} /></Provider>)
    const button = document.querySelector('[data-ai-id="confirm-sketch-button"]') as HTMLButtonElement
    expect(document.querySelectorAll('[data-ai-id="confirm-sketch-button"]')).toHaveLength(1)
    expect(button.closest('.action-guidance')).toBeTruthy()
    fireEvent.click(button)
    expect(confirm).toHaveBeenCalledTimes(1)
    view.rerender(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://footer-project/00_UX/ux-sketch.html" onConfirmSketch={confirm} confirming /></Provider>)
    expect(button.disabled).toBe(true)
  })
  it('完整历史切换保留输入；回复不截断折叠，错误直接可见', () => {
    const store=createStore()
    store.set(activeAgentSessionIdAtom,'s'); store.set(currentProjectAtom,{project_id:'p'} as Project)
    store.set(globalUserErrorAtom,'启动失败：尚未验证，请重试')
    store.set(agentMessagesFamily('s'),[
      {role:'user',content:[{type:'text',text:'最开始的需求'}],timestamp:1},
      {role:'assistant',content:[{type:'text',text:'很早的回答'}],timestamp:2},
      {role:'user',content:[{type:'text',text:'这一次的修改'}],timestamp:3},
      {role:'assistant',content:[{type:'text',text:'当前结果。\n\n'+Array.from({length:40},(_,i)=>`验收条件 ${i+1}：记录内容应与输入一致。`).join('\n')+'\n未验证的窗口关闭行为仍需确认。'}],timestamp:4},
    ])
    Element.prototype.scrollIntoView=vi.fn()
    render(<Provider store={store}><ChatPanel presentation="theatre" /></Provider>)
    const input=screen.getByRole('textbox')
    fireEvent.change(input,{target:{value:'不能丢失的草稿'}})
    expect(screen.queryByText('最开始的需求')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('尚未验证')
    expect(document.querySelector('[data-ai-id="compact-reply"]')).toBeNull()
    expect(document.body.textContent).toContain('未验证的窗口关闭行为仍需确认')
    fireEvent.click(screen.getByRole('button',{name:'历史'}))
    expect(screen.getByText('最开始的需求')).toBeTruthy()
    fireEvent.click(screen.getByRole('button',{name:'返回当前'}))
    expect(screen.queryByText('最开始的需求')).toBeNull()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('不能丢失的草稿')
    expect(screen.getByRole('textbox')).toBe(input)
  })
  it('desktop delivered 但项目未 completed 时不宣称已交付，暂停不伪装继续制作', () => {
    const project={status:'active',current_stage:'clarifying',desktop_phase:'delivered'} as Project
    expect(workspaceScene(project,'clarifying','delivered',false).title).toBe('先试一试')
    expect(workspaceScene({...project,desktop_blocked:{reason:'user-stop',at:'now'}},'clarifying','desktop-implement',false).title).toBe('制作暂时停止')
    expect(workspaceScene({...project,desktop_blocked:{reason:'user-stop',at:'now'}},'clarifying','desktop-implement',false,true).title).toBe('制作')
    expect(workspaceScene({...project,status:'completed'},'completed','delivered',false).title).toBe('你的软件')
  })
})

it('Escape closes only the topmost inspection surface and preserves the input', () => {
  const store = createStore()
  store.set(currentProjectAtom, { project_id: 'escape-p', name: '笔记', mode: 'quick' } as Project)
  render(<Provider store={store}><WorkspaceShell /></Provider>)
  const input = screen.getByRole('textbox', { name: '消息输入' })
  fireEvent.change(input, { target: { value: '保留草稿' } })
  const docs = screen.getByRole('button', { name: /^文档$/ })
  docs.focus(); fireEvent.click(docs)
  fireEvent.click(screen.getByRole('button', { name: /需求：/ }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('complementary', { name: '项目文档' })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('complementary', { name: '项目资料面板' })).toBeNull()
  expect(document.activeElement).toBe(docs)
  expect((input as HTMLTextAreaElement).value).toBe('保留草稿')
})

it('opens the microphone test from the main acceptance action, including from a sketch view', async () => {
  const store = createStore()
  store.set(currentProjectAtom, { project_id: 'mic-project', name: '语音聊天', mode: 'quick' } as Project)
  store.set(workflowStageAtom, 'testing')
  const send = vi.fn()
  const assistedAcceptance = vi.fn().mockResolvedValue({
    ok: true, data: { candidate_id: 'a'.repeat(64), phase: 'available', detail: '需要实体麦克风实测。' },
  })
  window.electronAPI = { projectDeliverables: {
    assistedAcceptance,
    get: vi.fn().mockResolvedValue({ ok: true, data: { status_view: {
      execution: { status: 'waiting_user', label: '等待实测' },
      verification: { status: 'last_unverified', label: '待实测' },
      goal: { status: 'not_delivered', label: '尚未交付' },
      guidance: { headline: '完成麦克风实测', detail: '选择设备并录音。', action: 'assisted_acceptance', action_label: '继续验收' },
    }, launch: { declared: false }, files: [] } }),
  } } as unknown as typeof window.electronAPI
  render(<Provider store={store}><WorkspaceShell previewUrl="bloma-file://mic-project/sketch.html" onSendMessage={send} /></Provider>)
  const guidance = within(screen.getByRole('region', { name: '现在该做什么' }))
  fireEvent.click(await guidance.findByRole('button', { name: '继续验收' }))
  const heading = await screen.findByRole('heading', { name: '麦克风实测' })
  await waitFor(() => expect(document.activeElement).toBe(heading))
  expect(screen.getByRole('button', { name: '准备麦克风测试' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '工作记录' })).toBeNull()
  expect(assistedAcceptance).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'mic-project', action: 'query' }))
  expect(send).not.toHaveBeenCalled()
})
