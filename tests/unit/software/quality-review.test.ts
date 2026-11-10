import {applicableQualityLedger} from '../../../main/software/quality-ledger'
import { organizedPrd } from '../../support/organized-prd'
import { projectRequirementsModel } from '../../../main/model/requirements-model'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createQualityReview, readQualityLedger, qualityLedgerPath } from '../../../main/software/quality-review'
import { verifySoftwareCandidate } from '../../../main/software/verification'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { buildLeanCliTool, cliSuitePath } from '../../../main/desktop/lean-cli-check'
import { startDelegation, registerParentLoopContext, disposeParentDelegationState, settleParentDelegationRuns, findDelegation } from '../../../main/agent/delegation/agent-collaboration'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'

let home: string, oldHome: string | undefined, project: ReturnType<typeof createProject>, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, quality: ReturnType<typeof createQualityReview>
const parent = 'quality-parent'
const ctx = (sessionId = parent): ToolContext => ({ projectId: project.project_id, sessionId, requestId: 'r', state: createToolState(), signal: AbortSignal.timeout(60000) })
const finding = { case_name:'sum', requirement: 'F-001', expected_source: '2加3得5', category: 'data', severity: 'high', location: 'app.cjs:1', trigger: '输入2与3', evidence: '实现输出999', reproduction: '正常入口传2与3', unknowns: '', kind: 'suspected' }
it.each(['code','visual'] as const)('rejects known local blockers before creating a paid %s review', async kind => {
  writeFileSync(join(project.root_path, 'unsafe.js'), 'document.body.innerHTML = location.hash')
  await expect(quality.begin(ctx(),kind)).rejects.toThrow('QUALITY_LOCAL_CHECK_REQUIRED')
  expect(readQualityLedger(project.project_id).reviews).toHaveLength(0)
})
beforeEach(async () => {
  oldHome = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-quality-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ assumptions: ['只检查已保存记录，不自动保存草稿'], action: 'brief', goal: '加法', ui: 'none', delivery: 'command', requirements: [{ description: '计算加法', expected: '2加3得5' }] }),
    { projectId: project.project_id, sessionId: parent, source: '加法', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: parent, checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  writeFileSync(join(project.root_path, 'ARCHITECTURE.md'), 'Single addition CLI. Input is parsed at entry; calculation has no I/O or mutable state. Invalid numbers require explicit failure. Verify normal entry and bad input. No persistent data or background processes.')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  const registered = await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '2加3得5' }, cases: [{ name: 'sum', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] }, ctx())
  expect(registered.isError).not.toBe(true)
  policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, parent); quality = createQualityReview(project.project_id, parent, policy)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  disposeParentDelegationState(parent); await settleParentDelegationRuns(parent, 20000)
  if (oldHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = oldHome
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
function register(query: SDKQuery) {
  registerParentLoopContext(parent, { query, env: {}, maxTokens: 2048, maxTurns: 4, delegationMaxTurns: 4, permissionMode: 'allow-all',
    system: 'A_SUCCESS_STORY_MUST_NOT_LEAK', temperature: .1, editFormat: 'diff', maxConcurrentDelegations: 2, allowChannelOverrides: false,
    prepareDelegation: quality.prepare, childAfterTools:quality.childAfterTools, childSystemBuilder: (_role, child) => quality.system(child)!,
    childToolsBuilder: (id, role) => quality.reviewTools(buildSoftwareAgentTools(id, role, policy)), publish: () => {} })
}
async function review(findings: Record<string, unknown>[] = [finding], intent?: unknown[], resolutions?: unknown[], engineering: import('../../../main/software/engineering-design').EngineeringReview | null = {status:'supported',evidence:'app.cjs owns pure addition; CLI owns parsing/output; no persistence or external resources.',limitations:'CLI fixture only'}, purpose:import('../../../main/software/quality-ledger').ReviewPurpose='candidate') {
  let calls = 0
  register(async function* (_prompt, options) {
    if (calls > 0) expect(JSON.stringify(options.messages)).toContain('只检查已保存记录，不自动保存草稿')
    expect(JSON.stringify(options.messages?.filter(m => m.role === 'system'))).not.toContain('A_SUCCESS_STORY_MUST_NOT_LEAK')
    yield { type: 'assistant', message: { role: 'assistant', content: ++calls === 1
      ? [{ type: 'tool_use', id: 'materials', name: 'read_quality_review', input: {} }, { type: 'tool_use', id: 'source', name: 'read_file', input: { path: 'app.cjs' } }, { type: 'tool_use', id: 'submit', name: 'submit_quality_findings', input: { findings, ...(engineering?{engineering}:{}), ...(resolutions?{resolutions}:{}), ...(intent ? { intent_observations: intent } : {}) } }]
      : [{ type: 'text', text: '已提交疑点，未验证。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  })
  const child = await quality.begin(ctx(),'code',undefined,purpose); await findDelegation(parent, child.delegation_id)!.completion; await settleParentDelegationRuns(parent)
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('complete')
  return child
}
it('settles an accepted final review without buying an epilogue request',async()=>{
  let calls=0
  register(async function*(){
    if(++calls>1)throw Error('NO_EPILOGUE_BUDGET')
    yield{type:'assistant',message:{role:'assistant',content:[
      {type:'tool_use',id:'materials',name:'read_quality_review',input:{}},
      {type:'tool_use',id:'source',name:'read_file',input:{path:'app.cjs'}},
      {type:'tool_use',id:'submit',name:'submit_quality_findings',input:{findings:[]}}]}}
    yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  })
  const child=await quality.begin(ctx());await findDelegation(parent,child.delegation_id)!.completion
  expect(calls).toBe(1)
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('complete')
  disposeParentDelegationState(parent)
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('complete')
})
it('actual Pi C submits host-bound findings; a real injected CLI defect fails, is repaired, and closes only after same-case host retest', async () => {
  await review()
  const initial = readQualityLedger(project.project_id).findings[0]
  expect(initial.disposition).toBe('suspected'); expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
  const check = quality.parentTools.find(t => t.name === 'check_quality_finding')!
  await expect(check.execute({ finding_id: initial.id, case_name: 'sum', status: 'passed' }, ctx())).rejects.toThrow('INVALID')
  await check.execute({ finding_id: initial.id, case_name: 'sum' }, ctx())
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('confirmed')
  expect(await quality.gate()).toContain('FINDINGS_OPEN')
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(Number(process.argv[2])+Number(process.argv[3]))')
  expect(await quality.gate()).toContain('FINDINGS_OPEN')
  await check.execute({ finding_id: initial.id, case_name: 'sum' }, ctx())
  const repaired = readQualityLedger(project.project_id).findings[0]
  expect(repaired.disposition).toBe('closed'); expect(repaired.checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(repaired.checks[0].observation).toContain('999'); expect(repaired.checks[1].observation).toContain('5')
  expect(repaired.checks[0].identity.source).not.toBe(repaired.checks[1].identity.source)
  await review([]); expect(await quality.gate()).toBeUndefined()
  // A different contract cannot reuse a closed finding, even with unchanged code.
  const file = cliSuitePath(project.project_id), bytes = readFileSync(file, 'utf8'); writeFileSync(file, bytes + '\n')
  expect(await quality.gate()).toContain('FINDINGS_OPEN')
  await expect(check.execute({ finding_id: initial.id, case_name: 'sum' }, ctx())).rejects.toThrow('CONTRACT_CHANGED')
}, 120000)
it('host verification settles a bound defect after repair without another model tool, and source regression reopens it', async () => {
  await review()
  const id = readQualityLedger(project.project_id).findings[0].id
  await quality.parentTools.find(t => t.name === 'check_quality_finding')!.execute({ finding_id: id, case_name: 'sum' }, ctx())
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(5)')
  await verifySoftwareCandidate(project.project_id, 'host-repair', ctx().signal)
  let f = readQualityLedger(project.project_id).findings[0]
  expect(f.disposition).toBe('closed')
  expect(f.checks.map(c => c.outcome)).toEqual(['failed','passed'])
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  await verifySoftwareCandidate(project.project_id, 'host-regression', ctx().signal)
  f = readQualityLedger(project.project_id).findings[0]
  expect(f.disposition).toBe('confirmed')
  expect(f.checks.map(c => c.outcome)).toEqual(['failed','passed','failed'])
}, 120000)
it('parent cannot forge a C submission; no-source opinions remain disputed/suggestions and cannot be reproduced as defects', async () => {
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx())).rejects.toThrow('DENIED')
  // Suggestions have no confirmed runtime expectation and must not claim a sum binding.
  const {case_name,...unbound}=finding
  await review([{ ...unbound, requirement_id: finding.requirement, expected_source: '应当自动增加备份功能' }, { ...unbound, requirement: 'unscoped', kind: 'suggestion' }])
  const ledger = readQualityLedger(project.project_id)
  expect(ledger.findings.map(f => f.disposition)).toEqual(['disputed', 'suggestion'])
  const read = quality.parentTools.find(t => t.name === 'read_quality_findings')!
  const closeout = JSON.parse((await read.execute({}, ctx())).output)
  expect(closeout.deferred).toEqual(ledger.findings.map(f => f.id))
  expect(closeout.status).toBe('ready');expect(closeout).not.toHaveProperty('next_tool')
  await expect(quality.parentTools.find(t => t.name === 'check_quality_finding')!.execute({ finding_id: ledger.findings[0].id, case_name: 'sum' }, ctx())).rejects.toThrow('UNGROUNDED')
})
it('projects current observed evidence into a finding without repeating verification, but reexecutes after source changes', async () => {
  const {case_name,...unbound}=finding; await review([unbound])
  const id = readQualityLedger(project.project_id).findings[0].id
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(5)')
  const verified = await verifySoftwareCandidate(project.project_id, 'r', ctx().signal)
  expect(verified.status).toBe('passed')
  const check = quality.parentTools.find(t => t.name === 'check_quality_finding')!
  for (let i = 0; i < 2; i++) {
    const reply = await check.execute({ finding_id: id, case_name: 'sum' }, ctx())
    expect(reply.isError).toBe(true)
    expect(readQualityLedger(project.project_id).findings[0].checks.at(-1)?.candidate).toBe(verified.candidate!.id)
  }
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  await check.execute({ finding_id: id, case_name: 'sum' }, ctx())
  const changed = readQualityLedger(project.project_id).findings[0]
  expect(changed.disposition).toBe('suspected')
  expect(changed.checks.at(-1)?.outcome).toBe('failed')
  expect(changed.checks.at(-1)?.candidate).not.toBe(verified.candidate!.id)
}, 120000)
it('does not mark an unobserved reproduction as not reproduced', async () => {
  await review()
  const id = readQualityLedger(project.project_id).findings[0].id
  const result = await quality.parentTools.find(t => t.name === 'check_quality_finding')!
    .execute({ finding_id: id, case_name: 'case-that-was-not-run' }, ctx())
  expect(result.isError).toBe(true)
  expect(readQualityLedger(project.project_id).findings[0]).toMatchObject({ disposition: 'suspected', checks: [{ outcome: 'unverified' }] })
}, 60000)
it('review freezes writers and commands; external source changes and cancellation cannot submit stale findings', async () => {
  register(async function* () { await new Promise(() => {}) })
  const child = await quality.begin(ctx())
  expect(() => policy.assertFileWrite('app.cjs', ctx())).toThrow('FROZEN')
  expect(() => policy.assertCommand(ctx())).toThrow('FROZEN')
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx(child.child_session_id))).rejects.toThrow('MATERIALS_NOT_READ')
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(123)')
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx(child.child_session_id))).rejects.toThrow('STALE')
  disposeParentDelegationState(parent)
  expect(() => policy.assertCommand(ctx())).not.toThrow()
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx(child.child_session_id))).rejects.toThrow('DENIED')
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
})
it('a later cancelled review cannot revive a prior completed review of identical bytes', async () => {
  await review([]); expect(await quality.gate()).toBeUndefined()
  register(async function* () { await new Promise(() => {}) })
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(2)')
  await quality.begin(ctx())
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  disposeParentDelegationState(parent)
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
})
it('does not buy a duplicate complete review and cannot erase important doubts by editing then reviewing', async () => {
  await review([])
  expect(await quality.begin(ctx())).toMatchObject({already_reviewed:true})
  expect(readQualityLedger(project.project_id).reviews).toHaveLength(1)
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(998)')
  const {case_name,...unbound}=finding;await review([unbound])
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(Number(process.argv[2])+Number(process.argv[3]))')
  expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
  const f=readQualityLedger(project.project_id).findings[0]
  await quality.parentTools.find(t=>t.name==='check_quality_finding')!.execute({finding_id:f.id,case_name:'sum'},ctx())
  const observed=readQualityLedger(project.project_id).findings[0]
  expect(observed.disposition).toBe('suspected')
  expect(observed.checks).toHaveLength(1)
  expect(observed.checks[0].observation).toContain('"current_candidate_only":true')
  expect(observed.identity).toEqual(f.identity)
  expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
  await review([],undefined,[{finding_id:f.id,case_name:'sum',evidence:'独立核对sum的输入2和3与原预期相符，由宿主执行。'}])
  expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
  await verifySoftwareCandidate(project.project_id,'r',ctx().signal)
  expect(await quality.gate()).toBeUndefined()
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(7)')
  expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
},60000)
it('a model saying PASS without reading material and submitting the protocol cannot satisfy the completion gate', async () => {
  register(async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'PASS，所有问题已经修复。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  })
  const child = await quality.begin(ctx()); await findDelegation(parent, child.delegation_id)!.completion
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('interrupted')
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
})
it('target/design changes invalidate old C evidence; corruption is not silently converted to an empty ledger', async () => {
  await review([])
  const { updateProject } = await import('../../../main/project/project-service')
  updateProject(project.project_id, { ux_confirmation: { token: 'changed' } as never })
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
  writeFileSync(qualityLedgerPath(project.project_id), '{broken')
  await expect(quality.gate()).rejects.toThrow()
})
it('stops another paid parent request after two identical review interruptions in the same run',async()=>{
  register(async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done without protocol'}]}};yield{type:'result',subtype:'success'}})
  for(let i=0;i<2;i++){const child=await quality.begin(ctx());await findDelegation(parent,child.delegation_id)!.completion;await settleParentDelegationRuns(parent)}
  let calls=0
  const guarded=quality.wrapQuery(async function*(){calls++;yield{type:'result',subtype:'success'}})
  const run=async(runId:string)=>{for await(const _ of guarded('',{env:{},signal:AbortSignal.timeout(5000),sessionId:parent,accounting:{projectId:project.project_id,runId}})){} }
  await expect(run(ctx().requestId)).rejects.toThrow('QUALITY_REVIEW_RETRY_BLOCKED');expect(calls).toBe(0)
  await run('explicit-new-run-after-diagnosis');expect(calls).toBe(1)
  expect(readQualityLedger(project.project_id).reviews).toHaveLength(2)
},30000)
it('waits for an active quality child before buying another parent request',async()=>{
  let release!:()=>void
  const ready=new Promise<void>(done=>{release=done})
  register(async function*(){await ready;yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'no protocol in this controlled wait test'}]}};yield{type:'result',subtype:'success'}})
  const child=await quality.begin(ctx());let calls=0
  createQualityReview(project.project_id,parent,policy)
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('pending')
  const query=quality.wrapQuery(async function*(){calls++;yield{type:'result',subtype:'success'}})
  const waiting=(async()=>{for await(const _ of query('',{env:{},signal:AbortSignal.timeout(10000),sessionId:parent,accounting:{projectId:project.project_id,runId:'r'}})){} })()
  await new Promise(done=>setTimeout(done,20));expect(calls).toBe(0)
  release();await findDelegation(parent,child.delegation_id)!.completion;await waiting
  expect(calls).toBe(1)
},30000)
it('production repairs a previously reviewed defect before buying C for the stable candidate and delivers through the existing verifier', async () => {
  await review()
  const { enterDesktopLine } = await import('../../../main/desktop/desktop-route')
  const { findProject } = await import('../../../main/project/project-service')
  let parentStep = 0, cReviews = 0
  const children = new Set<string>()
  const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: `${parentStep}-${name}`, name, input })
  const query: SDKQuery = async function* (_prompt, options) {
    let content
    if (JSON.stringify(options.messages?.filter(m => m.role === 'system')).includes('独立只读代码/数据审阅C')) {
      if (!children.has(options.sessionId)) {
        children.add(options.sessionId); cReviews++
        expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('closed')
        content = [use('read_quality_review', {}), use('read_file', { path: 'app.cjs' }), use('submit_quality_findings', { findings: [], engineering:{status:'supported',evidence:'Read app.cjs: stateless CLI calculation.',limitations:'Fixture'} })]
      } else content = [{ type: 'text' as const, text: '只读意见已提交。' }]
    } else {
      switch (parentStep++) {
        case 0: content = [{ type: 'text' as const, text: '稳定候选已保留，请核查。' }]; break
        case 1: content = [use('read_file', { path: 'app.cjs' }), use('write_file', { path: 'app.cjs', content: 'console.log(Number(process.argv[2]||2)+Number(process.argv[3]||3))' })]; break
        case 2: content = [use('verify_app', {})]; break
        default: content = [{ type: 'text' as const, text: '修复和复测已执行，请核对当前候选。' }]
      }
    }
    yield { type: 'assistant', message: { role: 'assistant', content } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: parent, requestId: 'r', content: '完成已确认加法软件', maxTokens: 2048, signal: AbortSignal.timeout(90000) }, query, {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(findProject(project.project_id).desktop_blocked, JSON.stringify(readQualityLedger(project.project_id))).toBeUndefined()
  expect(findProject(project.project_id).status).toBe('completed')
  expect(cReviews).toBe(1)
  expect(parentStep).toBe(3) // After the actual passing retest, host owns C and publication.
  const ledger = readQualityLedger(project.project_id)
  expect(ledger.findings[0].disposition).toBe('closed')
  expect(ledger.findings[0].checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(ledger.reviews.filter(r => r.status === 'complete')).toHaveLength(2)
}, 120000)

it('verification hands off to host review and publication without another maker turn',async()=>{
  const {enterDesktopLine}=await import('../../../main/desktop/desktop-route'),{findProject}=await import('../../../main/project/project-service')
  const source='console.log(Number(process.argv[2]||2)+Number(process.argv[3]||3))';writeFileSync(join(project.root_path,'app.cjs'),source)
  let parentCalls=0,unexpected='';const children=new Set<string>()
  const use=(name:string,input:Record<string,unknown>)=>({type:'tool_use' as const,id:`manual-${parentCalls}-${name}`,name,input})
  const query:SDKQuery=async function*(_prompt,options){
    let content
    if(JSON.stringify(options.messages?.filter(m=>m.role==='system')).includes('独立只读代码/数据审阅C')){
      if(!children.has(options.sessionId)){children.add(options.sessionId);content=[use('read_quality_review',{}),use('read_file',{path:'app.cjs'}),use('submit_quality_findings',{findings:[],engineering:{status:'supported',evidence:'Read app.cjs: stateless addition and CLI input/output.',limitations:'Fixture'}})]}
      else content=[{type:'text' as const,text:'结构化审阅已提交。'}]
    }else{parentCalls++;if(parentCalls>1){unexpected=JSON.stringify(options.messages).slice(-5000);throw Error('TEST_UNEXPECTED_IMPLEMENTATION_TURN')}content=[use('verify_app',{})]}
    yield{type:'assistant',message:{role:'assistant',content}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  await enterDesktopLine({projectId:project.project_id,sessionId:parent,requestId:'manual-review',content:'完成当前稳定候选',maxTokens:2048,signal:AbortSignal.timeout(60000)},query,{},
    {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  expect(parentCalls,unexpected).toBe(1);expect(children.size).toBe(1);expect(readFileSync(join(project.root_path,'app.cjs'),'utf8')).toBe(source)
  expect(findProject(project.project_id).status).toBe('completed')
},90000)

it('stops repeated failed checks without buying a review or teaching the maker review protocol',async()=>{
  const {enterDesktopLine}=await import('../../../main/desktop/desktop-route'),{findProject}=await import('../../../main/project/project-service')
  let parentCalls=0;const children=new Set<string>()
  const use=(name:string,input:Record<string,unknown>)=>({type:'tool_use' as const,id:`repeat-${parentCalls}-${name}`,name,input})
  const query:SDKQuery=async function*(_prompt,options){
    let content
    if(JSON.stringify(options.messages?.filter(m=>m.role==='system')).includes('独立只读代码/数据审阅C')){
      if(!children.has(options.sessionId)){children.add(options.sessionId);content=[use('read_quality_review',{}),use('read_file',{path:'app.cjs'}),use('submit_quality_findings',{findings:[],engineering:{status:'supported',evidence:'Read app.cjs: stateless addition and CLI input/output.',limitations:'Fixture'}})]}
      else content=[{type:'text' as const,text:'结构化审阅已提交，不代表业务通过。'}]
    }else{if(++parentCalls>5)throw Error('REPEATED_HOST_FAILURE_NOT_STOPPED');content=[use('verify_app',{})]}
    yield{type:'assistant',message:{role:'assistant',content}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  await enterDesktopLine({projectId:project.project_id,sessionId:parent,requestId:'repeat-review',content:'核对失败检查',maxTokens:2048,signal:AbortSignal.timeout(60000)},query,{},
    {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  expect(parentCalls).toBe(3);expect(children.size).toBe(0)
  expect(findProject(project.project_id).status).not.toBe('completed');expect(findProject(project.project_id).desktop_blocked?.note).toContain('no_progress')
},90000)

it('keeps uncertain experience observations open and permits a new current review to resolve them', async () => {
  const brief = readPrdBackplane(project.project_id)
  const model = organizedPrd(brief.requirements, '核心体验需核对').requirements_model
  model.experience = { summary: '计算过程可见', commitments: [{ id: 'EXP-001', statement: '过程可见', source_ids:['S-001'], feature_ids:['F-001'], scenario_ids:['AC-001'], unacceptable_substitute:'仅显示成功提示' }] }
  syncDocuments({request_id:'intent',project_id:project.project_id,session_id:parent,checkpoint:'requirement_confirmed'},projectRequirementsModel({...brief,requirements_model:model}))
  markPrdUserConfirmed(project.project_id)
  const observation = {commitment_id:'EXP-001',status:'unverified',evidence:'尚未核对输出路径',limitations:'需要检查实际实现'}
  await review([], [observation])
  expect(await quality.gate()).toContain('INTENT_UNRESOLVED')
  await review([], [{...observation,status:'supported',evidence:'已读实现输出具体结果',limitations:'真实行为仍由宿主验证'}])
  // No finding was submitted: review qualification clears, not runtime verification.
  expect(await quality.gate()).toBeUndefined()
  // Intent confirmation also changed scope: the old CLI contract cannot issue PASS.
  expect((await verifySoftwareCandidate(project.project_id,'r',ctx().signal)).status).toBe('unverified')
  expect(readQualityLedger(project.project_id).findings).toEqual([])
  expect(await quality.gate()).toBeUndefined()
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(7)')
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
},60000)

it('requires independent contract rebinding and actual retest after a rule revision',async()=>{
 await review();const f=readQualityLedger(project.project_id).findings[0]
 const check=quality.parentTools.find(t=>t.name==='check_quality_finding')!
 await check.execute({finding_id:f.id,case_name:'sum'},ctx())
 const file=cliSuitePath(project.project_id);writeFileSync(file,readFileSync(file,'utf8')+'\n')
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 await expect(check.execute({finding_id:f.id,case_name:'sum'},ctx())).rejects.toThrow('CONTRACT_CHANGED')
 await review([],undefined,[{finding_id:f.id,case_name:'sum',evidence:'已核对修订前后sum的输入2/3及预期5未变，批准原案例按当前合同重新执行。'}])
 expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('confirmed')
 await verifySoftwareCandidate(project.project_id,'rebound',ctx().signal)
 expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('closed')
 expect(readQualityLedger(project.project_id).findings[0].checks[0].outcome).toBe('failed')
},120000)

it('retires a removed business expectation from the current gate without deleting its failed history',async()=>{
 await review();const id=readQualityLedger(project.project_id).findings[0].id
 await quality.parentTools.find(t=>t.name==='check_quality_finding')!.execute({finding_id:id,case_name:'sum'},ctx())
 const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'输出7',ui:'none',delivery:'command',requirements:[{description:'输出7',expected:'显示7'}]}),{projectId:project.project_id,sessionId:parent,source:'确认改为输出7',previous:readPrdBackplane(project.project_id),software:true})!
 if(parsed.action!=='brief')throw Error('fixture')
 syncDocuments({request_id:'change',project_id:project.project_id,session_id:parent,checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
 expect(applicableQualityLedger(project.project_id).findings.some(f=>f.id===id)).toBe(false)
 expect(readQualityLedger(project.project_id).findings.find(f=>f.id===id)?.disposition).toBe('confirmed')
 expect(await quality.gate()).toContain('REVIEW_REQUIRED')
},120000)

it('host review interruption stops the run without another maker request',async()=>{
 const {enterDesktopLine}=await import('../../../main/desktop/desktop-route'),{findProject}=await import('../../../main/project/project-service')
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 let parentCalls=0,reviewCalls=0
 const query:SDKQuery=async function*(_prompt,options){
  const review=JSON.stringify(options.messages?.filter(m=>m.role==='system')).includes('独立只读代码/数据审阅C')
  if(review)reviewCalls++;else parentCalls++
  yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:review?'未完成审阅提交。':'当前实现已完成，请验证。'}]}}
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 }
 await enterDesktopLine({projectId:project.project_id,sessionId:parent,requestId:'interrupted-review',content:'完成原任务',maxTokens:2048,signal:AbortSignal.timeout(90000)},query,{},
 {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
 expect(parentCalls).toBe(1);expect(reviewCalls).toBe(1)
 expect(findProject(project.project_id).status).not.toBe('completed')
 expect(findProject(project.project_id).desktop_blocked?.note).toContain('QUALITY_REVIEW_INTERRUPTED')
},120000)

it('recovers orphaned review records without accepting incomplete findings',async()=>{
 await review([])
 const ledger=readQualityLedger(project.project_id),last=ledger.reviews.at(-1)!
 last.status='submitted';last.delegation='missing-runtime';last.child='old-child'
 writeFileSync(qualityLedgerPath(project.project_id),JSON.stringify(ledger))
 const recovered=createQualityReview(project.project_id,parent,policy)
 expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('interrupted')
 expect((await recovered.completionAction(ctx().signal)).next_tool).toBe('start_quality_review')
})

it.each([false,true])('resumes an unchanged verified candidate through host review without waking the maker (stale receipt=%s)',async stale=>{
 vi.stubEnv('BLOMA_ENGINEERING_PARTNER','1')
 const {enterDesktopLine}=await import('../../../main/desktop/desktop-route'),{findProject}=await import('../../../main/project/project-service')
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 expect((await verifySoftwareCandidate(project.project_id,'prior-request',ctx().signal)).status).toBe('passed')
 if(stale){const verification=await import('../../../main/software/verification');vi.spyOn(verification,'recentSoftwareVerification').mockResolvedValueOnce(undefined)}
 let makerCalls=0,reviewCalls=0
 const query:SDKQuery=async function*(_prompt,options){
  if(!JSON.stringify(options.messages?.filter(m=>m.role==='system')).includes('独立只读代码/数据审阅C')){makerCalls++;throw Error('UNNECESSARY_MAKER_REQUEST')}
  const content=reviewCalls++===0?[{type:'tool_use' as const,id:'materials',name:'read_quality_review',input:{}},{type:'tool_use' as const,id:'source',name:'read_file',input:{path:'app.cjs'}},{type:'tool_use' as const,id:'submit',name:'submit_quality_findings',input:{findings:[],engineering:{status:'supported',evidence:'Read app.cjs: stateless addition and CLI input/output.',limitations:'Fixture'}}}]:[{type:'text' as const,text:'审阅已提交。'}]
  yield{type:'assistant',message:{role:'assistant',content}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 }
 await enterDesktopLine({projectId:project.project_id,sessionId:parent,requestId:'resume-host',content:'继续完成原任务。',maxTokens:2048,signal:AbortSignal.timeout(90000)},query,{},
 {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
 expect(makerCalls).toBe(0);expect(reviewCalls).toBe(1);expect(findProject(project.project_id).status).toBe('completed')
},120000)

it('refuses maker-selected review delegation before buying a child request',()=>{
 let calls=0;register(async function*(){calls++;yield{type:'result',subtype:'success'}})
 expect(()=>startDelegation(ctx(),{task:'自行启动交付审阅',role:'review',readOnly:true})).toThrow('QUALITY_REVIEW_HOST_ONLY')
 expect(calls).toBe(0)
})

it('keeps engineering concerns blocking after business checks pass and requires review of the changed design', async () => {
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(5)')
  await review([], undefined, undefined, {status:'concern',severity:'high',evidence:'app.cjs ignores CLI input and always returns 5, contradicting the documented calculation boundary.',limitations:'Normal-case execution alone cannot establish input handling.'})
  expect((await verifySoftwareCandidate(project.project_id, 'r', ctx().signal)).status).toBe('passed')
  expect(await quality.gate()).toContain('QUALITY_ENGINEERING_UNRESOLVED')
  const previous = readQualityLedger(project.project_id).reviews.at(-1)!
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(Number(process.argv[2]||2)+Number(process.argv[3]||3))')
  expect(await quality.gate()).toContain('QUALITY_REVIEW_REQUIRED')
  await review([])
  expect(await quality.gate()).toBeUndefined()
  expect(readQualityLedger(project.project_id).reviews.find(r => r.id === previous.id)?.engineering?.status).toBe('concern')
  writeFileSync(join(project.root_path, 'ARCHITECTURE.md'), 'Changed contract and ownership')
  expect(await quality.gate()).toContain('QUALITY_REVIEW_REQUIRED')
}, 120000)

it('records an omitted engineering assessment as unverified without invalidating an otherwise valid C review', async () => {
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
  await review([],undefined,undefined,null)
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.engineering?.status).toBe('unverified')
  expect(await quality.gate()).toBeUndefined()
})


it('binding review plus host execution settles a new suspicion but never replaces final C',async()=>{
 const {case_name,...unbound}=finding
 await review([unbound])
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 await verifySoftwareCandidate(project.project_id,'r',ctx().signal)
 const f=readQualityLedger(project.project_id).findings[0]
 expect(f.checks).toHaveLength(0)
 await review([],undefined,[{finding_id:f.id,case_name:'sum',evidence:'Frozen sum executes the exact original inputs and expected output.'}],undefined,'binding')
 expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
 await verifySoftwareCandidate(project.project_id,'r',ctx().signal)
 expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('not_reproduced')
 expect(await quality.gate()).toContain('REVIEW_REQUIRED')
 await review([])
 expect(await quality.gate()).toBeUndefined()
},120000)

it('early coverage may inspect an unready slice but cannot grant candidate qualification',async()=>{
 writeFileSync(join(project.root_path,'unsafe.js'),'document.body.innerHTML = location.hash')
 await review([],undefined,undefined,undefined,'coverage')
 expect(readQualityLedger(project.project_id).reviews.at(-1)?.purpose).toBe('coverage')
 await expect(quality.begin(ctx())).rejects.toThrow('QUALITY_LOCAL_CHECK_REQUIRED')
 expect(await quality.gate()).toContain('REVIEW_REQUIRED')
},60000)

it('permits an additive targeted CLI case while refusing to delete or weaken the frozen original',async()=>{
 const tool=buildLeanCliTool(project.project_id),old={name:'sum',covers:['F-001'],args:['2','3'],stdout:'5',exit_code:0},extra={name:'new',covers:['F-001'],args:['3','4'],stdout:'7',exit_code:0}
 const register=(cases:unknown[])=>tool.execute({expectations:{'F-001':'2加3得5'},cases},ctx())
 expect((await register([old,extra])).isError).not.toBe(true)
 expect((await register([extra])).isError).toBe(true)
 expect((await register([extra,old])).isError).toBe(true)
 expect((await register([{...old,stdout:'999'},extra])).isError).toBe(true)
})

it('reads exact frozen test contracts through review-owned file keys and refuses arbitrary paths',async()=>{
 register(async function*(_prompt,options){
  const read=quality.childProtocol.find(t=>t.name==='read_quality_review')!
  const page=JSON.parse((await read.execute({test_file:'cli'},ctx(options.sessionId))).output)
  expect(JSON.parse(page.text).cases[0]).toMatchObject({name:'sum',args:['2','3'],stdout:'5'})
  expect(page.authority).toBe('frozen_test_input_not_execution_or_current_image')
  await expect(read.execute({test_file:'../foreign'},ctx(options.sessionId))).rejects.toThrow('NOT_OWNED')
  yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'materials',name:'read_quality_review',input:{}},{type:'tool_use',id:'source',name:'read_file',input:{path:'app.cjs'}},{type:'tool_use',id:'submit',name:'submit_quality_findings',input:{findings:[]}}]}}
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 })
 const child=await quality.begin(ctx());await findDelegation(parent,child.delegation_id)!.completion
 expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('complete')
 await expect(quality.childProtocol[0].execute({test_file:'cli'},ctx())).rejects.toThrow('DENIED')
},60000)

it('routes a late current-version partner execution failure to C without promoting prose or replaying the same judgment',async()=>{
 let advice:any
 quality=createQualityReview(project.project_id,parent,policy,undefined,()=>advice)
 await review([]);expect(await quality.gate()).toBeUndefined()
 advice={updates:[{text:'Optional documentation suggestion'}]};expect(await quality.gate()).toBeUndefined()
 const run={input_intact:true,exit_code:1,record_sha256:'a'.repeat(64)}
 advice={updates:[{workspace_facts:{input_intact:true,source_changed:false,target_changed:false,recent_runs:[run]}}]}
 expect(await quality.gate()).toContain('NEW_EXECUTION_REVIEW_REQUIRED')
 expect(await quality.completionAction()).toMatchObject({next_tool:'start_quality_review',purpose:'candidate'})
 await review([])
 expect(readQualityLedger(project.project_id).reviews.at(-1)?.observation?.engineering_failures).toEqual([{record_sha256:run.record_sha256,exit_code:1}])
 expect(await quality.gate()).toBeUndefined()
 advice.updates.push(advice.updates[0]);expect(await quality.gate()).toBeUndefined()
 advice.updates[0].workspace_facts.recent_runs=[{...run,record_sha256:'b'.repeat(64)}]
 expect(await quality.gate()).toContain('NEW_EXECUTION_REVIEW_REQUIRED')
},120000)


it('one current binding review settles several same-case suspicions but cannot close an unbound different trigger or replace final C',async()=>{
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 const {case_name,...unbound}=finding
 await review([unbound,{...unbound,location:'same-trigger second report'},{...unbound,location:'same-trigger third report'},{...unbound,trigger:'network failure then retry',reproduction:'different path not present in sum'}],undefined,undefined,undefined,'coverage')
 let facts=readQualityLedger(project.project_id)
 const ids=facts.findings.map(f=>f.id)
 expect(await quality.completionAction(ctx().signal)).toMatchObject({next_tool:'start_quality_review',purpose:'binding',binding_findings:ids})
 const first=await verifySoftwareCandidate(project.project_id,'r',ctx().signal)
 expect(first.status).toBe('passed');expect(readQualityLedger(project.project_id).findings.every(f=>f.checks.length===0)).toBe(true)
 register(async function*(_prompt,options){
  const packet=JSON.parse((await quality.childProtocol.find(t=>t.name==='read_quality_review')!.execute({},ctx(options.sessionId))).output)
  expect(packet.binding_work).toEqual(ids)
  expect(packet.test_coverage.authority).toContain('错误实现')
  expect(packet.test_coverage.contract_changes).toEqual([])
  const contract=JSON.parse((await quality.childProtocol[0].execute({test_file:'cli'},ctx(options.sessionId))).output)
  expect(JSON.parse(contract.text).cases[0]).toMatchObject({name:'sum',args:['2','3'],stdout:'5'})
  yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'source',name:'read_file',input:{path:'app.cjs'}},{type:'tool_use',id:'submit',name:'submit_quality_findings',input:{findings:[],resolutions:ids.slice(0,3).map(finding_id=>({finding_id,case_name:'sum',evidence:'独立核对：此条触发为2和3，冻结sum保留该输入和预期5；第四条网络路径不覆盖。'}))}}]}}
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 })
 const child=await quality.begin(ctx(),'code',undefined,'binding');await findDelegation(parent,child.delegation_id)!.completion;await settleParentDelegationRuns(parent)
 facts=readQualityLedger(project.project_id)
 expect(facts.reviews.at(-1)?.status).toBe('complete');expect(facts.findings.every(f=>f.checks.length===0)).toBe(true)
 const checked=await verifySoftwareCandidate(project.project_id,'r',ctx().signal)
 expect(checked.candidate?.id).toBe(first.candidate?.id)
 await verifySoftwareCandidate(project.project_id,'r',ctx().signal)
 facts=readQualityLedger(project.project_id)
 expect(facts.findings.map(f=>f.checks.length)).toEqual([1,1,1,0])
 expect(facts.findings.map(f=>f.disposition)).toEqual(['not_reproduced','not_reproduced','not_reproduced','suspected'])
 expect(new Set(facts.findings.slice(0,3).map(f=>f.checks[0].candidate)).size).toBe(1)
 expect(await quality.gate()).toContain('REPRODUCTION_REQUIRED')
 expect(facts.reviews.map(r=>r.purpose)).toEqual(['coverage','binding'])
},120000)
