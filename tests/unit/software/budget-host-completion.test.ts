import {readQualityLedger} from '../../../main/software/quality-ledger'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { findProject } from '../../../main/project/project-service'
import { createEngineeringProject as createProject } from '../../fixtures/engineering-project'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { MonetaryBudgetError } from '../../../main/platform/llm/monetary-budget'
import { debugWorkspace } from '../../../main/software/debug-workspace'
import { softwareVerificationFingerprint } from '../../../main/desktop/verification-fingerprint'
import { buildLeanCliTool } from '../../../main/desktop/lean-cli-check'
import { createToolState } from '../../../main/agent/loop/agent-loop'
const advisory = vi.hoisted(()=>({enabled:false}))
vi.mock('../../../main/software/engineering-partner',async original=>{
  const actual=await original<typeof import('../../../main/software/engineering-partner')>()
  return {...actual,createEngineeringPartner:(...args:Parameters<typeof actual.createEngineeringPartner>)=>{
    const partner=actual.createEngineeringPartner(...args)
    return {...partner,take:(ctx:Parameters<typeof partner.take>[0])=>advisory.enabled?'Optional documentation suggestion':partner.take(ctx),isObserving:()=>advisory.enabled||partner.isObserving()}
  }}
})

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-budget-host-')); process.env.PROMA_HOME = home })
afterEach(() => {vi.unstubAllEnvs(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it.each([{rules:true,content:'继续',passed:true},{rules:false,content:'继续',passed:false},{rules:true,content:'新增导出功能',passed:false}])('checks registered work before an impossible request, without losing new intent ($rules/$content)',async({rules,content,passed})=>{
  const project=createProject({request_id:'create',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'Print 5',ui:'none',delivery:'command',requirements:[{description:'输出5',expected:'输出5'}]}),
    {projectId:project.project_id,sessionId:'s',source:'输出5',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)');writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,command:['node','app.cjs'],mode:'command'}))
  if(rules)expect((await buildLeanCliTool(project.project_id).execute({expectations:{'F-001':'输出5'},cases:[{name:'five',covers:['F-001'],args:[],stdout:'5',exit_code:0}]},
    {projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(10000),state:createToolState()})).isError).not.toBe(true)
  const policy=join(home,'policy.json');writeFileSync(policy,JSON.stringify({version:1,models:[{host:'test.invalid',model:'M1',cap_rmb:1,context_tokens:1048576,input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:.04}]}))
  vi.stubEnv('BLOMA_MONETARY_POLICY',policy);let calls=0
  const query:SDKQuery=async function*(){calls++;throw Error('The host should not call this model')}
  await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'r',content,signal:AbortSignal.timeout(60000),maxTokens:8192},query,
    {ANTHROPIC_BASE_URL:'https://test.invalid',ANTHROPIC_MODEL:'M1'},{publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  expect(calls).toBe(0);expect(findProject(project.project_id).status==='completed').toBe(false)
  if (passed) expect(findProject(project.project_id).desktop_blocked?.note).toContain('QUALITY_REVIEW_REQUIRED')
  expect(existsSync(policy+'.state.json')).toBe(false)
},90000)
it.each([{ output: 5, rules: true, cancel: false, passed: true }, { output: 999, rules: true, cancel: false, passed: false },
  { output: 5, rules: false, cancel: false, passed: false }, { output: 5, rules: true, cancel: true, passed: false }].flatMap(row => [{ ...row, monetary: false }, { ...row, monetary: true }]))('runs host checks after admission stops, without manufacturing PASS or overruling cancellation ($passed/$output/$rules/$cancel/$monetary)', async ({ output, rules, cancel, passed, monetary }) => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }), controller = new AbortController()
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description: '输出5', expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  let calls = 0
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
  const query: SDKQuery = async function* () {
    if (++calls > 1) {
      if (cancel) controller.abort()
      if (monetary && !rules) {
        // A previous host observation and a later file change are distinct.
        // This fixture does not claim a real GUI run or business PASS.
        writeFileSync(join(debugWorkspace(project.project_id, 's'), 'checkpoint.json'), JSON.stringify({
          id: '00000000-0000-0000-0000-000000000001', projectId: project.project_id, sessionId: 's', version: 1,
          state: 'closed', source: softwareVerificationFingerprint(project.root_path),
        }))
        writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(5) // later unobserved edit')
      }
      throw monetary ? new MonetaryBudgetError('MONETARY_BUDGET_EXHAUSTED', { cap_rmb: 3, accounted_upper_rmb: .841395,
        reported_upper_rmb: .841395, unresolved_reserve_rmb: 0, next_request_reserve_rmb: 2.162688, remaining_rmb: 2.158605, shortfall_rmb: .004083 })
        : Error('REQUEST_BUDGET_EXHAUSTED')
    }
    yield { type: 'assistant', message: { role: 'assistant', content: [use('app', 'write_file', { path: 'app.cjs', content: `console.log(${output})` }),
      use('launch', 'write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, command: ['node', 'app.cjs'], mode: 'command' }) }),
      ...(rules ? [use('check', 'register_cli_check', { expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] })] : [])] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '实现输出5', signal: controller.signal, maxTokens: 4096 }, query, {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(calls).toBe(2); expect(findProject(project.project_id).status === 'completed').toBe(false)
  expect(Boolean(await activeSoftwareRelease(project.project_id))).toBe(false)
  if (passed) expect(findProject(project.project_id).desktop_blocked?.note).toContain('QUALITY_REVIEW_REQUIRED')
  if (cancel) expect(existsSync(join(project.root_path, '00_VERIFY/launch-smoke.json'))).toBe(false)
  if (monetary && !rules) expect(findProject(project.project_id).desktop_blocked?.note).toContain('上次宿主观察之后的修改')
}, 60000)

it('hands a verified candidate to C despite continuously available optional advice, without another maker request',async()=>{
 const project=createProject({request_id:'create',mode:'quick'},{workflowVersion:'software-v1'})
 const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'Print 5',ui:'none',delivery:'command',requirements:[{description:'输出5',expected:'输出5'}]}),{projectId:project.project_id,sessionId:'s',source:'输出5',previous:readPrdBackplane(project.project_id),software:true})!
 if(parsed.action!=='brief')throw Error('fixture')
 syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 writeFileSync(join(project.root_path,'ARCHITECTURE.md'),'Single CLI prints five. No persistence or shared resources. Normal entry tested.')
 writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,command:['node','app.cjs'],mode:'command'}))
 await buildLeanCliTool(project.project_id).execute({expectations:{'F-001':'输出5'},cases:[{name:'five',covers:['F-001'],args:[],stdout:'5',exit_code:0}]},{projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(10000),state:createToolState()})
 let maker=0,review=0
 const use=(id:string,name:string,input:Record<string,unknown>)=>({type:'tool_use' as const,id,name,input})
 const query:SDKQuery=async function*(_prompt,options){
  const isMaker=options.sessionId==='s'
  if(isMaker&&++maker>1)throw Error('OPTIONAL_ADVICE_STARVED_CLOSEOUT')
  if(!isMaker)review++
  yield{type:'assistant',message:{role:'assistant',content:isMaker?[use('verify','verify_app',{})]:[use('materials','read_quality_review',{}),use('source','read_file',{path:'app.cjs'}),use('submit','submit_quality_findings',{findings:[],engineering:{status:'supported',evidence:'Single CLI, no state or resources.',limitations:'CLI fixture only'}})]}}
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 }
 advisory.enabled=true
 try{
  await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'r',content:'实现输出5',signal:AbortSignal.timeout(90000),maxTokens:4096},query,{}, {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  expect(maker).toBe(1);expect(review).toBe(1)
  expect(findProject(project.project_id).desktop_phase,findProject(project.project_id).desktop_blocked?.note).toBe('delivered')
  expect(await activeSoftwareRelease(project.project_id)).toBeTruthy()
 }finally{advisory.enabled=false}
},120000)


