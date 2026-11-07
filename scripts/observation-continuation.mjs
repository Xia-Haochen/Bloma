import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
const hash=value=>createHash('sha256').update(value).digest('hex')

/** Explicit continuation is based on stopped work and current authority, never error wording. */
export function continuationBoundary(root,report,{resumeProduction=false}={}){
  if(!report.finished_at||!Number.isFinite(Date.parse(report.finished_at))||!report.status||report.status==='running')throw Error('RETEST_REQUIRES_FINISHED_ATTEMPT')
  const ledger=readFileSync(join(root,'monetary-policy.json.state.json'))
  if(JSON.parse(ledger).entries.some(row=>row.status!=='reported'))throw Error('RETEST_UNSETTLED_REQUEST')
  const project=JSON.parse(readFileSync(join(root,'home/projects.json'),'utf8')).projects.find(p=>p.project_id===report.project_id)
  const awaiting=project&&['blocked_for_user_decision','clarifying'].includes(project.current_stage)
  const delivered=project?.status==='completed'&&project.current_stage==='completed'&&project.desktop_phase==='delivered'&&typeof project.software_release_id==='string'&&!!project.software_release_id
  const production=resumeProduction&&project?.workflow_version==='software-v1'&&project.status==='active'&&project.desktop_blocked?.reason!=='user-stop'&&['generating_mvp','testing'].includes(project.current_stage)
  if(!awaiting&&!delivered&&!production)throw Error('RETEST_NOT_AT_USER_BOUNDARY')
  return {project_id:project.project_id,session_id:report.session_id,current_stage:project.current_stage,project_status:project.status,
    project_sha256:hash(JSON.stringify(project)),ledger_sha256:hash(ledger),software_release_id:project.software_release_id,...(production?{resume_production:true}:{})}
}
