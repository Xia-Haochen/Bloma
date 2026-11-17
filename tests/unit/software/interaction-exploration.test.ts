import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { createInteractionExploration, runInteractionExploration, interactionExplorationAdmission, readInteractionEvidence } from '../../../main/software/interaction-exploration'
import { completedQualityReview, readQualityLedger, qualityIdentity, qualityRulesVersion, saveQualityLedger } from '../../../main/software/quality-ledger'
import { qualityCloseout, findingNeedsInvestigation } from '../../../main/software/quality-closeout'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildQualityFindingsTool } from '../../../main/software/quality-findings-tool'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
let home: string, old: string | undefined, project: ReturnType<typeof createProject>
const sessions: Awaited<ReturnType<typeof createInteractionExploration>>[] = []
const context = (sessionId = 'parent', signal = AbortSignal.timeout(60000)): ToolContext => ({ projectId: project.project_id, sessionId, requestId: 'explore-test', signal, state: createToolState() })
const expected = '保存内容并在重开后仍显示原内容'
beforeEach(async () => {
  old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-explorer-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '保存草稿', ui: 'required', delivery: 'browser', requirements: [{ description: '保存草稿', expected }] }),
    { projectId: project.project_id, sessionId: 'parent', source: '保存草稿', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('brief')
  parsed.brief.lean_brief!.preview = 'skip'
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 'parent', checkpoint: 'requirement_confirmed' }, parsed.brief)
  const scope = prdScopeFingerprint(markPrdUserConfirmed(project.project_id)!)
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } })
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port
  await new Promise<void>(r => server.close(() => r()))
  writeFileSync(join(project.root_path, 'server.cjs'), "const fs=require('fs');require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html; charset=utf-8');s.end(fs.readFileSync('index.html'))}).listen(Number(process.argv[2]),'127.0.0.1')")
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs', String(port)], url: `http://127.0.0.1:${port}` }))
  app(true)
})
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
  if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}, 30000)
