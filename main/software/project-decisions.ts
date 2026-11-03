import type { LongtermProjectState } from '../../shared/types'

export type ProjectDecision = LongtermProjectState['decisions'][number]

/** References must point backwards within one scope; a model cannot erase user decisions. */
export function validateDecisionHistory(decisions: ProjectDecision[]) {
  const seen = new Map<string, ProjectDecision>(), replaced = new Set<string>()
  for (const row of decisions) {
    if (!row || typeof row.id !== 'string' || seen.has(row.id) || typeof row.scope !== 'string'
      || typeof row.decision !== 'string' || typeof row.reason !== 'string'
      || !['agent', 'user'].includes(row.author) || typeof row.at !== 'string'
      || row.feature_ids !== undefined && (!Array.isArray(row.feature_ids) || row.feature_ids.some(id => typeof id !== 'string'))
      || row.supersedes !== undefined && (!Array.isArray(row.supersedes) || new Set(row.supersedes).size !== row.supersedes.length)) throw Error('PROJECT_DECISION_INVALID')
    for (const id of row.supersedes ?? []) {
      const prior = seen.get(id)
      if (!prior || prior.scope !== row.scope || replaced.has(id) || prior.author === 'user' && row.author !== 'user') throw Error('PROJECT_DECISION_REFERENCE_INVALID')
      replaced.add(id)
    }
    seen.set(row.id, row)
  }
  return replaced
}

export function decisionPage(decisions: ProjectDecision[], scope: string, options: { offset?: number; limit?: number; history?: boolean } = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 20
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('PROJECT_DECISION_PAGE_INVALID')
  const replaced = validateDecisionHistory(decisions)
  const matching = decisions.filter(d => options.history || d.scope === scope && !replaced.has(d.id))
  return { items: matching.slice(offset, offset + limit).map(d => ({ ...d, effective: d.scope === scope && !replaced.has(d.id) })),
    total: matching.length, next_offset: offset + limit < matching.length ? offset + limit : null }
}
