import { withFundedExecutionWindow } from '../../../main/software/execution-limits'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { saveSoftwareRunState, readSoftwareRunState } from '../../../main/software/run-state'
import { softwareStatusView } from '../../../main/software/state-view'
import { softwareWorkingContext, renderSoftwareWorkingContext,renderWorkingFacts } from '../../../main/software/working-context'
import { buildProductionContextTool } from '../../../main/desktop/production-context'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { leanBudget } from '../../../main/desktop/lean-budget'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
it('keeps blockers and unfinished processes when intent and tool history overflow the recovery budget',()=>{
  const facts=softwareWorkingContext(project.project_id)
  facts.current_error='CURRENT_BLOCKER '+('long diagnostic '.repeat(1000))+' LAST_CAUSE'
  facts.intent={experience:{summary:'x'.repeat(100000)},rules:[]} as never
  facts.pending_commands=[{process_id:'still-running',state:'running'}] as never
  facts.recent.tools=Array.from({length:100},()=>({tool:'read_file',status:'returned',path:'x'.repeat(1000)}))
  const rendered=renderWorkingFacts(facts),body=JSON.parse(rendered.split('\n').slice(1).join('\n'))
  expect(rendered.length).toBeLessThan(8000)
  expect(body.current_error).toContain('CURRENT_BLOCKER');expect(body.current_error).toContain('LAST_CAUSE')
  expect(body.pending_commands).toEqual([{process_id:'still-running',state:'running'}])
  expect(body.budget.accounting_available).toBe(true)
  expect(body.omitted_sections.map((r:{field:string})=>r.field)).toEqual(expect.arrayContaining(['intent','current_error','recent']))
  expect(body.omitted_sections.find((r:{field:string})=>r.field==='intent').read_more.arguments.topic).toBe('features')
})
it('retains the source error beyond the old 2400-character cutoff and provides a bounded head/tail projection',()=>{
  const error='ROOT_CAUSE '+('diagnostic '.repeat(1500))+' FINAL_CAUSE'
  saveSoftwareRunState({projectId:project.project_id,sessionId:'s',runId:'r',status:'blocked',error})
  expect(readSoftwareRunState(project.project_id)?.error).toBe(error)
  const snapshot=JSON.parse(renderSoftwareWorkingContext(project.project_id).split('\n').slice(1).join('\n'))
  expect(snapshot.current_error).toContain('ROOT_CAUSE');expect(snapshot.current_error).toContain('FINAL_CAUSE')
  expect(softwareWorkingContext(project.project_id).current_error).toBe(error)
})
it('includes the late failed case and its expected/actual values in recovery, marking it historical',()=>{
  const result={status:'failed',summary:'failed',core:{host_cli:{cases:Array.from({length:30},(_,i)=>({name:'case-'+i,covers:['F-001'],passed:i!==29,exit_code:0,expected:{stdout:'wanted',exit_code:0},actual:i===29?'observed':'wanted'}))}}}
  const dir=join(home,'software-verification');mkdirSync(dir)
  writeFileSync(join(dir,project.project_id+'.json'),JSON.stringify({version:1,state:'complete',result,result_hash:createHash('sha256').update(JSON.stringify(result)).digest('hex')}))
  const snapshot=JSON.parse(renderSoftwareWorkingContext(project.project_id).split('\n').slice(1).join('\n'))
  expect(snapshot.verification).toMatchObject({freshness:'historical_not_revalidated',usable_for_delivery:false,first_blocker:{name:'case-29',expected:{stdout:'wanted',exit_code:0},actual:'observed'}})
})
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-working-state-')); process.env.PROMA_HOME = home; project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
it('clears stale errors on a new run but retains redacted history and never calls an ended turn delivered', () => {
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'old', status: 'blocked', error: 'api_key=PRIVATE_KEY' })
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'running' })
  const state = readSoftwareRunState(project.project_id)!
  expect(state.error).toBeUndefined(); expect(state.last_failure?.run_id).toBe('old'); expect(state.last_failure?.error).not.toContain('PRIVATE_KEY')
  const checking = saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'verifying', error: 'historical warning from caller' })
  expect(checking.error).toBeUndefined(); expect(checking.last_failure?.error).toContain('historical warning')
  expect(softwareStatusView(project.project_id, false)).toMatchObject({ execution: { status: 'interrupted' }, goal: { status: 'not_delivered' } })
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'verified' })
  expect(softwareStatusView(project.project_id, false)).toMatchObject({ execution: { status: 'ended' }, goal: { status: 'not_delivered' } })
  updateProject(project.project_id, { current_stage: 'completed', desktop_phase: 'delivered', status: 'completed' })
  expect(softwareStatusView(project.project_id, false).goal.status).toBe('delivered')
})
it('labels a valid old verification as history and refuses a corrupt receipt', () => {
  const result = { status: 'passed', summary: 'old version' }, dir = join(home, 'software-verification'); mkdirSync(dir)
  const receipt = { state: 'complete', at: Date.now(), result, result_hash: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
  writeFileSync(join(dir, project.project_id + '.json'), JSON.stringify(receipt))
  expect(softwareStatusView(project.project_id, false)).toMatchObject({ verification: { status: 'last_passed' }, goal: { status: 'not_delivered' } })
  expect(softwareStatusView(project.project_id,false).verification.scope_note).toContain('历史记录未分层')
  const layered={...result,core:{acceptance_evidence:{version:1,coverage:'registered_case_references',registered_checks:'passed',implementation:'not_assessed',external_model_effects:'unverified',complete_requirements:'not_assessed'}}}
  writeFileSync(join(dir,project.project_id+'.json'),JSON.stringify({...receipt,result:layered,result_hash:createHash('sha256').update(JSON.stringify(layered)).digest('hex')}))
  expect(softwareStatusView(project.project_id,false).verification.scope_note).toContain('真实供应商连通和模型效果尚未验证')
  writeFileSync(join(dir, project.project_id + '.json'), JSON.stringify({ ...receipt, result_hash: 'corrupt' }))
  expect(softwareStatusView(project.project_id, false).verification.status).toBe('unavailable')
})
it('restores current version and bounded tool facts without including credentials or replaying commands', () => {
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'running' })
  mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  writeFileSync(join(home, 'agent-sessions/s.jsonl'), [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'run_command', input: { command: ['secret-command-argument'] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', is_error: true, content: '{"code":"COMMAND_TIMEOUT","stderr":"api_key=PRIVATE_KEY"}' }] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n')
  const before = softwareWorkingContext(project.project_id)
  expect(before.recent.tools).toContainEqual(expect.objectContaining({ tool: 'run_command', status: 'failed', failure: 'COMMAND_TIMEOUT' }))
  expect(JSON.stringify(before)).not.toContain('PRIVATE_KEY'); expect(JSON.stringify(before)).not.toContain('secret-command-argument')
  writeFileSync(join(project.root_path, 'changed.js'), 'console.log("changed")')
  expect(softwareWorkingContext(project.project_id).current_source).not.toBe(before.current_source)
  const live = leanBudget(project.project_id, 'desktop-implement').snapshot(); mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(live.file, JSON.stringify({ version: 1, requests: 9, output: 5000, phases: { 'desktop-implement': 9 } }))
  expect(softwareWorkingContext(project.project_id).budget).toMatchObject({ requests: 9, output: 5000, accounting_available: true })
  const rendered = renderSoftwareWorkingContext(project.project_id)
  expect(rendered.length).toBeLessThan(8000); expect(() => JSON.parse(rendered.split('\n').slice(1).join('\n'))).not.toThrow()
})
it('discovers metadata first and serves only the requested capability protocol', async () => {
  const tool = buildProductionContextTool(project.project_id), ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', state: createToolState(), signal: new AbortController().signal }
  const catalog = await tool.execute({ topic: 'capabilities' }, ctx)
  expect(JSON.parse(catalog.output).catalog.some((x: { topic: string }) => x.topic === 'execution')).toBe(true)
  expect(catalog.output).not.toContain('from speech_runtime import SpeechEngine')
  const command = await tool.execute({ topic: 'execution' }, ctx)
  expect(command.output).toContain('yield_ms'); expect(command.output).not.toContain('speech_runtime')
  expect((await tool.execute({ topic: 'capabilities' }, { ...ctx, projectId: 'foreign' })).isError).toBe(true)
})

it('exposes an outer deadline and monetary admission facts without treating them as new authorization',()=>{
  const deadlineAt=Date.now()+60000
  const facts=withFundedExecutionWindow(()=>({remainingRequests:8,remainingRmb:2.5,outputRmbPerMillion:8,deadlineAt}),()=>softwareWorkingContext(project.project_id))
  expect(facts.execution_window).toMatchObject({available:true,remaining_requests:8,admission_remaining_rmb:2.5,deadline_at:new Date(deadlineAt).toISOString()})
  const rendered=JSON.parse(renderWorkingFacts(facts).split('\n').slice(1).join('\n'))
  expect(rendered.execution_window.remaining_ms).toBeGreaterThan(0)
  expect(softwareWorkingContext(project.project_id).execution_window).toEqual({available:false})
})

it('reports declared runtime compatibility before executing a final acceptance suite',()=>{
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,command:['python','main.py'],ui:'webview'}))
  expect(softwareWorkingContext(project.project_id).declared_entry).toMatchObject({ui:'webview',native_js_acceptance_supported:false})
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,command:['electron','main.cjs'],ui:'electron',window_title:'fixture'}))
  expect(softwareWorkingContext(project.project_id).declared_entry).toMatchObject({ui:'electron',native_js_acceptance_supported:true})
})
