// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActionGuidance } from '../../renderer/components/ActionGuidance'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily, agentStreamStateFamily } from '../../renderer/agent-atoms'
import type { SoftwareStatusView } from '../../shared/types'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const view: SoftwareStatusView = { execution: { status: 'blocked', label: '需处理' }, verification: { status: 'last_passed', label: '最近记录通过' }, goal: { status: 'not_delivered', label: '尚未交付' }, active_commands: 0, guidance: { headline: '程序还没完成，点击“继续制作”接着处理。', detail: '会先检查当前条件。', action: 'continue', action_label: '继续制作' } }
it('action-first, historical PASS never becomes a delivered headline, one real primary action', async () => {
  let finish!: () => void
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  render(<ActionGuidance view={view} onAction={send} onRefresh={vi.fn()} onRecords={vi.fn()} />)
  expect(screen.getByRole('heading').textContent).toContain('点击“继续制作”')
  const button = screen.getByRole('button', { name: '继续制作' })
  fireEvent.click(button); fireEvent.click(button)
  expect(send).toHaveBeenCalledTimes(1)
  await act(async () => finish())
})
it('decision override cannot fall through to an old continue button; processing needs no primary action', () => {
  const props = { view, onAction: vi.fn(), onRefresh: vi.fn(), onRecords: vi.fn() }
  const ui = render(<ActionGuidance {...props} override={{ headline: '请确认这个界面。', detail: '请选择下方选项。' }} />)
  expect(screen.queryByRole('button', { name: '继续制作' })).toBeNull()
  ui.rerender(<ActionGuidance {...props} view={{ ...view, guidance: { headline: '现在不用操作，正在帮你检查程序。', detail: '尚未交付。' } }} />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('heading').textContent).toContain('不用操作')
})
it('read failure offers a read-only retry, not remake/continue', () => {
  const refresh = vi.fn()
  render(<ActionGuidance failed view={view} onRefresh={refresh} onAction={vi.fn()} onRecords={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '重新读取进度' }))
  expect(refresh).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: '继续制作' })).toBeNull()
})
it('acknowledgement remains in full prose, never gets promoted as a character heading', () => {
  const store = createStore(); store.set(activeAgentSessionIdAtom, 's')
  const prose = '好，\n\n'+ '这里是必须完整保留的技术说明：Authorization 和401的区别。\n\n'.repeat(15)
  store.set(agentMessagesFamily('s'), [{ role: 'assistant', public_message_id: 'a', content: [{ type: 'text', text: prose }], timestamp: 1 }])
  const ui = render(<Provider store={store}><ChatPanel presentation="theatre" /></Provider>)
  expect(screen.queryByText('当前回复')).toBeNull()
  expect(ui.container.querySelector('.conversation-character-lead')?.textContent).toBe('Bloma 的回复')
  expect(ui.container.querySelectorAll('.conversation-character-lead p')).toHaveLength(0)
  expect(ui.container.textContent?.match(/这里是必须完整保留/g)).toHaveLength(15)
  expect(ui.container.textContent).toContain('好，')
})
it('identified public prose survives audit replay with tool blocks; technical words do not cause hiding', () => {
  const store = createStore(); store.set(activeAgentSessionIdAtom, 's')
  store.set(agentMessagesFamily('s'), [{ role: 'assistant', id: 'tree', public_message_id: 'public', content: [{ type: 'text', text: 'API和token的说明是正常公开答复。' }, { type: 'tool_use', id: 'tool', name: 'read_file', input: {} }], timestamp: 1 }])
  render(<Provider store={store}><ChatPanel presentation="theatre" /></Provider>)
  expect(screen.getByText('API和token的说明是正常公开答复。')).toBeTruthy()
})
it('reading history is not interrupted by streaming; new-message affordance returns to bottom', () => {
  const store = createStore(); store.set(activeAgentSessionIdAtom, 's')
  store.set(agentStreamStateFamily('s'), { running: true, events: [], content: 'first' })
  const ui = render(<Provider store={store}><ChatPanel /></Provider>)
  const scroll = ui.container.querySelector('[data-ai-id="message-scroll"]') as HTMLElement
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 300 } })
  scroll.scrollTop = 100; fireEvent.scroll(scroll)
  act(() => store.set(agentStreamStateFamily('s'), { running: true, events: [], content: 'first second' }))
  expect(scroll.scrollTop).toBe(100)
  fireEvent.click(screen.getByRole('button', { name: '有新消息，点击查看' }))
  expect(scroll.scrollTop).toBe(1200)
  expect(screen.queryByRole('button', { name: '有新消息，点击查看' })).toBeNull()
})
