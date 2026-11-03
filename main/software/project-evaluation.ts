import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { isLongtermSoftware, readLongtermState } from './longterm-state'
import { projectPlanView } from './project-plan'
import { readSoftwareRunState } from './run-state'

/** Read-only project facts. A historical delivery event cannot end a new scope. */
export function projectEvaluation(projectId: string) {
  const project = findProject(projectId), brief = readPrdBackplane(projectId)
  const scope = prdScopeFingerprint(brief)
  const state = isLongtermSoftware(projectId) ? readLongtermState(projectId) : undefined
  const current = state?.milestones.find(m => m.id === state.current_id)
  const run = readSoftwareRunState(projectId)
  const sameScope = current?.scope_hash === scope
  const delivered = Boolean(brief.user_confirmed_at && sameScope && current?.status === 'delivered')
  return { version: 1, project_id: projectId, scope, confirmed: Boolean(brief.user_confirmed_at),
    ...projectPlanView(brief),
    current_milestone: current ? { id: current.id, status: current.status, current_scope: sameScope } : null,
    cumulative_scope_delivered: delivered,
    remaining_required_feature_ids: delivered ? [] : brief.requirements.map(r => r.id),
    current_decisions: state?.decisions.filter(d => d.scope === scope) ?? [],
    historical_decision_ids: state?.decisions.filter(d => d.scope !== scope).map(d => d.id) ?? [],
    optional_backlog_count: state?.backlog.filter(b => ['deferred', 'adopt_requested'].includes(b.state)).length ?? 0,
    execution: run && run.operationId === project.lean_operation_id ? { status: run.status, budget: run.budget } : null,
    note: '仅报告宿主记录；未确认范围、旧阶段与模型自述均不能证明当前整体达成。可选待办不自动成为必需目标。' }
}
