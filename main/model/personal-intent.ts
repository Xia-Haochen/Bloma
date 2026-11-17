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

export interface IntentAssessment { mode: 'direct' | 'structured'; reason: string; source_ids: string[] }
export function validateIntentAssessment(value: unknown, sources: RequirementSource[]): value is IntentAssessment {
  const row = value as IntentAssessment
  return Boolean(row && ['direct','structured'].includes(row.mode) && typeof row.reason === 'string' && row.reason.trim() && row.reason.length <= 2000
    && Array.isArray(row.source_ids) && row.source_ids.length && new Set(row.source_ids).size === row.source_ids.length
    && row.source_ids.every(id => sources.some(s => s.id === id)))
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
