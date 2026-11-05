import { guiCaseEvidence, cliCaseOutcome } from './verification-evidence'
import { createHash } from 'node:crypto'
import { existsSync,readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { redactSoftwareOutput } from './process-manager'
import type { SoftwareVerification } from './verification'
import { verificationFailure } from './verification-diagnostics'
import {safeToolFeedback,type ToolFeedback} from '../../shared/tool-feedback'

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const readMore=(report_hash:string,offset=0)=>({tool:'read_production_context',arguments:{topic:'verification-report',report_hash,offset}})
export function verificationToolFeedback(result:SoftwareVerification):ToolFeedback{
  const failure=verificationFailure(result),category=failure?.category
  return safeToolFeedback({schema_version:1,execution:'completed',source:'host',scope:'software_candidate',
    verification:result.status==='passed'?'passed':result.status==='failed'?'failed':'unverified',
    category:category==='unknown'?'unknown':['test_adapter','harness','security_policy'].includes(category??'')?'verification_harness':category==='environment'?'environment':category==='product_assertion'?'product_assertion':undefined,
    assessment:failure&&{certainty:failure.diagnosis?.certainty??'unknown',root_cause_confirmed:false},
    reason:failure?.code,fingerprint:failure?digest([category,failure.code,failure.step,...(category==='product_assertion'?[failure.expected,failure.actual]:[])]):undefined,recovery:result.status==='passed'?'none':category==='environment'?'prepare_environment':'inspect'})!
}
export function verificationRefusalFeedback(error:unknown):ToolFeedback{
  const code=String(error).match(/\b(?:PROJECT_STAGE|GUI_NATIVE|GUI_EXISTING|TEST_CORRECTION)_[A-Z_]+/)?.[0]
  const contract=String(error).match(/"contract_digest":"([a-f0-9]{64})"/)?.[1]
  return{schema_version:1,source:'host',execution:'not_run',verification:'unverified',scope:'verification_admission',
    category:code?'invalid_input':'unknown',reason:code??'VERIFICATION_ADMISSION_UNRESOLVED',fingerprint:code?digest([code,contract]):undefined,recovery:code?'correct_input':'inspect'}
}
function preview(value:unknown,reportHash:string,persisted=true){
  if(value===undefined)return undefined
  const text=redactSoftwareOutput(typeof value==='string'?value:JSON.stringify(value))
  return text.length<=1200?JSON.parse(redactSoftwareOutput(JSON.stringify(value))):{preview:text.slice(0,1200),truncated:true,total_characters:text.length,read_more:persisted?{tool:'read_production_context',arguments:{topic:'verification-report',section:'raw',report_hash:reportHash,offset:0}}:{source:'current_tool_result',note:'前置错误未生成验收报告，完整错误在本次工具回执summary中'}}
}
export function verificationCases(result:SoftwareVerification){
  const gui=(result.core?.host_gui?.case_results??[]).map((row,index)=>{
    const {assertion}=guiCaseEvidence(result.core!.host_gui!,row.name)
    return{kind:'gui',index,...row,expected:assertion?.expected,actual:assertion?.actual}
  })
  const cli=(result.core?.host_cli?.cases??[]).map((row,index)=>({kind:'cli',index,...row,status:cliCaseOutcome(row)}))
  const independent=(result.independent?.case_results??[]).map((row,index)=>({...row,kind:'independent',failure_kind:row.kind,index,name:row.id,expected:row.expected_source,actual:row.steps.filter(step=>!step.passed)}))
  const rank=(status:string)=>status==='failed'?0:status==='passed'?2:1
  return [...gui,...cli,...independent].sort((a,b)=>rank(a.status)-rank(b.status))
}
/** One projection for immediate feedback and later diagnostics. Raw facts stay
 * in the host receipt; bounded pages explicitly identify omitted information. */
export function verificationReportView(result:SoftwareVerification,options:{historical?:boolean;offset?:number;limit?:number;at?:number;persisted?:boolean;error?:unknown}={}){
  const reportHash=digest(result),rows=verificationCases(result),offset=options.offset??0,limit=options.limit??8
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>24)throw Error('VERIFICATION_REPORT_PAGE_INVALID')
  const failure=verificationFailure(result,options.error)
  const facts=failure?.observation
  const pv=(value:unknown)=>preview(value,reportHash,options.persisted!==false)
  const selected=rows.slice(offset,offset+limit).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,pv(v)])))
  return{report_hash:reportHash,at:options.at??result.completed_at,recorded_status:result.status,
    report_available:options.persisted!==false,
    freshness:options.historical?'historical_not_revalidated':'current_observation',usable_for_delivery:false,
    candidate_id:result.candidate?.id,source:result.candidate?.source.digest,input_identity:result.input_identity,identity_protocol:'runtime_inventory_and_verification_inputs_v1',
    missing_evidence:[...(!result.input_identity?['input_identity_not_recorded']:[]),...(failure&&failure.expected===undefined?['expected_assertion_not_recorded']:[]),...(failure?['root_cause_not_confirmed']:[])],
    observation:facts&&{...facts,expected:pv(facts.expected),actual:pv(facts.actual)},
    diagnosis:failure?.diagnosis??(failure?{certainty:'unknown',root_cause_confirmed:false}:undefined),
    recorded_failure:result.failure&&{category:result.failure.category,code:result.failure.code,classification_basis:result.failure.classification_basis,interpretation:'recorded diagnosis, not independently confirmed root cause'},
    failure:failure&&{category:failure.category,code:failure.code,step:failure.step,classification_basis:failure.classification_basis,
      expected:pv(failure.expected),actual:pv(failure.actual),paths:failure.paths.length?failure.paths:result.failure?.paths,allowed_changes:failure.allowed_changes,next_tool:failure.next_tool,next_action:failure.next_action,next:failure.next},
    cases:selected,case_count:rows.length,counts:{failed:rows.filter(r=>r.status==='failed').length,unverified:rows.filter(r=>!['passed','failed'].includes(r.status)).length,passed:rows.filter(r=>r.status==='passed').length},
    pagination:{offset,returned:selected.length,omitted:rows.length-selected.length,next:offset+limit<rows.length?readMore(reportHash,offset+limit):undefined},
    details:options.persisted===false?{available:false,reason:'前置错误未生成验收记录，不能读取旧报告冒充本次结果'}:{...readMore(reportHash),note:'完整原始记录可按section=raw和offset分页读取；report_hash变化时拒绝混读。'},
    next_action:options.historical?(result.status==='passed'?{tool:'verify_app',arguments:{}}:failure?.next_action?.arguments.topic==='diagnostics'?{tool:'inspect_software_environment',arguments:{}}:failure?.next_action):failure?.next_action,
    next:options.historical?'历史记录只供定位；需要当前通过凭据时重新verify_app，不能直接交付。':failure?.next??'沿当前质量门完成交付，操作返回不是交付完成。'}
}
function loadReceipt(projectId:string):{version:1;state:'complete';at:number;result:SoftwareVerification;result_hash:string}{
  if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('VERIFICATION_REPORT_OWNER_INVALID')
  const path=join(getPromaHome(),'software-verification',projectId+'.json')
  if(!existsSync(path))throw Error('VERIFICATION_REPORT_NOT_FOUND')
  if(statSync(path).size>16*1024*1024)throw Error('VERIFICATION_REPORT_TOO_LARGE')
  let receipt
  try{receipt=JSON.parse(readFileSync(path,'utf8'))}catch{throw Error('VERIFICATION_REPORT_INVALID')}
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw Error('VERIFICATION_REPORT_INVALID')
  if(receipt.state==='running')throw Error('VERIFICATION_REPORT_RUNNING')
  if(receipt.version!==1||receipt.state!=='complete'||!receipt.result||!['passed','failed','unverified','environment_blocked'].includes(receipt.result.status)||digest(receipt.result)!==receipt.result_hash)throw Error('VERIFICATION_REPORT_INVALID')
  return receipt
}
/** A cached return adds transient reused flags. Page references must still use
 * the persisted receipt hash, never a hash of the decorated return value. */
