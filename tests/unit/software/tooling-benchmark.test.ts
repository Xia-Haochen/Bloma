import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { createProject } from '../../../main/project/project-service'
import { buildAgentTools, setJsSyntaxCheckerForTests } from '../../../main/agent/tools/agent-tools'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'

// Controlled tool contract measurements, NOT provider tokens or end-to-end
// quality. Run this same driver on both revisions. No hard wall-clock claims.
const originalHome = process.env.PROMA_HOME
afterEach(() => { restorePromaHome(originalHome); setJsSyntaxCheckerForTests() })
it('measures useful search, multi-file reading, long lines and paired edits', async () => {
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-tooling-bench-'))
  setJsSyntaxCheckerForTests(async () => ({ ok: true }))
  const project = createProject({ request_id: 'controlled-tooling', mode: 'quick' })
  mkdirSync(join(project.root_path, 'src'), { recursive: true })
  for (let n = 0; n < 4; n++) writeFileSync(join(project.root_path, `src/module${n}.js`), `const label${n} = 'module${n}'\nexport const target${n} = ${n}\n`)
  writeFileSync(join(project.root_path, 'src/long.txt'), '中'.repeat(100000))
  writeFileSync(join(project.root_path, 'src/edit.js'), 'const first = 1\nconst second = 2\n')
  const tools = buildAgentTools({ projectId: project.project_id, software: true, realFullstackVariant: true })
  const ctx: ToolContext = { projectId: project.project_id, sessionId: 'benchmark', requestId: 'benchmark', signal: new AbortController().signal, state: createToolState() }
  const rows: Array<{ scenario: string; tool: string; input_bytes: number; output_bytes: number; execution_ms: number }> = []
  const call = async (scenario: string, name: string, input: Record<string, unknown>) => {
    const started = performance.now(), result = await tools.find(t => t.name === name)!.execute(input, ctx)
    rows.push({ scenario, tool: name, input_bytes: Buffer.byteLength(JSON.stringify(input)), output_bytes: Buffer.byteLength(result.output), execution_ms: performance.now() - started })
    expect(result.isError, result.output).not.toBe(true)
    return result
  }
  let search = await call('useful_search', 'grep', { pattern: 'target2', glob: '*.js' })
  if (!search.output.includes('export const target2 = 2')) search = await call('useful_search', 'read_file', { path: 'src/module2.js', offset: 2, limit: 1 })
  expect(search.output).toContain('export const target2 = 2')
  const schema = tools.find(t => t.name === 'read_file')!.input_schema as { properties: Record<string, unknown> }
  if (schema.properties.files) {
    const batch = await call('four_file_read', 'read_file', { files: Array.from({ length: 4 }, (_, n) => ({ path: `src/module${n}.js`, limit: 2 })) })
    for (let n = 0; n < 4; n++) expect(batch.output).toContain(`label${n}`)
  } else for (let n = 0; n < 4; n++) await call('four_file_read', 'read_file', { path: `src/module${n}.js`, limit: 2 })
  await call('long_line', 'read_file', { path: 'src/long.txt', limit: 1 })
  await call('paired_edits', 'read_file', { path: 'src/edit.js' })
  const editSchema = tools.find(t => t.name === 'edit_file')!.input_schema as { properties: Record<string, unknown> }
  if (editSchema.properties.edits) await call('paired_edits', 'edit_file', { path: 'src/edit.js', edits: [{ old_string: 'first = 1', new_string: 'first = 3' }, { old_string: 'second = 2', new_string: 'second = 4' }] })
  else {
    await call('paired_edits', 'edit_file', { path: 'src/edit.js', old_string: 'first = 1', new_string: 'first = 3' })
    await call('paired_edits', 'edit_file', { path: 'src/edit.js', old_string: 'second = 2', new_string: 'second = 4' })
  }
  const report = { schema_version: 1, kind: 'controlled_tools_not_provider_billing', rows, scenarios: [...new Set(rows.map(r => r.scenario))].map(scenario => {
    const subset = rows.filter(r => r.scenario === scenario)
    return { scenario, calls: subset.length, input_bytes: subset.reduce((n, r) => n + r.input_bytes, 0), output_bytes: subset.reduce((n, r) => n + r.output_bytes, 0), execution_ms: subset.reduce((n, r) => n + r.execution_ms, 0) }
  }) }
  const destination = process.env.TOOLING_REPORT
  if (destination) { if (!isAbsolute(destination)) throw Error('ABSOLUTE_REPORT_PATH_REQUIRED'); writeFileSync(destination, JSON.stringify(report, null, 2)) }
  expect(rows.length).toBeGreaterThan(0)
})
