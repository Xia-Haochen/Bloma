import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { handleGuideMessage } from '../../../main/guide/stages/guide-pipeline'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { guideConfirmationPath, readGuideConfirmation } from '../../../main/guide/confirmation-journal'
import { getDocumentsDir } from '../../../storage/config-paths'
import { appendSessionMessage } from '../../../main/platform/sessions/session-tree'
import { loadConversationHistory } from '../../../main/platform/sessions/session-service'
import type { SDKQuery, GuideModelOptions } from '../../../main/orchestration/stages/orchestration-contracts'
import type { AgentEvent, AgentSendMessageInput } from '../../../shared/types'

let home: string, oldHome: string | undefined
beforeEach(() => {
  oldHome = process.env.PROMA_HOME
  home = mkdtempSync(join(tmpdir(), 'bloma-guide-conversation-'))
  process.env.PROMA_HOME = home
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('NETWORK_FORBIDDEN_IN_CONVERSATION_TEST') }))
})
afterEach(() => {
  if (oldHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = oldHome
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const softwareBrief = { action: 'brief', name: '本地笔记', goal: '保存本地笔记', ui: 'required', requirements: [{ description: '保存笔记', expected: '关闭重开内容仍在' }], constraints: ['不联网'], out_of_scope: [], assumptions: [] }
function fixture(initial: unknown) {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const events: AgentEvent[] = [], calls: Array<{ prompt: string; options: Parameters<SDKQuery>[1] }> = [], persisted: string[] = []
  let reply = initial
  const query: SDKQuery = async function* (prompt, options) {
    calls.push({ prompt, options })
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(reply) }] } }
    yield { type: 'result', subtype: 'success' }
  }
  const input: AgentSendMessageInput = { project_id: project.project_id, session_id: 'conversation', request_id: 'request', mode: 'quick', current_stage: 'clarifying', content: '你是谁', metadata: { source: 'chat' } }
  const model: GuideModelOptions = { query, env: {}, signal: new AbortController().signal, sessionId: input.session_id, history: [], maxTokens: 8192,
    persistAssistant: text => { persisted.push(text); appendSessionMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() }) } }
  return { project, input, model, calls, events, persisted, setReply: (next: unknown) => { reply = next }, publish: (event: AgentEvent) => events.push(event) }
}
it('answers identity once through the existing call and persists a reply without creating a task', async () => {
  const f = fixture({ action: 'reply', text: '我是Bloma，帮助你把想法做成软件，也可以直接回答问题。' })
  const before = structuredClone(findProject(f.project.project_id))
  await handleGuideMessage(f.input, f.publish, f.model)
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].options.history?.[0].content).toContain('你是Bloma')
  expect(f.calls[0].options.history?.[0].content).toContain('"action":"reply"')
  expect(f.persisted).toEqual(['我是Bloma，帮助你把想法做成软件，也可以直接回答问题。'])
  expect(loadConversationHistory('conversation')).toEqual([{ role: 'assistant', content: f.persisted[0] }])
  expect(f.events.filter(e => e.type === 'message_delta').map(e => e.payload.text)).toEqual(f.persisted)
  expect(f.events.some(e => e.type === 'user_decision_required')).toBe(false)
  expect(readPrdBackplane(f.project.project_id).requirements).toEqual([])
  expect(existsSync(guideConfirmationPath('prd', f.project.project_id))).toBe(false)
  expect(findProject(f.project.project_id)).toEqual(before)
})
it('keeps public dialogue roles and text but excludes host system and tool/image blocks', async () => {
  const f = fixture({ action: 'reply', text: '可以，下面直接给你介绍。' })
  f.model.history = [
    { role: 'system', content: 'HOST_PRIVATE_SENTINEL' },
    { role: 'assistant', content: [{ type: 'text', text: '需要我介绍自己还是介绍某个产品？' }, { type: 'tool_use', id: 'hidden', name: 'INTERNAL_TOOL_SENTINEL', input: {} }] },
    { role: 'user', content: '介绍你自己' },
  ]
  await handleGuideMessage({ ...f.input, content: '这啥玩意啊，我让你介绍啊' }, f.publish, f.model)
  const request = JSON.parse(f.calls[0].prompt)
  expect(request.dialogue).toEqual([
    { role: 'assistant', content: '需要我介绍自己还是介绍某个产品？' },
    { role: 'user', content: '介绍你自己' },
    { role: 'user', content: '这啥玩意啊，我让你介绍啊' },
  ])
  expect(f.calls[0].prompt).not.toContain('HOST_PRIVATE_SENTINEL')
  expect(f.calls[0].prompt).not.toContain('INTERNAL_TOOL_SENTINEL')
  expect(request.conversation).toBe('介绍你自己\n\n这啥玩意啊，我让你介绍啊')
})
it.each(['pending', 'dismissed', 'adjust'] as const)('a reply preserves the %s task candidate and never confirms or starts it', async state => {
  const f = fixture(softwareBrief)
  await handleGuideMessage({ ...f.input, content: '做个本地笔记本' }, f.publish, f.model)
  if (state !== 'pending') await handleGuideMessage({ ...f.input, content: state === 'dismissed' ? '稍后再说' : '补充或修改', metadata: { source: 'card_option', selected_option_id: state === 'dismissed' ? 'lean_pause' : 'lean_adjust' } }, f.publish, f.model)
  const confirmation = guideConfirmationPath('prd', f.project.project_id)
  const prd = join(getDocumentsDir(f.project.workspace_slug, f.project.project_id), 'prd.json')
  const before = { confirmation: readFileSync(confirmation, 'utf8'), prd: readFileSync(prd, 'utf8'), project: structuredClone(findProject(f.project.project_id)) }
  f.events.length = 0; f.calls.length = 0; f.persisted.length = 0
  f.setReply({ action: 'reply', text: '我会直接给出介绍，不会因此开始制作软件。' })
  await handleGuideMessage({ ...f.input, content: '不是让你直接做软件，我让你介绍啊' }, f.publish, f.model)
  expect(f.calls).toHaveLength(1)
  expect(f.persisted).toEqual(['我会直接给出介绍，不会因此开始制作软件。'])
  expect(readFileSync(confirmation, 'utf8')).toBe(before.confirmation)
  expect(readFileSync(prd, 'utf8')).toBe(before.prd)
  expect(findProject(f.project.project_id)).toEqual(before.project)
  expect(readGuideConfirmation('prd', f.project.project_id)?.state).toBe(state)
  expect(f.events.some(e => e.type === 'user_decision_required')).toBe(false)
  expect(f.events.filter(e => e.type === 'stage_changed').every(e => e.payload.stage === before.project.current_stage)).toBe(true)
  expect(readPrdBackplane(f.project.project_id).user_confirmed_at).toBeUndefined()
})
it.each(['', '   ', null, 42])('rejects malformed reply text %j instead of accepting an empty successful answer', text => {
  const f = fixture({})
  expect(parseLeanBrief(JSON.stringify({ action: 'reply', text }), { projectId: f.project.project_id, sessionId: f.input.session_id, source: '你是谁', previous: readPrdBackplane(f.project.project_id), software: true })).toBeUndefined()
})
it('retries a malformed reply with the same dialogue and then publishes one complete answer', async () => {
  const f = fixture({ action: 'reply', text: '' })
  const query = f.model.query
  f.model.query = async function* (prompt, options) {
    if (f.calls.length) f.setReply({ action: 'reply', text: '我是Bloma。' })
    yield* query(prompt, options)
  }
  await handleGuideMessage(f.input, f.publish, f.model)
  expect(f.calls).toHaveLength(2)
  expect(JSON.parse(f.calls[1].prompt).dialogue).toEqual([{ role: 'user', content: '你是谁' }])
  expect(f.persisted).toEqual(['我是Bloma。'])
  expect(f.events.some(e => e.type === 'user_decision_required')).toBe(false)
})
it('keeps a real task revision behind a fresh confirmation after an ordinary reply', async () => {
  const f = fixture(softwareBrief)
  await handleGuideMessage({ ...f.input, content: '做个本地笔记本' }, f.publish, f.model)
  const old = readGuideConfirmation('prd', f.project.project_id)!
  f.setReply({ action: 'reply', text: '可以，保存在本机，不会联网。' })
  await handleGuideMessage({ ...f.input, content: '你刚才说的不联网是什么意思？' }, f.publish, f.model)
  f.setReply({ ...softwareBrief, requirements: [...softwareBrief.requirements, { description: '搜索笔记', expected: '按文字筛选已有笔记' }] })
  await handleGuideMessage({ ...f.input, content: '加一个搜索笔记的功能' }, f.publish, f.model)
  expect(readPrdBackplane(f.project.project_id).requirements).toHaveLength(2)
  expect(readPrdBackplane(f.project.project_id).user_confirmed_at).toBeUndefined()
  expect(readGuideConfirmation('prd', f.project.project_id)?.scope_hash).not.toBe(old.scope_hash)
  expect(findProject(f.project.project_id).current_stage).toBe('blocked_for_user_decision')
  expect(f.calls).toHaveLength(3)
})