export function verificationToolReport(projectId:string,observed:SoftwareVerification){
  const receipt=loadReceipt(projectId),normalized={...observed,...(observed.core?{core:{...observed.core}}:{})}
  if(observed.reused){
    if(receipt.result.reused===undefined)delete normalized.reused;else normalized.reused=receipt.result.reused
    if(normalized.core){if(receipt.result.core?.reused===undefined)delete normalized.core.reused;else normalized.core.reused=receipt.result.core.reused}
  }
  if(digest(normalized)!==receipt.result_hash)throw Error('VERIFICATION_REPORT_CHANGED: 当前回执与本次返回不一致')
  return{...verificationReportView(receipt.result,{at:receipt.at}),reused:Boolean(observed.reused)}
}
/** Agent-facing response shared by explicit verification and automatic closeout.
 * Keep audit detail in the bound report, not duplicated throughout model input. */
export function verificationResponse(projectId:string,result:SoftwareVerification,persisted=true,error?:unknown){
  const view=persisted?verificationToolReport(projectId,result):verificationReportView(result,{persisted:false,error})
  const {report_hash,report_available,freshness,candidate_id,input_identity,counts,case_count}=view
  const cases=view.cases.slice(0,4)
  const failure=view.failure&&{category:view.failure.category,code:view.failure.code,step:view.failure.step,
    classification_basis:view.failure.classification_basis,expected:view.failure.expected,actual:view.failure.actual,paths:view.failure.paths,allowed_changes:view.failure.allowed_changes}
  return {status:result.status,summary:redactSoftwareOutput(result.summary).slice(0,1600),reused:Boolean(result.reused),
    failure,
    evidence:{report_hash,report_available,freshness,candidate_id,input_identity,counts,case_count,cases,
      omitted:case_count-cases.length,details:view.details},
    warnings:[...(result.core?.host_gui?.evidence_warnings??[]),...(result.independent?.case_results??[]).flatMap(row=>row.evidence_warnings??[])].slice(0,4),
    next_action:result.status==='passed'?undefined:view.failure?.next_action,
    next:result.status==='passed'?'本次登记检查通过，可以结束制作。宿主继续必要审阅与交付；如有实际缺口会返回。不要无变化重复验收。':view.failure?.next,
    delivery:'not_issued_by_tool'}
}
/** Only this project's verified host receipt is readable; no arbitrary paths. */
export function readVerificationReport(projectId:string,input:{report_hash?:unknown;offset?:unknown;limit?:unknown;section?:unknown}={}){
  const receipt=loadReceipt(projectId)
  if(input.report_hash!==undefined&&input.report_hash!==receipt.result_hash)throw Error('VERIFICATION_REPORT_CHANGED: 记录已更新，重新从第一页读取，不拼接不同候选证据')
  const offset=input.offset??0
  if(!Number.isSafeInteger(offset)||(offset as number)<0)throw Error('VERIFICATION_REPORT_PAGE_INVALID')
  if((offset as number)>0&&input.report_hash===undefined)throw Error('VERIFICATION_REPORT_HASH_REQUIRED: 后续页必须绑定第一页的report_hash')
  if(input.section==='raw'){
    const text=redactSoftwareOutput(JSON.stringify(receipt.result)),start=offset as number,end=Math.min(start+6000,text.length)
    return{report_hash:receipt.result_hash,freshness:'historical_not_revalidated',usable_for_delivery:false,encoding:'JSON text fragment; do not parse as a complete record',text:text.slice(start,end),offset:start,total_characters:text.length,
      next:end<text.length?{tool:'read_production_context',arguments:{topic:'verification-report',section:'raw',report_hash:receipt.result_hash,offset:end}}:undefined}
  }
  if(input.section!==undefined&&input.section!=='cases')throw Error('VERIFICATION_REPORT_SECTION_INVALID')
  return verificationReportView(receipt.result,{historical:true,at:receipt.at,offset:offset as number,limit:input.limit as number|undefined})
}
