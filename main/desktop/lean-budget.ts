import { softwareExecutionLimits, currentFundedExecutionWindow, fundedExecutionLimits, configureSoftwareExecutionLimits,
  SOFTWARE_EXECUTION_REQUEST_CAPACITY, SOFTWARE_EXECUTION_OUTPUT_CAPACITY } from '../software/execution-limits'
import { GENERATION_MAX_TOKENS } from '../platform/llm/model-resolution'
import { findProject } from '../project/project-service'
import { createProductionBudget, productionDeadlineMs, RUNTIME_HEARTBEAT_MS } from './production-budget'

export const SOFTWARE_PRODUCTION_LIMITS = {
  requests: SOFTWARE_EXECUTION_REQUEST_CAPACITY,
  output: SOFTWARE_EXECUTION_OUTPUT_CAPACITY,
  perResponse: GENERATION_MAX_TOKENS,
}

export function leanBudget(projectId: string, phase: string) {
  const project = findProject(projectId)
  const software = project.workflow_version === 'software-v1'
  const configured = software ? softwareExecutionLimits(projectId, project.lean_operation_id ?? 'initial') : undefined
  // Software has one shared allowance. A second, smaller implementation-phase
  // limit must not strand an otherwise admitted continuous task.
  const limits = { ...SOFTWARE_PRODUCTION_LIMITS, ...configured }
  return createProductionBudget(projectId, `lean-v1/${project.lean_operation_id ?? 'initial'}`, phase,
    software ? { ...limits, phaseRequests: limits.requests } : undefined, software ? 'lease' : 'legacy')
}

export function leanBudgetStopMessage(projectId: string, phase: string, reason: string): string {
  const state = leanBudget(projectId, phase).snapshot()
  return `${reason}：本任务累计请求 ${state.requests}/${state.limits.requests}，预留及已报告输出 ${state.output}/${state.limits.output} token。已有文件和开发数据已保留；继续不会清零用量。需调整预算或缩小剩余目标后再执行。`
}

/** Preparation, tools and host verification share active execution time. Human
 * waiting time is excluded. A failed accounting write cannot release delivery. */
export async function withLeanRuntime<T>(projectId: string, phase: string, signal: AbortSignal | undefined,
  work: (signal: AbortSignal, budget: ReturnType<typeof leanBudget>) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  const project=findProject(projectId),window=currentFundedExecutionWindow()
  if(project.workflow_version==='software-v1'&&window&&window.remainingRmb>0&&window.remainingRequests>0){
    const before=leanBudget(projectId,phase).snapshot()
    configureSoftwareExecutionLimits(projectId,project.lean_operation_id??'initial',{
      ...fundedExecutionLimits(before,window),reason:'宿主已准入共享执行窗口，保持累计计数；需求、设计与制作共用剩余额度。'})
  }
  const budget = leanBudget(projectId, phase)
  const total = budget.startRuntime()
  // Software work has no fixed overall deadline. Runtime leases/accounting,
  // request/output/money guards and per-tool timeouts remain authoritative.
  // Historical workflows retain their cumulative deadline for compatibility.
  const remaining = findProject(projectId).workflow_version === 'software-v1' ? undefined : productionDeadlineMs('desktop-implement') - total
  if (remaining !== undefined && remaining <= 0) { budget.finishRuntime(); throw new Error('HARNESS_DEADLINE_EXCEEDED') }
  const guard = new AbortController(), timer = remaining === undefined ? undefined
    : setTimeout(() => guard.abort(new Error('HARNESS_DEADLINE_EXCEEDED')), remaining)
  const active = signal ? AbortSignal.any([signal, guard.signal]) : guard.signal
  const heartbeat = setInterval(() => { try { budget.heartbeatRuntime() } catch (error) { guard.abort(error) } }, RUNTIME_HEARTBEAT_MS)
  try { active.throwIfAborted(); const result = await work(active,budget); active.throwIfAborted(); return result }
  finally { clearTimeout(timer); clearInterval(heartbeat); budget.finishRuntime() }
}
