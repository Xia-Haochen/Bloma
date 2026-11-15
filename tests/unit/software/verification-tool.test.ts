import {withFundedExecutionWindow,configureSoftwareExecutionLimits} from '../../../main/software/execution-limits'
import {leanBudget} from '../../../main/desktop/lean-budget'
import { withEmptyQualityReview } from '../../fixtures/quality-review-query'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../../storage/json-store', async original => {
  const actual = await original<typeof import('../../../storage/json-store')>()
  return { ...actual, writeTextFileAtomic: vi.fn(actual.writeTextFileAtomic) }
})
import { writeTextFileAtomic } from '../../../storage/json-store'
import { findProject } from '../../../main/project/project-service'
import { createEngineeringProject as createProject } from '../../fixtures/engineering-project'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { buildLeanCliTool } from '../../../main/desktop/lean-cli-check'
import { buildSoftwareVerifyTool } from '../../../main/software/verification-tool'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { recentSoftwareVerification, verifySoftwareCandidate } from '../../../main/software/verification'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { frozenGuiFixtureVersion, sealGuiFixtures } from '../../../main/desktop/gui-fixtures'
import { installGuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import {readVerificationReport} from '../../../main/software/verification-report'
import * as capabilityResources from '../../../main/software/capability-resources'
import * as coreVerification from '../../../main/desktop/core-verification'
import * as speechVerification from '../../../main/desktop/speech-verification'

let home: string, old: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-verify-action-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('invalidates old PASS on cancellation, corrupted receipts and receipt write failure', async () => {
  await setup()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  const file = join(home, 'software-verification', project.project_id+'.json'), bytes = readFileSync(file, 'utf8')
  writeFileSync(file, bytes.replace('"result_hash":"', '"result_hash":"bad'))
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  writeFileSync(file, bytes)
  const controller = new AbortController(); controller.abort()
  await expect(verifySoftwareCandidate(project.project_id, 'r', controller.signal, true)).rejects.toThrow()
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  writeFileSync(file, bytes)
  const actual = await vi.importActual<typeof import('../../../storage/json-store')>('../../../storage/json-store')
  vi.mocked(writeTextFileAtomic).mockImplementation((...args) => { if (args[0] === file) throw Error('fixture disk full'); actual.writeTextFileAtomic(...args) })
  try { await expect(verifySoftwareCandidate(project.project_id, 'r', undefined, true)).rejects.toThrow('fixture disk full') }
  finally { vi.mocked(writeTextFileAtomic).mockImplementation(actual.writeTextFileAtomic) }
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
}, 60000)
const ctx = () => ({ projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(90000), state: createToolState() })
async function setup(description='输出5') {
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description, expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const source = `require('fs').appendFileSync(${JSON.stringify(join(home, 'executions.txt'))},${JSON.stringify('run\n')});console.log(5)`
  writeFileSync(join(project.root_path, 'app.cjs'), source); writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  expect((await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] }, ctx())).isError).not.toBe(true)
  return source
}
it('reuses prepared speech evidence across continuation only while inputs and microphone evidence match',async()=>{
  const source=await setup('麦克风输入')
  const root=project.root_path,id=project.project_id
  writeFileSync(join(root,'CORE_CHECK.json'),JSON.stringify({speech:{module:'speech_runtime',factory:'SpeechEngine',method:'transcribe'}}))
  const snapshot=vi.spyOn(capabilityResources,'snapshotSpeechResources').mockResolvedValue({
    provider:'python-sensevoice-v1',root,manifest_sha256:'fixture',
  })
  const resource=vi.spyOn(capabilityResources,'validateSpeechResources').mockResolvedValue()
  const microphone=vi.spyOn(speechVerification,'hasReusableMicrophoneEvidence').mockResolvedValue(true)
  const runCore=vi.spyOn(coreVerification,'runCoreVerification').mockResolvedValue({
    status:'passed',checked_at:new Date().toISOString(),summary:'test fixture',missing:[],evidence:[],
    speech:{status:'passed',probe_version:1},
  })
  try{
    const first=await verifySoftwareCandidate(id,'r')
    expect(first.status,first.summary).toBe('passed')
    expect((await verifySoftwareCandidate(id,'r')).candidate?.id).toBe(first.candidate?.id)
    expect(runCore).toHaveBeenCalledTimes(1)
    expect(microphone).toHaveBeenCalledTimes(1)
    expect((await recentSoftwareVerification(id,'new-request'))?.candidate?.id).toBe(first.candidate?.id)
    expect(runCore).toHaveBeenCalledTimes(1)
    microphone.mockResolvedValueOnce(false)
    expect(await recentSoftwareVerification(id,'r')).toBeUndefined()
    resource.mockRejectedValueOnce(Error('SPEECH_RESOURCE_BYTES_CHANGED'))
    expect(await recentSoftwareVerification(id,'new-request')).toBeUndefined()
    writeFileSync(join(root,'app.cjs'),source+'\n// changed')
    expect(await recentSoftwareVerification(id,'r')).toBeUndefined()
  }finally{runCore.mockRestore();microphone.mockRestore();resource.mockRestore();snapshot.mockRestore()}
},60000)
it('reports formal failures before asking any coverage reviewer to inspect the suite',async()=>{
  const source=await setup()
  const id=project.project_id,root=project.root_path
  writeFileSync(join(root,'app.cjs'),source.replace('console.log(5)','console.log(999)'))
  const stageCoverage=vi.fn(async()=>{})
  const tools=buildSoftwareAgentTools(id,'parent',createSoftwareCollaborationPolicy(id,root,'s'),
    undefined,undefined,undefined,undefined,stageCoverage)
  const result=await tools.find(tool=>tool.name==='verify_app')!.execute({},ctx())
  expect(JSON.parse(result.output)).toMatchObject({status:'failed',evidence:{counts:{failed:1}}})
  expect(stageCoverage).not.toHaveBeenCalled()
},60000)
it('runs real checks from a parent action and reuses them at final delivery only for unchanged inputs in the same request', async () => {
  await setup(); const tool = buildSoftwareVerifyTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's'))
  const first = await tool.execute({}, ctx()); expect(first.isError, first.output).not.toBe(true)
  expect(JSON.parse(first.output).evidence).toMatchObject({freshness:'current_observation',input_identity:{source:expect.stringMatching(/^[a-f0-9]{64}$/),scope:expect.stringMatching(/^[a-f0-9]{64}$/),rules:expect.stringMatching(/^[a-f0-9]{64}$/),environment:expect.stringMatching(/^[a-f0-9]{64}$/),request_id:'r'}})
  const count = () => readFileSync(join(home, 'executions.txt'), 'utf8').split('run\n').length - 1
  expect(count()).toBe(2)
  const reused=JSON.parse((await tool.execute({},ctx())).output)
  expect(reused.reused).toBe(true);expect(count()).toBe(2)
  expect(reused.evidence.report_hash).toBe(JSON.parse(first.output).evidence.report_hash)
  expect(()=>readVerificationReport(project.project_id,{report_hash:reused.evidence.report_hash})).not.toThrow()
  expect((await recentSoftwareVerification(project.project_id, 'another-request'))?.reused).toBe(true)
  const cached = await recentSoftwareVerification(project.project_id, 'r'); expect(cached?.core?.reused).toBe(true)
  const query: SDKQuery = async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '当前版本已验证，请交付。' }] } }; yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } } }
  const diagnostic = process.env.VERIFY_CLOSEOUT_REPORT, started = performance.now(), events: unknown[] = []
  const capture = (kind: string, value: unknown) => { if (diagnostic && events.length < 256) events.push({ms:performance.now()-started,kind,value:JSON.stringify(value)?.slice(0,2000)}) }
  const profiler = diagnostic ? new (await import('node:inspector')).Session() : undefined
  const post = (method:string) => new Promise<any>((resolve,reject)=>profiler!.post(method,(error,result)=>error?reject(error):resolve(result)))
  if(profiler){profiler.connect();await post('Profiler.enable');await post('Profiler.start')}
  try {
    await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '完成原任务', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(query), {},
      { publish: (...args) => capture('publish',args), persistAssistant: (...args) => capture('assistant',args), persistSystem: (...args) => capture('system',args), complete: (...args) => capture('complete',args) })
  } finally {
    if(diagnostic){writeFileSync(diagnostic,JSON.stringify({elapsed_ms:performance.now()-started,project:findProject(project.project_id),events},null,2))}
    if(profiler){try{const result=await post('Profiler.stop');writeFileSync(diagnostic+'.cpuprofile',JSON.stringify(result.profile))}finally{profiler.disconnect()}}
  }
  expect(findProject(project.project_id).status).toBe('completed'); expect(count()).toBe(2)
}, 120000)
it('invalidates source changes and never revives an older PASS when a failed version is restored', async () => {
  const source = await setup(); expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  writeFileSync(join(project.root_path, 'app.cjs'), source.replace('console.log(5)', 'console.log(999)'))
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('failed')
  writeFileSync(join(project.root_path, 'app.cjs'), source)
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
}, 60000)
it('a controlled agent repairs a real CLI failure using the compact response then lets the host deliver',async()=>{
  const source=await setup();writeFileSync(join(project.root_path,'app.cjs'),source.replace('console.log(5)','console.log(999)'))
  let calls=0
  const query:SDKQuery=async function* (_prompt,options){
    const turn=++calls
    if(turn===2){const history=JSON.stringify(options.messages);expect(history).toContain('999');expect(history).toContain('next_action');expect(history).toContain('product_assertion')}
    if(turn>4)throw Error('unexpected additional production call')
    yield {type:'assistant',message:{role:'assistant',content:turn===2
      ? [{type:'tool_use',id:'source',name:'read_file',input:{path:'app.cjs'}},{type:'tool_use',id:'expected',name:'read_production_context',input:{topic:'features',feature_ids:['F-001']}}]
      : [{type:'tool_use',id:'action-'+turn,name:turn===3?'write_file':'verify_app',input:turn===3?{path:'app.cjs',content:source}:{}}]}}
    yield {type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'r',content:'完成输出5并检查实际结果',maxTokens:4096,signal:AbortSignal.timeout(90000)},withEmptyQualityReview(query),{},
    {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  expect(calls).toBe(4);expect(findProject(project.project_id).status).toBe('completed')
},120000)
it('binds actual frozen fixture bytes and rejects tampering before a cached PASS can be consumed', async () => {
  await setup(); writeFileSync(join(project.root_path, 'input.txt'), 'owned fixture')
  const suite = sealGuiFixtures(project.project_id, project.root_path, { version: 1, scope_hash: prdScopeFingerprint(readPrdBackplane(project.project_id)), covers: ['F-001'], fixtures: [{ path: 'input/file.txt', source: 'input.txt' }], steps: [{ id: 'text', kind: 'expect', selector: 'body', nonempty: true }] })
  installGuiAcceptanceSuite(project.project_id, suite)
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  const file = join(home, 'gui-acceptance-fixtures', project.project_id, suite.scope_hash, `${suite.fixtures![0].sha256}.bin`)
  writeFileSync(file, 'corrupted fixture')
  expect(() => frozenGuiFixtureVersion(project.project_id, suite)).toThrow('FROZEN_BYTES_CHANGED')
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).not.toBe('passed')
}, 60000)
it('invalidates an earlier tool PASS when final delivery checks fail, even after the source is restored', async () => {
  const source = await setup()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  writeFileSync(join(project.root_path, 'app.cjs'), source.replace('console.log(5)', 'console.log(999)'))
  let queries = 0
  const query: SDKQuery = async function* () {
    if (++queries > 1) throw Error('fixture-stop-after-observed-failure')
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '请执行实际收口检查。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '完成原任务', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(query), {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(queries).toBe(2)
  expect(findProject(project.project_id).status).not.toBe('completed')
  const receipt = JSON.parse(readFileSync(join(home, 'software-verification', `${project.project_id}.json`), 'utf8'))
  expect(receipt.result.status).toBe('failed')
  writeFileSync(join(project.root_path, 'app.cjs'), source)
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
}, 120000)

it('normal production aligns an admitted outer window without clearing old request counts',async()=>{
 await setup()
 configureSoftwareExecutionLimits(project.project_id,findProject(project.project_id).lean_operation_id!,{requests:16,output:4096,reason:'Fixture starts below platform capacity so an admitted window can extend it'})
 const budget=leanBudget(project.project_id,'desktop-implement');budget.recordRuntime(0);const snapshot=budget.snapshot()
 writeFileSync(snapshot.file,JSON.stringify({version:1,requests:snapshot.limits.requests,output:0,phases:{}}))
 const query:SDKQuery=async function*(){yield {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'完成原目标。'}]}};yield {type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}}
 await withFundedExecutionWindow(()=>({remainingRequests:8,remainingRmb:1,outputRmbPerMillion:8}),()=>enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'funded',content:'完成原任务',maxTokens:4096,signal:AbortSignal.timeout(90000)},withEmptyQualityReview(query),{},
 {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}}))
 const final=leanBudget(project.project_id,'desktop-implement').snapshot()
 expect(final.requests).toBeGreaterThan(snapshot.limits.requests);expect(final.limits.requests).toBe(snapshot.limits.requests+8)
 expect(findProject(project.project_id).status).toBe('completed')
},120000)
