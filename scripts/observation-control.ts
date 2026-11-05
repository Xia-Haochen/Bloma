import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import type {AgentEvent} from '../shared/types'

export const observationHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')

export function observationBalance(models:{data?:Array<{id:string}>},balance:{is_available?:boolean;balance_infos?:Array<{currency:string;total_balance:string}>},cap:number){
  const value=balance.balance_infos?.find(row=>row.currency==='CNY')?.total_balance
  if(!models.data?.some(row=>row.id==='deepseek-flash')||balance.is_available!==true
    ||typeof value!=='string'||!value.trim()||!Number.isFinite(Number(value))||Number(value)<cap)throw Error('MODEL_OR_BALANCE_UNAVAILABLE')
  return value
}

/** A reviewed model-specific quote, not keyword matches across a pricing page. */
export function readObservationQuote(file:string,now=Date.now()){
  const quote=JSON.parse(readFileSync(file,'utf8')),at=Date.parse(quote.reviewed_at)
  if(quote.host!=='api.deepseek.com'||quote.model!=='deepseek-flash'
    ||quote.source_url!=='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
    ||!Number.isFinite(at)||now-at<0||now-at>86400000
    ||!Number.isSafeInteger(quote.context_tokens)||quote.context_tokens!==1048576
    ||!['input_rmb_per_million','output_rmb_per_million','cache_rmb_per_million'].every(key=>Number.isFinite(quote[key])&&quote[key]>0))throw Error('OBSERVATION_QUOTE_REVIEW_REQUIRED')
  const source=readFileSync(quote.source_path)
  if(observationHash(source)!==quote.source_sha256)throw Error('OBSERVATION_QUOTE_EVIDENCE_CHANGED')
  return {quote,source}
}

/** Claim before any project or request. Even a failed attempt is never resumed. */
export function claimObservationRun(root:string,identity:unknown){
  mkdirSync(root,{recursive:true})
  writeFileSync(join(root,'run-claimed.json'),JSON.stringify({at:new Date().toISOString(),identity}),{flag:'wx'})
}
export function requireObservationPhase(phase:string){
  if(!['preflight','run','simulate'].includes(phase))throw Error('OBSERVATION_PHASE_REFUSED')
}
export function observationAttemptSuffix(){const id=process.env.BLOMA_OBSERVATION_RETEST??'';if(id&&!/^[a-z0-9-]{1,40}$/.test(id))throw Error('RETEST_ID_INVALID');return id?'-'+id:''}
export function assertSimulatedContinuation(root:string,thinking:string,runtimeTree:string){
  const suffix=observationAttemptSuffix()
  const frozen=JSON.parse(readFileSync(join(root,'user-runtime'+suffix+'.json'),'utf8')),m=frozen.migration
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),task=Object.keys(manifest.tasks)[0]
  if(frozen.digest!==runtimeTree||manifest.thinking!==thinking||!m?.authorization?.trim()
    ||m.manifest_sha256!==observationHash(readFileSync(join(root,'manifest.json')))
    ||m.policy_sha256!==observationHash(readFileSync(join(root,'monetary-policy.json')))
    ||m.project_sha256!==observationHash(readFileSync(join(root,task,'project.json')))
    ||typeof m.report!=='string'||!m.report.startsWith(task+'/')&&!m.report.startsWith(task+'\\')||m.report.includes('..')
    ||m.report_sha256!==observationHash(readFileSync(join(root,m.report))))throw Error('SIMULATED_USER_IDENTITY_CHANGED')
  const report=JSON.parse(readFileSync(join(root,m.report),'utf8'))
  if((suffix?report.status!=='failed'||!(typeof report.error==='string'&&(report.error==='Error: SIMULATED_USER_PREVIEW_NOT_LOCAL'||report.error==='Error: SIMULATED_USER_OBSERVATION_REQUIRED'||report.error==='Error: SIMULATED_USER_DECISION_MISSING'||report.error.startsWith('TimeoutError: elementHandle.')))||m.attempt!==suffix||!m.boundary:report.status!=='awaiting_user')||existsSync(join(root,'user-run-claimed'+suffix+'.json')))throw Error('SIMULATED_USER_BOUNDARY_REQUIRED')
  return suffix?{...report,...m.boundary,status:'awaiting_user',retest_of:m.report}:report
}
export function assertFrozenObservation(root:string,runtimeHash:string,thinking:string,runtimeTree:string){
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'))
  if(manifest.runtime_sha256!==runtimeHash||manifest.thinking!==thinking||manifest.runtime_tree_sha256!==runtimeTree)throw Error('OBSERVATION_CONFIGURATION_CHANGED')
  if(existsSync(join(root,'run-claimed.json')))throw Error('OBSERVATION_ALREADY_ATTEMPTED')
}

/** Only receives a dispatch and a recording sink; no confirm/repair/resume hooks. */
export async function observeOneTurn(dispatch:(record:(event:AgentEvent)=>void)=>Promise<void>,record:(event:AgentEvent)=>void,signal:AbortSignal){
  const decisions:AgentEvent[]=[]
  let error:string|undefined
  try{
    signal.throwIfAborted()
    await dispatch(event=>{
      if(event.type==='user_decision_required')decisions.push(structuredClone(event))
      record(event)
    })
  }catch(cause){error=String(cause)}
  return {status:signal.aborted?'stopped':error?'failed':decisions.length?'awaiting_user':'returned',decisions,error}
}

export function observationOutcome(turn:{status:string},project:{status:string;current_stage:string;desktop_phase?:string},release?:string){
  if(turn.status!=='returned')return turn.status
  return release&&project.status==='completed'&&project.current_stage==='completed'&&project.desktop_phase==='delivered'
    ?'released_pending_independent_acceptance':'incomplete'
}
