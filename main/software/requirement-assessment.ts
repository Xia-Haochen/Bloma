import type {SoftwareVerification} from './verification'

export interface RequirementAssessment {
  id: string
  status: 'passed' | 'failed' | 'unverified'
  next_owner?: 'implementation' | 'host' | 'user'
  evidence: Array<{source:'core'|'independent';name:string;status:string;detail?:string}>
}

/** One requirement view over the same candidate's execution receipts. */
export function assessCandidateRequirements(ids:string[],result:SoftwareVerification):RequirementAssessment[] {
  return ids.map(id=>{
    const core=result.core?.requirements?.find(row=>row.id===id)
    const coreStatus=core?.verification??(!result.core?.requirements&&result.core?.status==='passed'?'passed':'unverified')
    const independent=result.independent?.case_results?.filter(row=>row.feature===id)??[]
    const coverageGaps=result.independent?.semantics?.coverage.filter(row=>row.feature===id&&
      (row.status==='missing'||row.status==='unresolved'))??[]
    const evidence:RequirementAssessment['evidence']=[
      {source:'core',name:id,status:coreStatus},
      ...independent.map(row=>({source:'independent' as const,name:row.id,status:row.status,detail:row.error})),
      ...coverageGaps.map(row=>({source:'independent' as const,name:row.category,status:row.status,detail:row.reason})),
    ]
    const failed=coreStatus==='failed'||independent.some(row=>row.status==='failed')
    const pending=result.evidence_valid===false||coreStatus!=='passed'||coverageGaps.length>0||independent.some(row=>row.status!=='passed')
      ||result.independent?.status==='unverified'&&!independent.length
    const status=result.evidence_valid===false?'unverified':failed?'failed':pending?'unverified':'passed'
    const needsUser=result.core?.pending_user_checks?.some(row=>row.feature===id)
    const hostPending=result.evidence_valid===false||coreStatus==='environment_blocked'||coverageGaps.length>0||independent.some(row=>
      ['environment','semantic'].includes(row.kind)&&row.status!=='passed')
      ||!result.core||result.independent?.status==='unverified'&&!independent.length
    return {id,status,evidence,...(status==='passed'?{}:{next_owner:result.evidence_valid===false?'host' as const:failed?'implementation' as const:
      needsUser?'user' as const:hostPending?'host' as const:'implementation' as const})}
  })
}
