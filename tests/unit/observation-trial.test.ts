import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {userTrialBoundary,claimObservationRun,assertFrozenObservation,observeOneTurn,observationOutcome,requireObservationPhase,readObservationQuote,observationHash,observationBalance} from '../../scripts/observation-control'
import {createProject,findProject} from '../../main/project/project-service'
import {readPrdBackplane} from '../../main/project/prd-store'
import {handleGuideMessage} from '../../main/guide/stages/guide-pipeline'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'
import type {AgentEvent} from '../../shared/types'
let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'observation-trial-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true})})

it('rehydrates an unanswered decision after a silent return instead of trying to launch nonexistent software',()=>{
  const project={project_id:'p',status:'active',current_stage:'blocked_for_user_decision'}
  const pending={payload:{kind:'ux_confirm',summary:'当前草图',questions:[{id:'choice',label:'开始制作'}]},preview_url:'bloma-file://p/00_UX/ux-sketch.html'}
  expect(userTrialBoundary({project,sessionId:'s',pending})).toMatchObject({card:{payload:pending.payload},previewUrl:pending.preview_url})
  expect(userTrialBoundary({project,sessionId:'s'}).failed).toContain('尚未到达')
  expect(userTrialBoundary({project:{...project,current_stage:'generating_mvp',desktop_phase:'desktop-implement'},sessionId:'s'}).failed).toBeTruthy()
  expect(userTrialBoundary({project:{...project,status:'completed',current_stage:'completed',desktop_phase:'delivered',software_release_id:'release'},sessionId:'s'})).toEqual({})
  expect(userTrialBoundary({project,sessionId:'s',publicText:'请补充用途'}).card?.payload).toMatchObject({kind:'conversation',summary:'请补充用途'})
})

