import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {getPromaHome} from '../../storage/config-paths'
import {findProject} from '../project/project-service'
import {softwareVerificationFingerprint} from '../desktop/verification-fingerprint'
import {readSoftwareRunState} from './run-state'
import {softwareStatusView} from './state-view'
import {activeSoftwareCommands,redactSoftwareOutput} from './process-manager'
import {activeDebugSessionId,readDebugSession} from './debug-sessions'
import {componentContracts} from './component-contracts'
import {readVerificationReport} from './verification-report'

/** One bounded navigation view. Historical receipts are never fresh PASS. */
export function softwareDiagnosticContext(projectId:string,sessionId:string){
 const project=findProject(projectId),source=softwareVerificationFingerprint(project.root_path)
 let run:ReturnType<typeof readSoftwareRunState>,runError:string|undefined
 try{const state=readSoftwareRunState(projectId);if(state?.operationId===project.lean_operation_id)run=state}catch{runError='执行索引不可读'}
 let verification:unknown={available:false,reason:'VERIFICATION_REPORT_NOT_FOUND'},debug:unknown={available:false}
 const file=join(getPromaHome(),'software-verification',projectId+'.json')
 if(existsSync(file))try{
  verification={available:true,historical:true,revalidated:false,...readVerificationReport(projectId)}
 }catch(error){verification={available:false,reason:String(error).match(/VERIFICATION_REPORT_[A-Z_]+/)?.[0]??'VERIFICATION_REPORT_READ_ERROR',error:'验收记录不可用；按reason核对，不推断通过'}}
 try{const id=activeDebugSessionId(projectId,sessionId);if(id){const state=readDebugSession(projectId,sessionId,id);debug={available:true,id,state:state.state,source:state.source,version:state.version,stale:state.source!==source||state.stale,screenshot:state.screenshot,
  observations:state.observations.slice(-6).map(row=>({kind:row.kind,message:redactSoftwareOutput(row.message).slice(0,600)})),next:'当前截图用view_image({debug_session_id})；源码变化先inspect_app重新观察'}}}catch{debug={available:false,error:'本会话调试记录不可用'}}
 const scrub=(value:unknown):unknown=>typeof value==='string'?redactSoftwareOutput(value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value
 return scrub({project_id:projectId,current_source:source,operation_id:project.lean_operation_id,component_navigation:componentContracts().map(row=>({id:row!.id,source:row!.source_revision,tests:row!.verification.tests,scope:'navigation_not_product_pass'})),status:softwareStatusView(projectId,true),run_error:runError,current_error:run?.error?.slice(0,1600),historical_failure:run?.last_failure&&{error:run.last_failure.error.slice(0,800)},
  omitted_execution_details:(run?.error?.length??0)>1600||(run?.last_failure?.error.length??0)>800?{read_more:{tool:'read_production_context',arguments:{topic:'working-state'}},reason:'执行错误摘要截短，脱敏原文保留在工作状态'}:undefined,
  commands:activeSoftwareCommands(projectId,sessionId).map(row=>({process_id:row.process_id,state:row.state})),verification,debug,
  next:'已有命令用read_process接续；按已记录expected/actual定位。未知原因保留未知，截图附上不等于已审阅；历史记录不签发当前PASS。不重置预算或重复副作用。'})
}