it('closes a new unbound suspicion through ordinary maker tools, independent binding, execution and final C',async()=>{
 const project=createProject({request_id:'create',mode:'quick'},{workflowVersion:'software-v1'})
 const expected='返回两个输入数之和'
 const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'求和',ui:'none',delivery:'command',requirements:[{description:'两个数求和',expected}]}),{projectId:project.project_id,sessionId:'s',source:'求和',previous:readPrdBackplane(project.project_id),software:true})!
 if(parsed.action!=='brief')throw Error('fixture')
 syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
 writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)')
 writeFileSync(join(project.root_path,'ARCHITECTURE.md'),'CLI owns numeric parsing and sum output. No shared state or persistence.')
 writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,command:['node','app.cjs'],mode:'command'}))
 const cases=[{name:'sum',covers:['F-001'],args:['2','3'],stdout:'5',exit_code:0}]
 await buildLeanCliTool(project.project_id).execute({expectations:{'F-001':expected},cases},{projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(10000),state:createToolState()})
 let maker=0,reviews=0
 const use=(id:string,name:string,input:Record<string,unknown>)=>({type:'tool_use' as const,id,name,input})
 const query:SDKQuery=async function*(_prompt,options){
  let content
  if(options.sessionId==='s'){
   maker++
   if(maker===1||maker===3)content=[use('verify'+maker,'verify_app',{})]
   else if(maker===2)content=[use('read-before-fix','read_file',{path:'app.cjs'}),use('fix','edit_file',{path:'app.cjs',old_string:'console.log(5)',new_string:'console.log(Number(process.argv[2])+Number(process.argv[3]))'}),use('cases','register_cli_check',{expectations:{'F-001':expected},cases:[...cases,{name:'other-inputs',covers:['F-001'],args:['3','4'],stdout:'7',exit_code:0}]})]
   else {console.info('UNEXPECTED_MAKER_CONTEXT',JSON.stringify(options.messages?.slice(-3)).slice(-10000));console.info('CHAIN_LEDGER',JSON.stringify(readQualityLedger(project.project_id)).slice(-6000));throw Error('UNEXPECTED_MAKER_REQUEST')}
  }else{
   reviews++
   const finding=readQualityLedger(project.project_id).findings[0]
   content=[use('materials'+reviews,'read_quality_review',{}),use('source'+reviews,'read_file',{path:'app.cjs'}),use('submit'+reviews,'submit_quality_findings',{findings:reviews===1?[{requirement:'F-001',expected_source:expected,category:'data',severity:'high',location:'app.cjs',trigger:'输入3和4',evidence:'实现固定输出5',reproduction:'正常CLI入口传3和4，预期7',unknowns:'该输入未执行',kind:'suspected'}]:[],...(reviews===2?{resolutions:[{finding_id:finding.id,case_name:'other-inputs',evidence:'独立核对已登记other-inputs传3和4并断言7，保留原sum。'}]}:{}),engineering:{status:'supported',evidence:'CLI parsing and output have one owner.',limitations:'CLI only'}})]
  }
  yield{type:'assistant',message:{role:'assistant',content}}
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 }
 advisory.enabled=true
 try{
  await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'r',content:'实现求和',signal:AbortSignal.timeout(180000),maxTokens:4096},query,{}, {publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  const ledger=readQualityLedger(project.project_id)
  expect(maker).toBe(3);expect(reviews).toBe(3)
  expect(ledger.findings[0].disposition).toBe('not_reproduced')
  expect(ledger.findings[0].checks.at(-1)).toMatchObject({grounded:true,outcome:'passed',case_name:'other-inputs'})
  expect(ledger.reviews.map(r=>r.purpose)).toEqual(['candidate','binding','candidate'])
  expect(findProject(project.project_id).desktop_phase,findProject(project.project_id).desktop_blocked?.note).toBe('delivered')
  expect(await activeSoftwareRelease(project.project_id)).toBeTruthy()
 }finally{advisory.enabled=false}
},210000)
