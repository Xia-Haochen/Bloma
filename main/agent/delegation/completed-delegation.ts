import type { ToolContext } from '../loop/agent-loop'
import type { DelegationRecord } from './agent-collaboration'
import { appendDelegationSettle, loadChildSessionSnapshot, restoreDelegationRecord } from './delegation-persistence'
import type { DelegationParentContext } from './delegation-context'
import {readFileSync} from 'node:fs'
import {getAgentSessionsIndexPath} from '../../../storage/config-paths'

export function registerChildWithHost(context: DelegationParentContext, child: { delegationId: string; childSessionId: string }, rollback: () => void): void {
  try { context.onChildCreated?.(child) }
  catch (error) {
    rollback()
    appendDelegationSettle(child.childSessionId, 'cancelled', { error: '宿主委派登记失败，子循环未启动' })
    throw error
  }
}

/** A finished handoff is replayable evidence, never a resumed live process. */
export function buildCompletedDelegation(parent: Pick<ToolContext, 'projectId' | 'sessionId'>, delegationId: string,
  completion: Pick<DelegationRecord, 'completion' | 'resolveCompletion'>, askSignal: DelegationRecord['askSignal']): DelegationRecord {
  const restored = restoreDelegationRecord(parent.sessionId, delegationId)
  const snapshot = restored && loadChildSessionSnapshot(restored.childSessionId)
  if (!restored || restored.parentSessionId !== parent.sessionId || restored.status !== 'completed'
    || snapshot?.lastSettle?.status !== 'completed' || snapshot.lastSettle.taskHandoff?.loop_status !== 'completed') {
    throw new Error('EXPERIMENT_HANDOFF_NOT_COMPLETED')
  }
  completion.resolveCompletion()
  return { delegationId, parentSessionId: parent.sessionId, childSessionId: restored.childSessionId,
    projectId: parent.projectId, role: 'implement', goal: '冻结骨架交接', status: 'completed', startedAt: Date.now(),
    abort: new AbortController(), ...completion, askSignal, loopStatus: 'completed',
    taskHandoff: snapshot.lastSettle.taskHandoff, resultSummary: restored.resultSummary }
}

/** Host-owned research recovery. Never adopts a live process or another
 * project's/parent's transcript; native Pi resumes its own retained session. */
export function buildIndependentResearchDelegation(parent:Pick<ToolContext,'projectId'|'sessionId'>,delegationId:string,
  completion:Pick<DelegationRecord,'completion'|'resolveCompletion'>,askSignal:DelegationRecord['askSignal']):DelegationRecord{
  const restored=restoreDelegationRecord(parent.sessionId,delegationId)
  const index=JSON.parse(readFileSync(getAgentSessionsIndexPath(),'utf8')).sessions as Array<{session_id:string;project_id:string;parent_session_id?:string;source_delegation_id?:string}>
  const owned=restored&&index.find(s=>s.session_id===restored.childSessionId&&s.project_id===parent.projectId&&s.parent_session_id===parent.sessionId&&s.source_delegation_id===delegationId)
  if(!owned||!restored?.finished)throw Error('ENGINEERING_MONITOR_RECOVERY_UNAVAILABLE')
  const snapshot=loadChildSessionSnapshot(restored.childSessionId)
  if(!snapshot.lastSettle)throw Error('ENGINEERING_MONITOR_RECOVERY_UNAVAILABLE')
  const loopStatus=snapshot.lastSettle.taskHandoff?.loop_status
  if(loopStatus&&!['completed','turn_limit','budget_exhausted','cancelled'].includes(loopStatus))throw Error('ENGINEERING_MONITOR_RECOVERY_UNAVAILABLE')
  completion.resolveCompletion()
  return{delegationId,parentSessionId:parent.sessionId,childSessionId:restored.childSessionId,projectId:parent.projectId,
    role:'research',assignment:{readOnly:true,independentWorkspace:true},goal:'独立研究续接',status:restored.status,startedAt:Date.now(),
    abort:new AbortController(),...completion,askSignal,resultSummary:restored.resultSummary,error:restored.error,
    loopStatus:(loopStatus as DelegationRecord['loopStatus'])??(restored.status==='completed'?'completed':'cancelled'),taskHandoff:snapshot.lastSettle.taskHandoff}
}