function app(broken: boolean) {
  writeFileSync(join(project.root_path, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Draft fixture</title><label>Draft<input aria-label="Draft" id="draft"></label><button id="save">Save</button><output role="status" id="saved"></output><script>draft.value=localStorage.getItem('draft')||'';save.onclick=()=>{const value=draft.value;${broken ? "if(!value.includes('Ω'))" : ''}localStorage.setItem('draft',value);saved.textContent='Saved'}</script>`)
}
async function open(signal?: AbortSignal) {
  const session = await createInteractionExploration(project.project_id, context('parent', signal), randomUUID()); sessions.push(session)
  const ctx = context(session.sessionId, signal)
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse((await session.tools.find(t => t.name === name)!.execute(input, ctx)).output)
  return { session, ctx, call }
}
function node(value: any, role: string, name: string) { return (value.observation?.observation?.ui ?? value.observation?.ui)?.nodes.find((n: any) => n.role === role && n.name === name) }
const report = (ids: number[] = [1, 2, 3, 4], trigger = '输入Synthetic Ω后保存并重开') => ({ requirement: 'F-001', expected_source: expected, severity: 'high', trigger, observed: '保存提示成功，但重开输入为空', unknowns: '尚待独立冻结案例复现；不是验收失败凭据', observation_ids: ids })
async function journey(call: Awaited<ReturnType<typeof open>>['call']) {
  let observed = await call('read_interaction_goal')
  observed = await call('explore_ui', { mode: 'act', control: { kind: 'fill', ref: node(observed, 'textbox', 'Draft').ref, value: 'Synthetic Ω' } })
  observed = await call('explore_ui', { mode: 'act', control: { kind: 'click', ref: node(observed, 'button', 'Save').ref } })
  observed = await call('explore_ui', { mode: 'reopen' }); return observed
}
it.each([true, false])('real isolated browser preserves the failing/repaired persistence contrast (broken=%s), never issuing PASS', async broken => {
  app(broken); const before = await qualityIdentity(project.project_id), { session, call } = await open()
  const reopened = await journey(call)
  expect(node(reopened, 'textbox', 'Draft').value).toBe(broken ? '' : 'Synthetic Ω')
  expect((await call('submit_interaction_findings', { findings: broken ? [report(), report()] : [] })).verification).toBe('not_issued')
  const ledger = readQualityLedger(project.project_id)
  expect(ledger.findings).toHaveLength(broken ? 1 : 0); expect(session.submitted()).toBe(true)
  expect(await qualityIdentity(project.project_id)).toEqual(before)
  expect(completedQualityReview(ledger, 'code', before)).toBeUndefined(); expect(completedQualityReview(ledger, 'visual', before)).toBeUndefined()
  if (broken) {
    const finding = ledger.findings[0]; expect(finding.checks).toEqual([]); expect(finding.disposition).toBe('suspected')
    expect(findingNeedsInvestigation(finding, before, qualityRulesVersion(project.project_id))).toBe(true)
    // Exploration must NOT count as a fresh binding/C review.
    expect(qualityCloseout(ledger, before, undefined, qualityRulesVersion(project.project_id))).toMatchObject({ next_tool: 'start_quality_review', purpose: 'binding' })
    const evidence = readInteractionEvidence(project.project_id, finding.id); expect(evidence.text).toContain('Synthetic Ω'); expect(evidence.digest).toHaveLength(64)
    const read = buildQualityFindingsTool(project.project_id, () => {})
    expect(JSON.parse((await read.execute({ finding_id: finding.id }, context())).output).interaction_observations.digest).toBe(evidence.digest)
    expect(existsSync(join(home, 'projects', project.project_id, 'data', 'draft'))).toBe(false)
  }
}, 60000)
it('rejects forged sessions, ungrounded expectations, unknown trace IDs, script/URL capabilities and stale source; no partial submission', async () => {
  const { session, call, ctx } = await open(), read = session.tools[0]
  await expect(read.execute({}, { ...ctx, sessionId: 'parent' })).rejects.toThrow('SESSION_DENIED')
  await call('read_interaction_goal')
  await expect(call('explore_ui', { script: 'dangerous', url: 'https://example.com' })).rejects.toThrow('INPUT_INVALID')
  await expect(call('submit_interaction_findings', { findings: [{ ...report([1]), expected_source: '自动新增备份' }] })).rejects.toThrow('UNGROUNDED')
  await expect(call('submit_interaction_findings', { findings: [report([99])] })).rejects.toThrow('OBSERVATION_INVALID')
  expect(readQualityLedger(project.project_id).findings).toEqual([])
  app(false)
  await expect(call('submit_interaction_findings', { findings: [] })).rejects.toThrow('CANDIDATE_STALE')
}, 60000)
it('deduplicates identical journeys but not different triggers, preserves past findings after source changes, and never turns repair into closure', async () => {
  const first = await open(); await journey(first.call)
  await first.call('submit_interaction_findings', { findings: [report(), report(), report([1, 2], '输入另一草稿后切换对象')] })
  expect(readQualityLedger(project.project_id).findings).toHaveLength(2)
  await first.session.close(); app(false)
  const second = await open(); const reopened = await journey(second.call)
  expect(node(reopened, 'textbox', 'Draft').value).toBe('Synthetic Ω')
  await second.call('submit_interaction_findings', { findings: [] })
  expect(readQualityLedger(project.project_id).findings.map(f => f.disposition)).toEqual(['suspected', 'suspected'])
  const ledger = readQualityLedger(project.project_id); ledger.reviews[0].exploration!.trace[0].sha256 = 'corrupt'; saveQualityLedger(project.project_id, ledger)
  expect(() => readInteractionEvidence(project.project_id, ledger.findings[0].id)).toThrow('UNAVAILABLE')
}, 60000)
it('cancels its own open instance and retains interruption facts without accepting a report or replaying UI', async () => {
  const abort = new AbortController(), { session, call } = await open(abort.signal)
  await call('read_interaction_goal'); abort.abort(Error('user cancelled'))
  await expect(call('explore_ui')).rejects.toThrow('user cancelled')
  await session.close('CANCELLED')
  const ledger = readQualityLedger(project.project_id)
  expect(ledger.findings).toEqual([]); expect(ledger.reviews.at(-1)).toMatchObject({ status: 'interrupted', failure_code: 'CANCELLED' })
}, 60000)
it('protects mandatory closeout requests, output, money and time; missing price does not mean optional work is free', () => {
  const enough = { requests: 8, output: 40000, maxTokens: 4096, mandatoryRequests: 3, remainingMicro: 100, requestMicro: 10, drainMs: 1000 }
  expect(interactionExplorationAdmission(enough).allowed).toBe(true)
  for (const gap of [{ requests: 3 }, { output: 100 }, { windowRequests: 3 }, { remainingMicro: 39 }]) expect(interactionExplorationAdmission({ ...enough, ...gap }).allowed).toBe(false)
  expect(interactionExplorationAdmission({ ...enough, requestMicro: undefined })).toMatchObject({ allowed: false, reason: 'OPTIONAL_COST_UNKNOWN' })
  expect(interactionExplorationAdmission({ ...enough, deadlineAt: 4000, now: 1 })).toMatchObject({ allowed: false, reason: 'OPTIONAL_DEADLINE_PROTECTED' })
})
it('actual Pi uses only three restricted tools, freezes makers, persists findings, reuses complete identity but re-observes after source edits', async () => {
  const policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, 'parent')
  let round = 0, admissions = 0
  const query: SDKQuery = async function* (_prompt, options) {
    expect(options.tools!.map(t => t.name)).toEqual(['read_interaction_goal', 'explore_ui', 'submit_interaction_findings'])
    expect(() => policy.assertFileWrite('index.html', context())).toThrow('FROZEN')
    const results = options.messages?.flatMap(m => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === 'tool_result') as any[]
    const last = results.at(-1), content = last?.content
    const raw = typeof content === 'string' ? content : content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    const observed = raw ? JSON.parse(raw.replace(/^<tool-feedback>[^\n]*<\/tool-feedback>\n/, '')) : undefined
    let name = 'explore_ui', input: Record<string, unknown>
    if (round === 0) { name = 'read_interaction_goal'; input = {} }
    else if (round === 1) input = { mode: 'act', control: { kind: 'fill', ref: node(observed, 'textbox', 'Draft').ref, value: 'Synthetic Ω' } }
    else if (round === 2) input = { mode: 'act', control: { kind: 'click', ref: node(observed, 'button', 'Save').ref } }
    else if (round === 3) input = { mode: 'reopen' }
    else { name = 'submit_interaction_findings'; input = { findings: node(observed, 'textbox', 'Draft').value ? [] : [report()] } }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'step-' + round++, name, input }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  const run = () => runInteractionExploration({ ctx: context(), policy, query, env: {}, maxTokens: 1000, publish: () => {}, admit: () => { admissions++ } })
  expect(await run()).toMatchObject({ status: 'observed', verification: 'not_issued' }); expect(round).toBe(5); expect(admissions).toBeGreaterThan(5)
  expect(() => policy.assertCommand(context())).not.toThrow()
  expect(await run()).toMatchObject({ status: 'already_observed' }); expect(round).toBe(5)
  app(false); round = 0; expect(await run()).toMatchObject({ status: 'observed' }); expect(round).toBe(5)
  expect(readQualityLedger(project.project_id).findings).toHaveLength(1)
  const denied = () => runInteractionExploration({ ctx: context(), policy, query, env: {}, maxTokens: 1000, publish: () => {}, admit: () => { throw Error('OPTIONAL_CLOSEOUT_BUDGET_PROTECTED') } })
  app(true); writeFileSync(join(project.root_path, 'new.txt'), 'new candidate')
  await expect(denied()).rejects.toThrow('BUDGET_PROTECTED')
  expect(readQualityLedger(project.project_id).reviews).toHaveLength(2)
}, 90000)
