// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily, currentProjectAtom } from '../../renderer/agent-atoms'
import { productionNotice } from '../../renderer/lib/production-notice'
import { buildProcessGroupSummary } from '../../renderer/components/ProcessBlockGroup'
import type { Project } from '../../shared/types'
afterEach(cleanup)
it('does not guess a recovery action for unknown failures', () => {
  expect(productionNotice('磁盘读取失败')).toBeUndefined()
  expect(productionNotice('用户讨论了 REQUEST_BUDGET_EXHAUSTED')).toBeUndefined()
})
it('does not count failed tool calls as completed work', () => {
  expect(buildProcessGroupSummary([{kind:'tool',key:'x',tool:'read_file',status:'error'}])).toBe('执行记录 · 1 项')
})
it('summarizes the matching host stop record while retaining its complete details', () => {
  Element.prototype.scrollIntoView = vi.fn()
  const reason='模型请求额度已到，宿主检查未通过，未再调用模型：ASR_CAPABILITY_PREPARATION_REQUIRED'
  const store=createStore()
  store.set(currentProjectAtom,{project_id:'p',desktop_blocked:{reason:'verification-incomplete',note:reason,at:'now'}} as Project)
  store.set(activeAgentSessionIdAtom,'s')
  store.set(agentMessagesFamily('s'),[{role:'assistant',content:[{type:'text',text:reason}],timestamp:1}])
  render(<Provider store={store}><ChatPanel presentation="theatre" /></Provider>)
  expect(screen.getByText('本轮制作额度不足，任务已暂停。')).toBeTruthy()
  const details=document.querySelector('.production-notice-details') as HTMLDetailsElement
  expect(details.open).toBe(false)
  expect(details.textContent).toContain(reason)
  expect(document.body.textContent).toContain('语音组件')
})
it('leaves ordinary assistant text intact even when it mentions a budget', () => {
  Element.prototype.scrollIntoView = vi.fn()
  const store=createStore()
  store.set(currentProjectAtom,{project_id:'p'} as Project)
  store.set(activeAgentSessionIdAtom,'s')
  store.set(agentMessagesFamily('s'),[{role:'assistant',content:[{type:'text',text:'模型请求额度已到，这是用户引用的提示。'}],timestamp:1}])
  render(<Provider store={store}><ChatPanel /></Provider>)
  expect(document.querySelector('.production-notice-details')).toBeNull()
  expect(document.body.textContent).toContain('这是用户引用的提示')
})
