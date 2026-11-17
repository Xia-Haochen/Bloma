// @vitest-environment jsdom
import { createStore } from 'jotai'
import { afterEach, expect, it } from 'vitest'
import { setupGlobalAgentListeners, agentMessagesFamily, agentStreamStateFamily, loadSessionHistory, globalUserErrorAtom } from '../../renderer/agent-atoms'
import type { AgentEvent } from '../../shared/types'
let cleanup: (() => void) | undefined
let id = 0
afterEach(() => { cleanup?.(); delete window.electronAPI; delete window.__jotai_store__ })
function setup(loadMessages?: unknown) {
  const store = createStore(); window.__jotai_store__ = store
  let listener!: (event: AgentEvent) => void
  window.electronAPI = { agent: { onStreamEvent: (callback: typeof listener) => { listener = callback; return () => {} }, loadMessages } } as never
  cleanup = setupGlobalAgentListeners()
  const send = (type: AgentEvent['type'], payload: Record<string, unknown> = {}) => {
    const event: AgentEvent = { event_id: String(++id), session_id: 's', type, payload: { run_id: 'run', ...payload }, created_at: new Date(1000 + id).toISOString() }
    listener(event); return () => listener(event)
  }
  return { store, send }
}
it('actual global listener settles each response, never marks the run ended at a response boundary', () => {
  const { store, send } = setup()
  send('assistant_message_boundary', { boundary: 'start', public_message_id: 'a', at: 100 })
  const duplicate = send('message_delta', { public_message_id: 'a', text: '第一条' }); duplicate()
  send('assistant_message_boundary', { boundary: 'end', public_message_id: 'a' })
  expect(store.get(agentStreamStateFamily('s')).running).toBe(true)
  send('assistant_message_boundary', { boundary: 'start', public_message_id: 'b' })
  send('message_delta', { public_message_id: 'b', text: '第二条' })
  send('assistant_message_boundary', { boundary: 'end', public_message_id: 'b' })
  send('completed')
  expect(store.get(agentMessagesFamily('s')).map(message => message.content[0].text)).toEqual(['第一条', '第二条'])
  expect(store.get(agentStreamStateFamily('s')).running).toBe(false)
})
it('actual listener keeps interrupted text once and rejects stopped-run tails; arbitrary new prose does not clear a host error', () => {
  const { store, send } = setup()
  send('message_delta', { public_message_id: 'a', text: '尚未说完' })
  send('error', { message: '宿主检查未通过' })
  send('message_delta', { public_message_id: 'a', text: '迟到' })
  expect(store.get(agentMessagesFamily('s'))).toHaveLength(1)
  expect(store.get(agentStreamStateFamily('s')).running).toBe(false)
  send('message_delta', { run_id: 'next', public_message_id: 'b', text: '制作方说完成' })
  expect(store.get(globalUserErrorAtom)).toBe('宿主检查未通过')
})
it('concurrent history loading keeps live messages and merges tree-rich disk messages by public identity', async () => {
  let resolve!: (value: unknown) => void
  const { store, send } = setup(() => new Promise(r => { resolve = r }))
  send('message_delta', { public_message_id: 'a', text: '第一条' })
  send('assistant_message_boundary', { boundary: 'end', public_message_id: 'a' })
  const loading = loadSessionHistory('s')
  send('message_delta', { public_message_id: 'b', text: '第二条' })
  send('assistant_message_boundary', { boundary: 'end', public_message_id: 'b' })
  resolve({ ok: true, data: { messages: [{ role: 'assistant', id: 'disk-tree', public_message_id: 'a', content: [{ type: 'text', text: '第一条' }, { type: 'tool_use', id: 't', name: 'read_file' }], timestamp: 1000 }], total: 1 } })
  await loading
  expect(store.get(agentMessagesFamily('s'))).toHaveLength(2)
  expect(store.get(agentMessagesFamily('s'))[0].content).toHaveLength(2)
})
it('a post-terminal decision survives and does not revive running', () => {
  const { store, send } = setup()
  send('completed')
  send('user_decision_required', { kind: 'clarification', options: [{ id: 'yes', label: '确认' }] })
  send('stage_changed', { stage: 'ready' })
  expect(store.get(agentStreamStateFamily('s')).running).toBe(false)
  expect(store.get(agentStreamStateFamily('s')).events.some(event => event.type === 'user_decision_required')).toBe(true)
})

it('replayed unkeyed old host terminal cannot close a newer identified run or swallow its tail', () => {
  const { store, send } = setup()
  const oldTerminal = send('completed', { run_id: undefined })
  send('message_delta', { run_id: 'new-run', public_message_id: 'new-message', text: '新请求首段' })
  oldTerminal()
  send('message_delta', { run_id: 'new-run', public_message_id: 'new-message', text: '新请求后半段' })
  expect(store.get(agentStreamStateFamily('s')).running).toBe(true)
  expect(store.get(agentStreamStateFamily('s')).content).toBe('新请求首段新请求后半段')
  send('completed', { run_id: 'new-run' })
  expect(store.get(agentMessagesFamily('s')).map(message => message.content[0].text)).toEqual(['新请求首段新请求后半段'])
})
