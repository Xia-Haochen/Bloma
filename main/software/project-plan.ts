import type { PrdBackplane } from '../model/prd-backplane'

type Plan = NonNullable<PrdBackplane['project_plan']>
/** Plans partition reading work, never subtract obligations from the brief. */
export function validateProjectPlan(value: unknown, features: string[]): Plan | undefined {
  if (value === undefined) return
  const plan = value as Plan
  if (!plan || plan.version !== 1 || !Array.isArray(plan.stages) || !plan.stages.length || plan.stages.length > 100
    || typeof plan.current !== 'string') throw Error('PROJECT_PLAN_INVALID')
  const ids = new Set<string>(), assigned = new Set<string>(), known = new Set(features)
  for (const stage of plan.stages) {
    if (!stage || typeof stage.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(stage.id) || ids.has(stage.id)
      || typeof stage.title !== 'string' || !stage.title.trim() || stage.title.length > 400
      || !Array.isArray(stage.feature_ids) || !stage.feature_ids.length) throw Error('PROJECT_PLAN_STAGE_INVALID')
    ids.add(stage.id)
    for (const id of stage.feature_ids) {
      if (!known.has(id) || assigned.has(id)) throw Error('PROJECT_PLAN_COVERAGE_INVALID')
      assigned.add(id)
    }
  }
  if (!ids.has(plan.current) || assigned.size !== known.size) throw Error('PROJECT_PLAN_INCOMPLETE')
  return { version: 1, current: plan.current, stages: plan.stages.map(s => ({ id: s.id, title: s.title, feature_ids: [...s.feature_ids] })) }
}

export function projectPlanView(brief: PrdBackplane) {
  const all = brief.requirements.map(r => r.id)
  const plan = validateProjectPlan(brief.project_plan, all)
  const current = plan?.stages.find(s => s.id === plan.current)
  return { plan: plan ?? null, current_feature_ids: current?.feature_ids ?? all,
    other_required_feature_ids: current ? all.filter(id => !current.feature_ids.includes(id)) : [],
    verification_feature_ids: all, projection: 'reading_only',
    note: '阶段计划不缩减累计需求或旧行为验收；当前阶段完成不代表整体完成。' }
}
