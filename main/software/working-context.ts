import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { readEngineeringDesign } from './engineering-design'
import { executionWindowFacts } from './execution-limits'
import { declaredEntryFacts } from '../desktop/launch-smoke'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { readSoftwareRunState } from './run-state'
import { softwareStatusView } from './state-view'
import { activeSoftwareCommands, redactSoftwareOutput } from './process-manager'
import { toolFailureKey } from '../agent/loop/work-progress'
import { leanBudget } from '../desktop/lean-budget'
import {readVerificationReport} from './verification-report'
import { applicableQualityLedger } from './quality-ledger'
import { importantFinding } from './quality-closeout'

function recentTools(sessionId?: string) {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return { available: false, tools: [] }
  const file = join(getPromaHome(), 'agent-sessions', sessionId + '.jsonl')
  if (!existsSync(file)) return { available: false, tools: [] }
  const size = statSync(file).size, count = Math.min(size, 131072), buffer = Buffer.alloc(count), fd = openSync(file, 'r')
  try { readSync(fd, buffer, 0, count, size - count) } finally { closeSync(fd) }
  let tail = buffer.toString('utf8'); if (size > count) tail = tail.slice(tail.indexOf('\n') + 1)
  const calls = new Map<string, { tool: string; path?: string }>(), tools: Array<{ tool: string; path?: string; status: string; failure?: string }> = []
  for (const line of tail.split('\n')) try {
    const message = JSON.parse(line)
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const path = typeof block.input?.path === 'string' && !/^(?:[a-z]:|[\\/])/i.test(block.input.path) && !block.input.path.split(/[\\/]/).includes('..') ? redactSoftwareOutput(block.input.path).slice(0, 160) : undefined
        calls.set(block.id, { tool: block.name.slice(0, 64), path })
      }
      if (block.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id)!
        tools.push({ ...call, status: block.is_error ? 'failed' : 'returned', failure: block.is_error && typeof block.content === 'string' ? toolFailureKey(call.tool, block.content)?.split(':')[0] : undefined })
      }
    }
  } catch { /* torn/oversized records are not invented as successful work */ }
  return { available: true, truncated: size > count, tools: tools.slice(-10) }
}

