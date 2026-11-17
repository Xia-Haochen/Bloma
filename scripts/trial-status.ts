interface Check { is_error?: boolean; result?: {status?:string} }
export function trialResultStatus(input:{
  independent?:{status?:string};host_verification?:Check;finding_checks?:Check[];stage_verification?:{status?:string};
  release?:string;project_status?:string;current_stage?:string;milestone_status?:string;source_matches_milestone:boolean
}):string{
  if(input.independent?.status==='failed')return 'independent_failed'
  const checks=[input.host_verification,...(input.finding_checks??[])].filter((c):c is Check=>Boolean(c))
  if(checks.some(c=>c.result?.status==='failed')||input.stage_verification?.status==='failed')return 'host_verification_failed'
  if(checks.some(c=>c.is_error||c.result?.status!==undefined&&c.result.status!=='passed')
    ||input.stage_verification?.status!==undefined&&input.stage_verification.status!=='passed')return 'host_verification_incomplete'
  if(input.release&&input.project_status==='completed'&&input.current_stage==='completed'&&input.source_matches_milestone)return 'released_pending_independent_acceptance'
  if(input.milestone_status==='awaiting_confirmation'&&input.source_matches_milestone)return 'host_checked_pending_independent_acceptance'
  return 'incomplete'
}
