import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runAgentLoop } from '../../main/agent/loop/agent-loop'
import { buildAgentTools, setJsSyntaxCheckerForTests } from '../../main/agent/tools/agent-tools'
import { createProject } from '../../main/project/project-service'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'

const originalHome = process.env.PROMA_HOME
let home: string | undefined
afterEach(() => {
  setJsSyntaxCheckerForTests()
  if (originalHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = originalHome
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
it.each(['same-file','multi-file'])('actual Pi validates %s batch schemas, retains partial failures and commits original-byte edits', async mode => {
  home = mkdtempSync(join(tmpdir(), 'bloma-pi-file-tools-')); process.env.PROMA_HOME = home
  setJsSyntaxCheckerForTests(async () => ({ ok: true }))
  const project = createProject({ request_id: 'pi-tools', mode: 'quick' }, { workflowVersion: 'software-v1' })
  mkdirSync(join(project.root_path, 'src'), { recursive: true })
  writeFileSync(join(project.root_path, 'src/app.js'), 'const first = 1\nconst second = 2\n')
  writeFileSync(join(project.root_path, 'src/other.js'), 'const other = 1' + String.fromCharCode(10))
  const tools = buildAgentTools({ projectId: project.project_id, software: true, realFullstackVariant: true }).filter(t => ['grep', 'read_file', 'edit_file'].includes(t.name))
  let round = 0
  const observations: Array<{ phase: string; id: string; name: string; output?: string; isError?: boolean }> = []
  const tool = (id: string, name: string, input: Record<string, unknown>): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
  const query: SDKQuery = async function* (_task, options) {
    if (round === 0) yield tool('search', 'grep', { pattern: 'first', glob: '*.js' })
    else if (round === 1) {
      expect(JSON.stringify(options.messages)).toContain('const first = 1')
      yield tool('windows', 'read_file', { files: [{ path: 'src/app.js' }, { path: 'src/other.js' }, { path: 'missing.js' }] })
    } else if (round === 2) {
      expect(JSON.stringify(options.messages)).toContain('文件不存在')
      const edit = { path: 'src/app.js', edits: [{ old_string: 'first = 1', new_string: 'first = 3' }, { old_string: 'second = 2', new_string: 'second = 4' }] }
      yield tool('edits', 'edit_file', mode === 'same-file' ? edit : { files: [edit, { path: 'src/other.js', edits: [{ old_string: 'other = 1', new_string: 'other = 3' }] }] })
    } else yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Controlled tools finished; not product acceptance.' }] } }
    round++
    yield { type: 'result', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  const result = await runAgentLoop({ runtimeScope: 'desktop-implement', projectId: project.project_id, sessionId: 'pi-file-tools', requestId: 'pi-file-tools',
    system: 'Controlled offline tool contract test', task: 'read and edit', tools, query, env: {}, maxTokens: 1000, maxTurns: 5, permissionMode: 'allow-all',
    signal: AbortSignal.timeout(30000), publish: () => {}, onToolObservation: event => observations.push(event) })
  expect(result.status).toBe('completed'); expect(round).toBe(4)
  expect(readFileSync(join(project.root_path, 'src/app.js'), 'utf8')).toBe('const first = 3\nconst second = 4\n')
  expect(readFileSync(join(project.root_path, 'src/other.js'), 'utf8').trim()).toBe(mode === 'same-file' ? 'const other = 1' : 'const other = 3')
  expect(observations.filter(e => e.phase === 'completed').map(e => [e.id, e.isError])).toEqual([['search', false], ['windows', true], ['edits', false]])
  expect(result.toolCalls.map(c => c.status)).toEqual(['ok', 'error', 'ok'])
}, 45000)
