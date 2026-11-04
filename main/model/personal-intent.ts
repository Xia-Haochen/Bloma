import type { RequirementSource } from './requirements-model'

import type { PersonalExperience } from '../../shared/personal-intent-types'
export type { PersonalExperience } from '../../shared/personal-intent-types'

/** Host-owned text sources. Stable IDs survive repeated summaries and corrections. */
export function intentSources(source: string, previous: RequirementSource[] = []): RequirementSource[] {
  const rows = structuredClone(previous)
  let sequence = Math.max(0, ...rows.map(row => Number(row.id.slice(2)) || 0))
  for (const text of source.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean)) {
    if (!rows.some(row => row.text === text)) rows.push({ id: `S-${String(++sequence).padStart(3, '0')}`, text })
  }
  if (rows.length > 256 || JSON.stringify(rows).length > 128000) throw Error('INTENT_SOURCES_CAPACITY: 原话过多，需明确分段范围；不得截断承诺')
  return rows
}

export function experienceIssues(value: unknown, features: Set<string>, sources: Set<string>, scenarios: Set<string>): string[] {
  if (value === undefined) return []
  const v = value as PersonalExperience
  if (!v || typeof v.summary !== 'string' || !v.summary.trim() || v.summary.length > 2000
    || !Array.isArray(v.commitments) || !v.commitments.length || v.commitments.length > 32) return ['核心体验结构无效']
  const ids = new Set<string>(), issues: string[] = []
  for (const c of v.commitments) {
    if (!c || !/^EXP-\d{3,}$/.test(c.id) || ids.has(c.id)
      || [c.statement, c.unacceptable_substitute].some(t => typeof t !== 'string' || !t.trim() || t.length > 4000)) {
      issues.push('核心体验条目或反例无效'); continue
    }
    ids.add(c.id)
    for (const [refs, allowed] of [[c.feature_ids, features], [c.source_ids, sources], [c.scenario_ids, scenarios]] as const) {
      if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(id => !allowed.has(id))) issues.push(`${c.id} 体验来源/功能/场景引用无效`)
    }
  }
  return issues
}

export const PERSONAL_INTENT_PROMPT = `个性化玩法、私人例外、持续规则或复杂关系不能压成通用功能列表。需要时输出requirements_model（旧任务已有则必须更新保留），复用版本1结构：
{version:1,goal,target_users:[文本],entities:[{id:O-001,name,description,attributes:[]}],relations:[{from,to,description}],workflows:[{id:W-001,name,steps:[文本],feature_ids:[F编号]}],rules:[{id:BR-001,statement,feature_ids,source_ids,origin:user|assumption}],scenarios:[{id:AC-001,feature_id,kind:normal|boundary|exception,given,when,then,rule_ids:[]}],coverage:[{source_id,feature_ids:[],rule_ids:[],disposition:included|context|out_of_scope|superseded,reason}],open_questions:[],experience:{summary,commitments:[{id:EXP-001,statement,source_ids,feature_ids,scenario_ids,unacceptable_substitute}]}}。
sources由宿主提供且回填，不生成用户原话。每项功能有流程及normal/boundary/exception场景；非正常场景确实不适用可用not_applicable具体说明（至少20字），不凑假案例。每条规则在相应场景覆盖；每份来源有coverage。例外的对象、期限、冲突优先级写清规则。experience只在存在特殊体验时使用，反例说明哪种看似实现却违背原愿望。体验场景必须是对应功能实际适用的场景。简单任务省略模型，不增加问卷。未明的关键问题使用clarify，不编造。原话覆盖只证明关联，不代表语义正确；返回前从原话独立核对遗漏/弱化的承诺。`
