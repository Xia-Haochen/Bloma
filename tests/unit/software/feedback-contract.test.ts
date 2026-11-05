import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {verificationFailure} from '../../../main/software/verification-diagnostics'
import {verificationReportView,readVerificationReport,verificationToolFeedback,verificationResponse,verificationCases} from '../../../main/software/verification-report'
import {observedQualityFinding} from '../../../main/software/quality-closeout'
import {NativeTestContractError} from '../../../main/software/native-gui-tests'
import type {SoftwareVerification} from '../../../main/software/verification'
import {toolRecovery,persistentBudgetBlocked} from '../../../shared/tool-feedback-policy'
import {safeToolFeedback,toolFeedbackLabel,type ToolFeedback} from '../../../shared/tool-feedback'
import {createProject} from '../../../main/project/project-service'
import {buildProductionContextTool} from '../../../main/desktop/production-context'
import {createToolState} from '../../../main/agent/loop/agent-loop'

let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'feedback-contract-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true})})
const result=(value:unknown)=>value as SoftwareVerification
it('routes a frozen-contract refusal directly to its readable original without implying execution or PASS',()=>{
  const native={layout:'project',entry:'tests/a.mjs',directory:'tests',digest:'a'.repeat(64)} as any
  const error=new NativeTestContractError(['tests/a.mjs'],native)
  const view=verificationFailure(result({status:'unverified',summary:error.message}),error)
  expect(view?.next_action).toEqual({tool:'read_test_contract',arguments:{contract_digest:native.digest,file:'tests/a.mjs'}})
  expect(view?.next).toContain('不依赖测试成功执行')
})
function receipt(id:string,r:SoftwareVerification){
  mkdirSync(join(home,'software-verification'),{recursive:true})
  const hash=createHash('sha256').update(JSON.stringify(r)).digest('hex')
  writeFileSync(join(home,'software-verification',id+'.json'),JSON.stringify({version:1,state:'complete',at:1,result:r,result_hash:hash}));return hash
}
it('does not turn a generic failure or static rule hit into a confirmed business root cause',()=>{
  const unknown=result({status:'failed',summary:'something failed'})
  expect(verificationFailure(unknown)).toMatchObject({category:'unknown',diagnosis:{certainty:'unknown',root_cause_confirmed:false}})
  expect(toolRecovery(verificationToolFeedback(unknown))).toBe('inspect')
  const security=result({status:'failed',summary:'rule hit',security:{issues:[{severity:'high',category:'unsafe_dom'}]}})
  expect(verificationFailure(security)).toMatchObject({category:'security_policy',diagnosis:{basis:'static_policy',root_cause_confirmed:false}})
  expect(toolRecovery(verificationToolFeedback(security))).toBe('inspect')
})
it('uses the same actual failed phase in both case reports and defect closure',()=>{
  const r=result({status:'failed',summary:'reopen failed',core:{host_gui:{method:'node:test',case_results:[{name:'F-001 saved',feature:'F-001',status:'failed',assertions:1}],steps:[
    {passed:true,actual:{test:'F-001 saved'}},{passed:false,actual:{test:'F-001 saved',assertion:{expected:'saved',actual:'missing'}}}]}}})
  expect(verificationCases(r)[0]).toMatchObject({expected:'saved',actual:'missing'})
  expect(observedQualityFinding(r,{requirement:'F-001'} as never,'F-001 saved')).toBe('failed')
})
it('diagnoses B runtime evidence consistently and does not borrow an earlier adapter diagnostic',()=>{
  const r=result({status:'failed',summary:'B failed',independent:{status:'failed',diagnostic:{id:'adapter-0',expected:'old expectation',actual:'bad selector'},case_results:[
    {id:'adapter',status:'unverified',kind:'adapter',steps:[]},
    {id:'save',status:'failed',kind:'product_runtime',expected_source:'保存',error:'save crashed',steps:[{id:'save-1',passed:false,actual:'save crashed'}]}]}})
  expect(verificationFailure(r)).toMatchObject({classification_basis:'host_runtime',category:'product_assertion',step:'save-1',actual:'save crashed'})
  expect(verificationToolFeedback(r)).toMatchObject({category:'product_assertion',verification:'failed'})
})
it('returns one compact actionable response and leaves the full bound report readable',()=>{
  const project=createProject({request_id:'compact',mode:'quick'},{workflowVersion:'software-v1'})
  const r=result({status:'failed',summary:'bad output',core:{host_cli:{cases:Array.from({length:20},(_,i)=>({name:'case'+i,covers:['F-001'],passed:false,exit_code:0,actual:'999',expected:{stdout:'5',exit_code:0}}))}}})
  receipt(project.project_id,r)
  const response=verificationResponse(project.project_id,r)
  expect(response.evidence.cases).toHaveLength(4);expect(response.evidence.omitted).toBe(16)
  expect(response.failure).toMatchObject({category:'product_assertion',actual:{stdout:'999'}})
  expect(response.evidence).not.toHaveProperty('failure');expect(response).not.toHaveProperty('failed_step')
  expect(readVerificationReport(project.project_id,{report_hash:response.evidence.report_hash})).toHaveProperty('case_count',20)
  expect(verificationResponse(project.project_id,{status:'passed',summary:'ok'},false).next).toContain('可以结束制作')
  const error=new NativeTestContractError(['tests/acceptance.mjs'])
  expect(verificationResponse(project.project_id,{status:'unverified',summary:error.message},false,error).failure?.paths).toEqual(['tests/acceptance.mjs'])
})
it('uses stable host failure identities across transient report paths, while keeping different assertions distinct',()=>{
  const incomplete=(path:string)=>result({status:'unverified',summary:'GUI_NATIVE_EXECUTION_INCOMPLETE',core:{host_gui:{failure_kind:'incomplete',steps:[{id:'native-1',passed:false,actual:{test:'F-001',error:path}}]}}})
  expect(verificationToolFeedback(incomplete('temporary-A/trace')).fingerprint).toBe(verificationToolFeedback(incomplete('temporary-B/trace')).fingerprint)
  const assertion=(actual:number)=>result({status:'failed',summary:'failed',core:{host_gui:{failure_kind:'assertion',steps:[{id:'native-1',passed:false,actual:{assertion:{expected:4,actual}}}]}}})
  expect(verificationToolFeedback(assertion(2)).fingerprint).not.toBe(verificationToolFeedback(assertion(3)).fingerprint)
})
it('preserves assertion facts but asks to inspect expectations; disputed expectations do not authorize product repair',()=>{
  const assertion=result({status:'failed',summary:'failed',core:{host_cli:{cases:[{name:'rounding',passed:false,exit_code:0,expected:{stdout:'4',exit_code:0},actual:'5'}]}}})
  expect(verificationFailure(assertion)).toMatchObject({category:'product_assertion',observation:{expected:{stdout:'4',exit_code:0},actual:{stdout:'5'}},diagnosis:{certainty:'supported',root_cause_confirmed:false}})
  expect(toolRecovery(verificationToolFeedback(assertion))).toBe('inspect')
  const disputed=result({status:'unverified',summary:'different assumptions',independent:{semantics:{ready:false}}})
  expect(verificationFailure(disputed)?.next_action).toEqual({tool:'read_production_context',arguments:{topic:'independent-design'}})
  expect(toolRecovery(verificationToolFeedback(disputed))).toBe('inspect')
  expect(toolRecovery(verificationToolFeedback(result({status:'environment_blocked',summary:'runtime unavailable'})))).toBe('prepare_environment')
})
it('prioritizes the late CLI failure, includes unexecuted GUI cases and provides pinned access to long evidence',async()=>{
  const project=createProject({request_id:'new',mode:'quick'},{workflowVersion:'software-v1'})
  const r=result({status:'failed',summary:'late CLI failure',core:{host_cli:{cases:Array.from({length:30},(_,i)=>({name:'case-'+i,covers:['F-001'],passed:i!==28,exit_code:0,expected:{stdout:'expected',exit_code:0},actual:i===28?'PREFIX'+('x'.repeat(9000))+'TAIL_EVIDENCE':'ok'}))},host_gui:{case_results:[{name:'not executed',feature:'F-002',status:'not_run'}],steps:[]}}})
  const hash=receipt(project.project_id,r),view=verificationReportView(r)
  expect(()=>readVerificationReport(project.project_id,{offset:8})).toThrow('HASH_REQUIRED')
  expect(view.cases.some(row=>row.name==='case-28')).toBe(true)
  expect(view.cases.some(row=>row.status==='not_run')).toBe(true)
  expect(view.counts).toEqual({failed:1,unverified:1,passed:29})
  expect(view.pagination.omitted).toBe(23)
  expect(view.observation?.actual).toMatchObject({truncated:true,read_more:{arguments:{section:'raw'}}})
  const tool=buildProductionContextTool(project.project_id),ctx={projectId:project.project_id,sessionId:'s',requestId:'r',state:createToolState(),signal:new AbortController().signal}
  let offset=0,text=''
  for(;;){const row=JSON.parse((await tool.execute({topic:'verification-report',section:'raw',offset,report_hash:hash},ctx)).output);text+=row.text;if(!row.next)break;offset=row.next.arguments.offset}
  expect(text).toContain('TAIL_EVIDENCE');expect(()=>JSON.parse(text)).not.toThrow()
  expect(readVerificationReport(project.project_id)).toMatchObject({freshness:'historical_not_revalidated',usable_for_delivery:false})
  receipt(project.project_id,{status:'passed',summary:'new candidate'})
  expect(()=>readVerificationReport(project.project_id,{report_hash:hash,offset:8})).toThrow('REPORT_CHANGED')
  expect((await tool.execute({topic:'verification-report'},{...ctx,projectId:'foreign'})).isError).toBe(true)
})
it('distinguishes budget admissions without weakening a persistent cap',()=>{
  const base:ToolFeedback={schema_version:1,execution:'not_run',verification:'unverified',category:'budget',budget:{resource:'money',scope:'experiment',used:8,limit:10,remaining:2,resets_on:'none'}}
  expect(toolFeedbackLabel(base)).toBe('额度保护未放行')
  const insufficient=safeToolFeedback({...base,budget_admission:'reservation_insufficient'})!
  expect(toolFeedbackLabel(insufficient)).toBe('本次请求预留不足');expect(persistentBudgetBlocked([insufficient])).toBe(true)
  expect(toolFeedbackLabel({...base,budget_admission:'waiting_reservation'})).toBe('等待额度预留结算')
  expect(toolRecovery({...base,budget_admission:'waiting_reservation'})).toBe('inspect')
})
it('distinguishes absent, in-flight and corrupt reports instead of falling back to an old success',()=>{
  expect(()=>readVerificationReport('p')).toThrow('NOT_FOUND')
  mkdirSync(join(home,'software-verification'))
  const path=join(home,'software-verification/p.json')
  writeFileSync(path,JSON.stringify({version:1,state:'running'}))
  expect(()=>readVerificationReport('p')).toThrow('RUNNING')
  for(const text of ['{broken','null','[]','{}']){writeFileSync(path,text);expect(()=>readVerificationReport('p')).toThrow('INVALID')}
})
