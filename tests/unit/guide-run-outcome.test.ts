import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/types'

vi.mock('../../main/guide/guide-agent-service', () => ({ handleGuideMessage: vi.fn() }))
vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: () => ({ env: { ANTHROPIC_MODEL: 'fixture' } }) }))
vi.mock('../../main/desktop/desktop-route', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../main/desktop/desktop-route')>(),
  handleDesktopDispatchMessage: vi.fn(),
}))
import { handleGuideMessage } from '../../main/guide/guide-agent-service'
import { runAgent } from '../../main/orchestration/stages/agent-dispatch'
import { setAgentStreamPublisher } from '../../main/orchestration/stages/sdk-glue'
import { createProject, updateProject } from '../../main/project/project-service'
import { syncDocuments } from '../../main/project/document-sync'
import { parseLeanBrief } from '../../main/guide/lean-brief'
import { readPrdBackplane } from '../../main/project/prd-store'
import { handleDesktopDispatchMessage } from '../../main/desktop/desktop-route'
import { getAgentSessionPath } from '../../storage/config-paths'

let home: string, previous: string | undefined
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-guide-outcome-')); process.env.PROMA_HOME = home
})
afterEach(() => {
  setAgentStreamPublisher(() => undefined); vi.clearAllMocks()
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  rmSync(home, { recursive: true, force: true })
})
it.each(['incomplete', 'error', 'success'] as const)('preserves downstream %s after an earlier successful confirmation', async outcome => {
  const project = createProject({ request_id: 'create', mode: 'quick' },{workflowVersion:'software-v1'}), events: AgentEvent[] = []
  setAgentStreamPublisher(event => events.push(event))
  vi.mocked(handleGuideMessage).mockImplementationOnce(async (input, publish) => {
    for (const subtype of ['success', outcome, 'success']) publish({ event_id: 'event', session_id: input.session_id, project_id: input.project_id,
      type: 'message_completed', created_at: new Date().toISOString(), payload: { subtype } })
  })
  await runAgent({ request_id: 'confirm', project_id: project.project_id, session_id: 'session', mode: 'quick', current_stage: 'clarifying',
    content: '确认草图，开工', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } })
  expect(events.filter(event => event.type === 'completed').at(-1)?.payload.subtype).toBe(outcome === 'success' ? 'success' : 'incomplete')
})

it('persists the desktop continuation question as assistant text on conversation reload', async () => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const id = project.project_id
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '整理语音', ui: 'required',
    requirements: [{ description: '整理语音', expected: '保留原意' }] }),
  { projectId: id, sessionId: 'speech-session', source: '整理语音', previous: readPrdBackplane(id), software: true })
  if (parsed?.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'brief', project_id: id, session_id: 'speech-session', checkpoint: 'requirement_confirmed' }, parsed.brief)
  updateProject(id, { current_stage: 'generating_mvp', desktop_phase: 'desktop-implement' })
  const question = '这段语音整理后的完整文本应是什么？'
  vi.mocked(handleDesktopDispatchMessage).mockImplementationOnce(async (input, deps) => {
    deps.persistAssistant(input.sessionId, question)
    deps.persistSystem(input.sessionId, '[fixture] waiting for answer')
    deps.complete(input.sessionId, input.projectId, 'incomplete')
  })
  await runAgent({ request_id: 'continue', project_id: id, session_id: 'speech-session', mode: 'quick',
    current_stage: 'generating_mvp', content: '继续' })
  const messages = readFileSync(getAgentSessionPath('speech-session'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(messages.filter(row => row.role === 'assistant').map(row => row.content[0].text)).toEqual([question])
  expect(messages.some(row => row.role === 'system' && row.content[0].text === '[fixture] waiting for answer')).toBe(true)
})
