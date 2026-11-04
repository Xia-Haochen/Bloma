import type { PersonalExperience } from '../../shared/personal-intent-types'

export interface IntentObservation { commitment_id: string; status: 'supported' | 'concern' | 'unverified'; evidence: string; limitations: string; finding_ids?: string[] }
export function validateIntentObservations(value: unknown, experience: PersonalExperience | undefined): IntentObservation[] | undefined {
  if (!experience) { if (value !== undefined) throw Error('INTENT_OBSERVATIONS_NOT_APPLICABLE'); return }
  if (!Array.isArray(value) || value.length !== experience.commitments.length) throw Error('INTENT_OBSERVATIONS_REQUIRED')
  const expected = new Set(experience.commitments.map(c => c.id))
  for (const row of value) {
    if (!row || !expected.delete(row.commitment_id) || !['supported','concern','unverified'].includes(row.status)
      || Object.keys(row).some(key => !['commitment_id','status','evidence','limitations'].includes(key))
      || [row.evidence, row.limitations].some(text => typeof text !== 'string' || !text.trim() || text.length > 4000)) throw Error('INTENT_OBSERVATION_INVALID')
  }
  return value
}