/** Host facts are a navigation index, not a new plan or PASS certificate. */
export function softwareWorkingContext(projectId: string, busy = true) {
  const project = findProject(projectId), brief = readPrdBackplane(projectId), state = readSoftwareRunState(projectId)
  const current = state?.operationId === project.lean_operation_id ? state : undefined
  const source = softwareVerificationFingerprint(project.root_path)
  // Existing findings remain the authority. Include their actual trigger, not
  // just an error code from which an investigator would have to guess a cause.
  const findings = applicableQualityLedger(projectId).findings.filter(f => importantFinding(f) && !['superseded','suggestion','disputed'].includes(f.disposition))
  const quality = { verification:'not_issued', count:findings.length,
    problems:findings.slice(-3).map(f=>({id:f.id,requirement:f.requirement,disposition:f.disposition,
      trigger:f.trigger.slice(0,300),evidence:f.evidence.slice(0,500),reproduction:f.reproduction.slice(0,300),
      identity:f.identity,reviewed:f.reviewed,last_check:f.checks.at(-1)})),
    details:{tool:'read_quality_findings'},note:'保留的发现及后续记录；是否仍阻断以当前质量门为准，代码修改或旧审阅不等于当前执行复测。' }
  let budget: { requests?: number; output?: number; accounting_available: boolean; error?: string }
  try { const live = leanBudget(projectId, 'desktop-implement').snapshot(); budget = { requests: live.requests, output: live.output, accounting_available: true } }
  catch { budget = { accounting_available: false, error: '当前计量记录不可读；以请求/金额准入保护为准，不从旧索引推断剩余额度。' } }
  let verification:Record<string,unknown>={available:false,missing_evidence:['usable_verification_receipt']}
  try{
    const record=readVerificationReport(projectId)
    if('cases'in record){
      const first=record.cases.find(row=>row.status!=='passed')
      const brief=(value:unknown)=>{const text=JSON.stringify(value);return text&&text.length>400?{preview:text.slice(0,400),truncated:true}:value}
      verification={available:true,recorded_status:record.recorded_status,freshness:record.freshness,usable_for_delivery:false,report_hash:record.report_hash,input_identity:record.input_identity,identity_protocol:record.identity_protocol,
        missing_evidence:record.missing_evidence,counts:record.counts,
        first_blocker:first&&Object.fromEntries(['kind','name','status','expected','actual','error'].map(key=>[key,brief(first[key])])),
        more_blockers:record.counts.failed+record.counts.unverified-(first?1:0),read_more:record.details}
    }
  }catch(error){verification.reason=String(error).match(/VERIFICATION_REPORT_[A-Z_]+/)?.[0]??'VERIFICATION_REPORT_READ_ERROR'}
  return { project_id: projectId, operation_id: project.lean_operation_id, session_id: current?.sessionId ?? project.last_session_id,
    delivery: brief.lean_brief && { form: brief.lean_brief.delivery, ui: brief.lean_brief.ui, distribution: brief.lean_brief.distribution ?? 'local',
      launch_contract: {tool:'read_production_context',arguments:{topic:'launch'}}, verification_contract: {tool:'read_production_context',arguments:{topic:brief.lean_brief.ui==='required'?'verification-gui':'verification'}} },
    execution_window: executionWindowFacts(),
    declared_entry: declaredEntryFacts(project.root_path),
    engineering: { design: 'ARCHITECTURE.md', available: Boolean(readEngineeringDesign(project.root_path)), history: 'bloma-history', note: '这是常用设计入口，不限定文件名；由负责人管理工程决定和Git提交，bloma-history仅是恢复检查点。' },
    project_state_topic: 'project-state', goal_excerpt: brief.positioning.slice(0, 600), confirmed: Boolean(brief.user_confirmed_at), scope_hash: prdScopeFingerprint(brief), feature_ids: brief.requirements.slice(0, 128).map(r => r.id), feature_count: brief.requirements.length,
    intent: brief.requirements_model && { experience: brief.requirements_model.experience, rules: brief.requirements_model.rules }, status: softwareStatusView(projectId, busy), current_source: source, current_source_protocol:'desktop_verification_fingerprint',checkpoint_source: current?.source,
    source_changed_since_checkpoint: source && current?.source ? source !== current.source : undefined,
    pending_commands: activeSoftwareCommands(projectId, current?.sessionId ?? project.last_session_id ?? ''),
    current_error: current?.error, historical_failure: current?.last_failure,
    budget,verification,quality,
    recent: recentTools(current?.sessionId ?? project.last_session_id),
    instruction: '这是宿主现场索引，不是新需求或通过凭据。最近检查与失败均有对应版本；先核对当前版本和已有工具回执，未决命令用read_process接续，不重复安装、写入或其它副作用。完整目标用features/overview读取；继续不清零账本。' }
}
export function renderWorkingFacts(facts:ReturnType<typeof softwareWorkingContext>){
  const omitted:Array<{field:string;reason:string;read_more:{tool:string;arguments:{topic:string}}}>=[]
  const omit=(field:string,topic='working-state')=>omitted.push({field,reason:'摘要容量限制，内容未丢弃；改变相关行为前读取完整依据',read_more:{tool:'read_production_context',arguments:{topic}}})
  const short=(value:string|undefined,limit:number,field:string)=>{
    if(value===undefined||value.length<=limit)return value
    omit(field);return value.slice(0,Math.floor(limit/2))+'【中段省略】'+value.slice(-Math.floor(limit/2))
  }
  // Mandatory identifiers, blockers, unfinished processes and budget survive
  // oversized intent/history. Optional sections are omitted as whole values.
  const view:Record<string,unknown>={project_id:facts.project_id,operation_id:facts.operation_id,session_id:facts.session_id,scope_hash:facts.scope_hash,
    current_source:facts.current_source,current_source_protocol:facts.current_source_protocol,checkpoint_source:facts.checkpoint_source,source_changed_since_checkpoint:facts.source_changed_since_checkpoint,
    status:{execution:{status:facts.status.execution.status,label:facts.status.execution.label},verification:{...facts.status.verification,scope_note:short(facts.status.verification.scope_note,300,'verification.scope_note')},goal:facts.status.goal},
    current_error:short(facts.current_error??facts.status.execution.reason,800,'current_error'),
    historical_failure:facts.historical_failure&&{...facts.historical_failure,error:short(facts.historical_failure.error,300,'historical_failure')},
    pending_commands:facts.pending_commands.slice(0,8).map(row=>({process_id:row.process_id,state:row.state})),pending_command_count:facts.pending_commands.length,
    budget:facts.budget,execution_window:facts.execution_window,delivery:facts.delivery,declared_entry:facts.declared_entry,verification:facts.verification,confirmed:facts.confirmed,omitted_sections:omitted,
    verification_details:{tool:'read_production_context',arguments:{topic:'verification-report'}},
    quality:{count:facts.quality.count,details:facts.quality.details,problems:facts.quality.problems.map(f=>({id:f.id,requirement:f.requirement,trigger:f.trigger.slice(0,180),evidence:f.evidence.slice(0,240),disposition:f.disposition}))},
    instruction:'状态是宿主导航，不是当前通过凭据。先处理current_error和未完成进程；历史通过需重新核对。omitted_sections所列依据尚未包含，必要时读取，不猜测、不重放副作用。'}
  if(facts.pending_commands.length>8)omit('pending_commands')
  for(const [field,value,topic]of [['goal_excerpt',facts.goal_excerpt,'overview'],['feature_ids',facts.feature_ids,'features'],['intent',facts.intent,'features'],['recent',facts.recent,'working-state']] as const){
    if(JSON.stringify({...view,[field]:value}).length<6200)view[field]=value
    else omit(field,topic)
  }
  const encoded=JSON.stringify(view)
  if(encoded.length>7400)throw Error('WORKING_CONTEXT_MINIMUM_OVERFLOW: 关键字段超出摘要契约，不能静默截断')
  return '【宿主工作状态摘要】\n'+encoded
}
export function renderSoftwareWorkingContext(projectId: string) {return renderWorkingFacts(softwareWorkingContext(projectId))}
