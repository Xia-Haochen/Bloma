import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const count = (rows, key) => Object.fromEntries([...new Set(rows.map(key))].sort().map(k => [k, rows.filter(r => key(r) === k).length]))
/** Read-only forensic projection. No model/credentials/service imports, and no
 * prompt, source, tool arguments or arbitrary output text leaves the raw audit. */
export function auditConvergence(usage, events, quality, monetary, native = []) {
  const physical = usage.filter(r => r.event === 'transport_started')
  const sent = new Set(physical.map(r => r.query_id))
  const finished = usage.filter(r => r.event === 'query_finished')
  const paid = finished.filter(r => sent.has(r.query_id))
  const child = new Map(quality.reviews.filter(r => r.child).map(r => [r.child, r]))
  const role = r => child.has(r.session_id) ? child.get(r.session_id).kind ?? 'code' : r.role ?? 'unassigned'
  const stats = rows => {
    const tokens = rows.map(r => r.usage ?? {})
    const contexts = tokens.map(r => (r.input_tokens ?? 0) + (r.cache_read_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0)).sort((a,b) => a-b)
    return { logical_queries: rows.length, usage_missing: rows.filter(r => !r.usage).length,
      input_tokens: tokens.reduce((s,r) => s+(r.input_tokens??0),0), cached_input_tokens: tokens.reduce((s,r) => s+(r.cache_read_input_tokens??0),0),
      output_tokens: tokens.reduce((s,r) => s+(r.output_tokens??0),0), context_p50: contexts[Math.floor(contexts.length*.5)]??0,
      context_p95: contexts[Math.min(contexts.length-1,Math.floor(contexts.length*.95))]??0, context_max: contexts.at(-1)??0 }
  }
  const starts = events.filter(r => r.type === 'tool_call_started'), ends = events.filter(r => r.type === 'tool_call_completed')
  const checks = quality.findings.flatMap(f => f.checks)
  const summaries=native.flatMap(row=>row.message?.details?.summaries??[])
  const interruption=r=>{
    const summary=summaries.filter(s=>s.delegation_id===r.delegation).at(-1)
    return r.failure_code??(summary?.error?.match(/\b(?:HARNESS|MONETARY|QUALITY|REQUEST)_[A-Z_]+\b/)?.[0])
      ??(['turn_limit','budget_exhausted','cancelled'].includes(summary?.loop_status)?'loop:'+summary.loop_status:'not_recorded')
  }
  const messages=native.filter(r=>r.type==='message'),toolMessages=messages.map(r=>r.message).filter(m=>m.role==='toolResult')
  return { version:1, physical_requests: physical.length, sent_logical_queries: sent.size,
    physical_receipts: monetary.entries.length, receipt_status: count(monetary.entries,r=>r.status),
    accounted_micro_rmb: monetary.entries.reduce((n,r)=>n+r.charged_micro_rmb,0),
    finished_queries:finished.length, unsent_finished_queries:finished.filter(r=>!sent.has(r.query_id)).length,
    unfinished_sent_queries: [...sent].filter(id=>!finished.some(r=>r.query_id===id)).length,
    roles:Object.fromEntries([...new Set(paid.map(role))].sort().map(k=>[k,stats(paid.filter(r=>role(r)===k))])),
    tools:count(starts,r=>r.payload.tool), tool_errors:count(ends.filter(r=>r.payload.is_error),r=>r.payload.tool),
    review_status:count(quality.reviews,r=>r.status), review_sources:new Set(quality.reviews.map(r=>r.identity.source)).size,
    interrupted_reviews_without_transport:quality.reviews.filter(r=>r.status==='interrupted'&&!physical.some(p=>p.session_id===r.child)).length,
    interruption_reasons:count(quality.reviews.filter(r=>r.status==='interrupted'),interruption),
    parent_history:native.length?{messages:messages.length,compactions:native.filter(r=>r.type==='compaction').length,
      tool_message_characters:toolMessages.reduce((n,m)=>n+JSON.stringify(m).length,0),quality_read_characters:toolMessages.filter(m=>m.toolName==='read_quality_findings').reduce((n,m)=>n+JSON.stringify(m).length,0)}:undefined,
    reviews:quality.reviews.map(r=>({id:r.id,kind:r.kind??'code',source:r.identity.source,status:r.status,
      failure_code:r.status==='interrupted'?interruption(r):undefined,...stats(paid.filter(q=>q.session_id===r.child))})),
    finding_disposition:count(quality.findings,r=>r.disposition), recorded_case_checks:checks.length, check_outcomes:count(checks,c=>c.outcome),
    limitations:['Role attribution uses ledger session ownership, not guessed tool names.','Physical retries and logical queries are separate.','A review interruption with zero model calls is not a failed paid model answer.','Counts do not prove every edit was unnecessary or every suspicion was a real defect.'] }
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [trialRoot,projectId,task,policyName,out] = process.argv.slice(2)
  if(!trialRoot||!out||!/^[a-zA-Z0-9_-]+$/.test(projectId??'')||!/^[a-zA-Z0-9_-]+$/.test(task??'')||!/^monetary-policy(?:-[a-z0-9-]+)?\.json$/.test(policyName??''))throw Error('Usage: node scripts/audit-software-convergence.mjs ROOT PROJECT TASK POLICY OUT')
  const read = p => JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''))
  const lines = p => readFileSync(p,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s))
  const root=resolve(trialRoot)
  const project=read(join(root,task,'project.json'))
  const key=createHash('sha256').update(JSON.stringify([projectId,project.session_id,'lean-build',resolve(project.root)])).digest('hex')
  const nativePath=join(root,'home/bloma-pi-sessions',key,'session.jsonl')
  const report=auditConvergence(lines(join(root,'home/usage-ledger',projectId+'.jsonl')),lines(join(root,task,'events.jsonl')),
    read(join(root,'home/software-quality',projectId+'.json')),read(join(root,policyName+'.state.json')),existsSync(nativePath)?lines(nativePath):[])
  writeFileSync(resolve(out),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({physical:report.physical_requests,receipts:report.physical_receipts,reviews:report.review_status,checks:report.recorded_case_checks,report:resolve(out)}))
}