it('real guide stores the generated scope and returns to the user without a confirmation or second request',async()=>{
  const project=createProject({request_id:'new',mode:'quick'},{workflowVersion:'software-v1'})
  let requests=0;const events:AgentEvent[]=[]
  const query:SDKQuery=async function*(){requests++;yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({intent_assessment:{mode:'direct',reason:'simple local records',source_ids:['S-001']},action:'brief',name:'记录',goal:'保存记录',ui:'required',requirements:[{description:'保存记录',expected:'重开后仍保留'}],constraints:['本机'],out_of_scope:[],assumptions:[]})}]}};yield{type:'result',subtype:'success'}}
  const controller=new AbortController()
  const result=await observeOneTurn(emit=>handleGuideMessage({project_id:project.project_id,session_id:'s',request_id:'r',mode:'quick',current_stage:'clarifying',content:'保存记录，重开后还在'},emit,{query,env:{},signal:controller.signal,sessionId:'s',history:[],maxTokens:8192,persistAssistant:()=>{}}),e=>events.push(e),controller.signal)
  expect(result.status).toBe('awaiting_user');expect(result.decisions[0].payload.kind).toBe('lean_scope')
  expect(requests).toBe(1);expect(readPrdBackplane(project.project_id).user_confirmed_at).toBeUndefined()
  expect(findProject(project.project_id).desktop_phase).toBeUndefined()
})
it('records repeated failures without pausing, adding a message, or invoking the producer again',async()=>{
  const controller=new AbortController(),events:AgentEvent[]=[],dispatch=vi.fn(async(record:(e:AgentEvent)=>void)=>{
    for(let i=0;i<6;i++)record({event_id:String(i),session_id:'s',created_at:new Date().toISOString(),type:'tool_call_completed',payload:{tool:'verify_app',is_error:true,output_summary:'GUI_NATIVE_FAILED'}} as AgentEvent)
    throw Error('original failure')
  })
  const result=await observeOneTurn(dispatch,e=>events.push(e),controller.signal)
  expect(result).toMatchObject({status:'failed',error:'Error: original failure'});expect(dispatch).toHaveBeenCalledTimes(1)
  expect(events).toHaveLength(6);expect(controller.signal.aborted).toBe(false);expect(existsSync(join(home,'pause-generation'))).toBe(false)
})
it('stops before dispatch on cancellation and preserves a timeout rather than retrying',async()=>{
  const controller=new AbortController();controller.abort(new Error('deadline'))
  const dispatch=vi.fn();expect((await observeOneTurn(dispatch,()=>{},controller.signal)).status).toBe('stopped');expect(dispatch).not.toHaveBeenCalled()
})
it('does not call a returned turn delivered without all persisted delivery facts',()=>{
  expect(observationOutcome({status:'returned'},{status:'completed',current_stage:'completed'},'release')).toBe('incomplete')
  expect(observationOutcome({status:'awaiting_user'},{status:'completed',current_stage:'completed',desktop_phase:'delivered'},'release')).toBe('awaiting_user')
  expect(observationOutcome({status:'returned'},{status:'completed',current_stage:'completed',desktop_phase:'delivered'},'release')).toBe('released_pending_independent_acceptance')
})
it('claims the attempt exclusively and refuses changed runtime, templates, thinking and every old intervention phase',()=>{
  writeFileSync(join(home,'manifest.json'),JSON.stringify({runtime_sha256:'code',runtime_tree_sha256:'templates',thinking:'low'}))
  assertFrozenObservation(home,'code','low','templates')
  for(const args of [['changed','low','templates'],['code','off','templates'],['code','low','changed']])expect(()=>assertFrozenObservation(home,...args as [string,string,string])).toThrow('CONFIGURATION_CHANGED')
  claimObservationRun(home,{request:'one'});const bytes=readFileSync(join(home,'run-claimed.json'),'utf8')
  expect(()=>claimObservationRun(home,{request:'two'})).toThrow();expect(readFileSync(join(home,'run-claimed.json'),'utf8')).toBe(bytes)
  expect(()=>assertFrozenObservation(home,'code','low','templates')).toThrow('ALREADY_ATTEMPTED')
  for(const phase of ['resume','change','confirm','approve-ux','retry-ux','extend-execution','verify-current','inspect'])expect(()=>requireObservationPhase(phase)).toThrow('PHASE_REFUSED')
})
it('binds an explicit model quote to reviewed evidence and refuses stale or changed evidence',()=>{
  const source=join(home,'pricing.html'),file=join(home,'quote.json'),now=Date.now()
  writeFileSync(source,'reviewed pricing capture')
  const quote={host:'api.deepseek.com',model:'deepseek-flash',source_url:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',source_path:source,source_sha256:observationHash(readFileSync(source)),reviewed_at:new Date(now).toISOString(),context_tokens:1048576,input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:.04}
  writeFileSync(file,JSON.stringify(quote));expect(readObservationQuote(file,now).quote.model).toBe('deepseek-flash')
  expect(()=>readObservationQuote(file,now+86400001)).toThrow('REVIEW_REQUIRED')
  writeFileSync(source,'changed');expect(()=>readObservationQuote(file,now)).toThrow('EVIDENCE_CHANGED')
})
it('rejects missing, malformed or insufficient balance before admitting a run',()=>{
  const models={data:[{id:'deepseek-flash'}]}
  for(const total_balance of ['', 'NaN','Infinity','9.99'])expect(()=>observationBalance(models,{is_available:true,balance_infos:[{currency:'CNY',total_balance}]},10)).toThrow('UNAVAILABLE')
  expect(()=>observationBalance(models,{is_available:true},10)).toThrow('UNAVAILABLE')
  expect(observationBalance(models,{is_available:true,balance_infos:[{currency:'CNY',total_balance:'10.00'}]},10)).toBe('10.00')
  expect(observationBalance(models,{is_available:true,balance_infos:[{currency:'CNY',total_balance:'8.66'}]},4.194304)).toBe('8.66')
})
