import type { PersonalExperience } from '../../shared/personal-intent-types'

export interface IntentObservation { commitment_id: string; status: 'supported' | 'concern' | 'unverified'; evidence: string; limitations: string; finding_ids?: string[] }
export type SubmittedIntentObservation = Omit<IntentObservation,'finding_ids'> & {finding_indices?:number[]}
export function validateIntentObservations(value: unknown, experience: PersonalExperience | undefined): SubmittedIntentObservation[] | undefined {
  if (!experience) { if (value !== undefined) throw Error('INTENT_OBSERVATIONS_NOT_APPLICABLE'); return }
  if (!Array.isArray(value) || value.length !== experience.commitments.length) throw Error('INTENT_OBSERVATIONS_REQUIRED')
  const expected = new Set(experience.commitments.map(c => c.id))
  for (const row of value) {
    if (!row || !expected.delete(row.commitment_id) || !['supported','concern','unverified'].includes(row.status)
      || Object.keys(row).some(key => !['commitment_id','status','evidence','limitations','finding_indices'].includes(key))
      || [row.evidence, row.limitations].some(text => typeof text !== 'string' || !text.trim() || text.length > 4000)) throw Error('INTENT_OBSERVATION_INVALID')
    if(row.status==='concern'&&(!Array.isArray(row.finding_indices)||!row.finding_indices.length))throw Error('INTENT_CONCERN_FINDING_INDICES_REQUIRED: concern须用finding_indices明确关联本次findings数组中的0起始索引，不能把同功能的所有意见都算作核心体验缺陷。')
    if(row.finding_indices!==undefined&&(!Array.isArray(row.finding_indices)||row.status!=='concern'&&row.finding_indices.length>0||row.finding_indices.length>32||new Set(row.finding_indices).size!==row.finding_indices.length||row.finding_indices.some((n:unknown)=>!Number.isSafeInteger(n)||(n as number)<0)))throw Error('INTENT_OBSERVATION_INVALID')
  }
  return value
}
export function bindIntentFindings(observations:SubmittedIntentObservation[]|undefined,experience:PersonalExperience|undefined,findings:Array<{id:string;requirement:string}>):IntentObservation[]|undefined{
  return observations?.map(({finding_indices,...observation})=>{
    const commitment=experience?.commitments.find(c=>c.id===observation.commitment_id)
    const linked=(finding_indices??[]).map(index=>findings[index])
    if(linked.some(f=>!f||!commitment?.feature_ids.includes(f.requirement)))throw Error('INTENT_CONCERN_FINDING_REFERENCE_INVALID')
    return{...observation,...(observation.status==='concern'?{finding_ids:linked.map(f=>f.id)}:{})}
  })
}
