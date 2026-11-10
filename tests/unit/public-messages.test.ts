import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../shared/types'
import { createEventAdmission, publicMessageIdentity, reducePublicMessage, type PublicMessageStream } from '../../renderer/lib/public-messages'
let n = 0
const event = (type: AgentEvent['type'], payload: Record<string, unknown> = {}): AgentEvent => ({ type, payload, event_id: `e${++n}`, session_id: 's', project_id: 'p', created_at: new Date(1000 + n).toISOString() })
describe('public response boundaries, not run-long prose', () => {
  it('splits two responses and preserves per-response identity and original text', () => {
    let stream: PublicMessageStream = { content: '' }
    const messages: unknown[] = []
    const send = (e: AgentEvent) => { const result = reducePublicMessage(stream, e); stream = result.stream; messages.push(...result.finished) }
    send(event('assistant_message_boundary', { public_message_id: 'a', boundary: 'start', at: 123 }))
    send(event('message_delta', { public_message_id: 'a', text: '好，' }))
    send(event('message_delta', { public_message_id: 'a', text: '这是第一条。' }))
    send(event('assistant_message_boundary', { public_message_id: 'a', boundary: 'end' }))
    send(event('assistant_message_boundary', { public_message_id: 'b', boundary: 'start' }))
    send(event('message_delta', { public_message_id: 'b', text: '现在发现仍未完成。' }))
    send(event('completed'))
    expect(messages).toMatchObject([{ public_message_id: 'a', timestamp: 123, content: [{ text: '好，这是第一条。' }] }, { public_message_id: 'b', content: [{ text: '现在发现仍未完成。' }] }])
    expect(stream.content).toBe('')
  })
  it('empty tool-only messages, repeat ends and late deltas never create or duplicate a bubble', () => {
    let state: PublicMessageStream = { content: '' }
    for (const e of [event('assistant_message_boundary', { public_message_id: 'empty', boundary: 'start' }), event('assistant_message_boundary', { public_message_id: 'empty', boundary: 'end' }), event('message_delta', { public_message_id: 'empty', text: 'late' }), event('completed')]) {
      const next = reducePublicMessage(state, e); expect(next.finished).toEqual([]); state = next.stream
    }
  })
  it('host prose cannot join the preceding Pi response; terminal preserves interrupted tail once', () => {
    const a = reducePublicMessage({ content: '模型回复', public_message_id: 'a', message_at: 1 }, event('message_delta', { text: '宿主暂停原因' }))
    expect(a.finished[0].content[0].text).toBe('模型回复')
    const b = reducePublicMessage(a.stream, event('error'))
    expect(b.finished[0].content[0].text).toBe('宿主暂停原因')
    expect(reducePublicMessage(b.stream, event('completed')).finished).toEqual([])
  })
  it('thinking never enters public content and legacy flow completion only flushes text', () => {
    expect(reducePublicMessage({ content: '' }, event('thinking_delta', { text: 'private' })).stream.content).toBe('')
    expect(reducePublicMessage({ content: 'legacy' }, event('message_completed')).finished[0].content[0].text).toBe('legacy')
  })
  it('disk tree id and streamed id deduplicate by public identity, preserving user receipt priority', () => {
    const base = { role: 'assistant' as const, content: [], timestamp: 1, public_message_id: 'a' }
    expect(publicMessageIdentity({ ...base, id: 'disk' })).toBe(publicMessageIdentity(base))
    expect(publicMessageIdentity({ ...base, role: 'user', client_message_id: 'user' })).toBe('client:user')
  })
})
describe('IPC event admission', () => {
  it('is idempotent, rejects stopped-run tails and older generations, and permits next run', () => {
    const admit = createEventAdmission()
    const first = event('message_delta', { run_id: 'one', client_message_id: 'u', run_generation: 1, text: 'a' })
    expect(admit(first)).toBe(true); expect(admit(first)).toBe(false)
    expect(admit(event('completed', { run_id: 'one' }))).toBe(true)
    expect(admit(event('message_delta', { run_id: 'one', text: 'late' }))).toBe(false)
    expect(admit(event('message_delta', { run_id: 'two', client_message_id: 'u', run_generation: 2 }))).toBe(true)
    expect(admit(event('message_delta', { run_id: 'one', client_message_id: 'u', run_generation: 1 }))).toBe(false)
    expect(admit(event('message_delta', { run_id: 'another-project-run', text: 'a' , client_message_id:'u',run_generation:1, }))).toBe(false)
  })
  it('retains a current completed-run decision without admitting stale other-run decisions', () => {
    const admit = createEventAdmission()
    expect(admit(event('completed', { run_id: 'one' }))).toBe(true)
    expect(admit(event('user_decision_required', { run_id: 'one' }))).toBe(true)
    expect(admit(event('message_delta', { run_id: 'two' }))).toBe(true)
    expect(admit(event('user_decision_required', { run_id: 'one' }))).toBe(false)
  })
})

it('rejects unkeyed old terminals with different IDs while admitting legitimate current host reset and static decisions', () => {
  const admit = createEventAdmission()
  const old = { ...event('completed'), created_at: new Date(1000).toISOString() }
  expect(admit(old)).toBe(true)
  expect(admit({ ...event('message_delta', { run_id: 'new', text: 'head' }), created_at: new Date(2000).toISOString() })).toBe(true)
  expect(admit({ ...old, event_id: 'different-old-exit' })).toBe(false)
  expect(admit({ ...event('message_delta', { run_id: 'new', text: 'tail' }), created_at: new Date(3000).toISOString() })).toBe(true)
  expect(admit({ ...event('completed'), created_at: new Date(4000).toISOString() })).toBe(true)
  expect(admit({ ...event('user_decision_required'), created_at: new Date(5000).toISOString() })).toBe(true)
})
