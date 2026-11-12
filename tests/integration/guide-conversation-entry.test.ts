import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/types'
import { createProject, findProject } from '../../main/project/project-service'
import { loadMessages } from '../../main/platform/sessions/session-service'
import { runAgent } from '../../main/orchestration/stages/agent-dispatch'
import { resetSDKQueryForTests, setSDKQueryForTests, setAgentStreamPublisher } from '../../main/orchestration/stages/sdk-glue'
import { readPrdBackplane } from '../../main/project/prd-store'
import { readPendingDecision } from '../../main/guide/pending-decision'
vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: () => ({ env: { ANTHROPIC_MODEL: 'CONTROLLED_OFFLINE_ONLY' } }) }))
let home: string, previous: string | undefined
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-guide-entry-')); process.env.PROMA_HOME = home
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('NETWORK_FORBIDDEN') }))
})
afterEach(() => {
  resetSDKQueryForTests(); setAgentStreamPublisher(() => {}); vi.unstubAllGlobals()
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
it('original runAgent → real guide → SDK result → visible reply and durable history, without a task card', async () => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const events: AgentEvent[] = [], requests: string[] = []
  setAgentStreamPublisher(event => events.push(event))
  setSDKQueryForTests(async function* (prompt) {
    requests.push(prompt)
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'reply', text: '我是Bloma，你的软件制作助手。' }) }] } }
    yield { type: 'result', subtype: 'success' }
  })
  const input = { request_id: 'identity', project_id: project.project_id, session_id: 'public-entry', mode: 'quick' as const, current_stage: 'clarifying' as const, content: '你是谁', metadata: { source: 'chat' as const } }
  await runAgent(input)
  expect(requests).toHaveLength(1)
  expect(events.filter(event => event.type === 'message_delta').map(event => event.payload.text)).toEqual(['我是Bloma，你的软件制作助手。'])
  expect(events.filter(event => event.type === 'completed').at(-1)?.payload.subtype).toBe('success')
  const restored = loadMessages({ request_id: 'reopen', session_id: input.session_id })
  const text = restored.messages.filter(message => message.role === 'assistant').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
  expect(text).toEqual(['我是Bloma，你的软件制作助手。'])
  expect(readPendingDecision(project.project_id, input.session_id)).toBeUndefined()
  expect(readPrdBackplane(project.project_id).requirements).toHaveLength(0)
  expect(findProject(project.project_id).desktop_phase).toBeUndefined()
  expect(events.some(event => event.type === 'user_decision_required')).toBe(false)
})
it('task card remains recoverable after an ordinary follow-up through original runAgent', async () => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  let calls = 0
  setSDKQueryForTests(async function* () {
    const result = ++calls === 1 ? { action: 'brief', name: '本地笔记', goal: '保存笔记', ui: 'required', requirements: [{ description: '保存笔记', expected: '关闭重开仍在' }] }
      : { action: 'reply', text: '尚未开工，确认制作范围后才会继续。' }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }] } }
    yield { type: 'result', subtype: 'success' }
  })
  const input = { request_id: 'task', project_id: project.project_id, session_id: 'task-question', mode: 'quick' as const, current_stage: 'clarifying' as const, content: '做一个本地笔记软件' }
  await runAgent(input)
  const before = readPendingDecision(project.project_id, input.session_id)
  await runAgent({ ...input, request_id: 'question', content: '现在已经在开发了吗？' })
  expect(calls).toBe(2)
  expect(readPendingDecision(project.project_id, input.session_id)).toEqual(before)
  expect(loadMessages({ request_id: 'reopen', session_id: input.session_id }).messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === '尚未开工，确认制作范围后才会继续。'))).toBe(true)
  expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  expect(readPrdBackplane(project.project_id).user_confirmed_at).toBeUndefined()
})
