import type {ToolContext} from '../agent/loop/agent-loop'
import {restoreIndependentResearchDelegation} from '../agent/delegation/agent-collaboration'
import {readProjectActivity,recordProjectActivity} from './project-activity'
import {findProject} from '../project/project-service'
import {readPrdBackplane} from '../project/prd-store'
import {prdScopeFingerprint} from '../project/requirement-contract'
import {loadMessages} from '../platform/sessions/session-service'
import {redactSoftwareOutput} from './process-manager'
import {STEER_WRAP_PREFIX} from '../agent/loop/steer-queue'

/** Keep only the attachment in the existing activity record. Observations and
 * investigations stay in their original execution and agent transcripts. */
export function recoverEngineeringMonitor(ctx:ToolContext){
  const operation=findProject(ctx.projectId).lean_operation_id??'initial',scope=prdScopeFingerprint(readPrdBackplane(ctx.projectId))
  const event=readProjectActivity(ctx.projectId).events.filter(e=>e.kind==='engineering_monitor_attached'&&e.operation===operation&&e.scope===scope)
    .reverse().find(e=>(e.data as {parent_session_id?:string})?.parent_session_id===ctx.sessionId)
  const id=(event?.data as {delegation_id?:string}|undefined)?.delegation_id
  if(!id)return
  const record=restoreIndependentResearchDelegation(ctx,id)
  record.title='工程监视伙伴';record.goal=record.title
  return{delegation_id:record.delegationId,child_session_id:record.childSessionId}
}
export function recordEngineeringMonitor(ctx:ToolContext,child:{delegation_id:string;child_session_id:string}){
  recordProjectActivity(ctx.projectId,'engineering_monitor_attached',{parent_session_id:ctx.sessionId,...child})
}

/** Read the existing parent audit on resume; never copy private reasoning or
 * other child sessions, and never create a second execution ledger. */
export function recentProductionObservations(ctx:ToolContext){
  let result:ReturnType<typeof loadMessages>
  try{result=loadMessages({request_id:ctx.requestId,session_id:ctx.sessionId,limit:12})}
  catch(error){if(String(error).includes('SESSION_NOT_FOUND'))return{available:false};throw error}
  if(result.session.project_id!==ctx.projectId)throw Error('ENGINEERING_MONITOR_OWNER_MISMATCH')
  const entries=result.messages.flatMap(message=>(message.content??[]).flatMap(block=>{
    const steer=message.role==='user'&&message.origin==='user'&&block.type==='text'&&block.text?.startsWith(STEER_WRAP_PREFIX)
    if(!(steer||message.role==='assistant'&&['text','tool_use'].includes(block.type)||block.type==='tool_result'))return[]
    const text=redactSoftwareOutput(JSON.stringify(block))
    return[{at:message.timestamp,role:message.role,type:block.type,text:text.length<=5000?text:text.slice(0,2500)+'[中段省略]'+text.slice(-2500),truncated:text.length>5000}]
  })).slice(-12)
  return{available:true,source:'parent_public_transcript',historical:true,entries,truncated:result.truncated}
}
