import { leanBudget } from '../desktop/lean-budget'
import { readQualityLedger, qualityLedgerPath } from './quality-ledger'
import { findDelegation } from '../agent/delegation/agent-collaboration'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import type { SoftwareStatusView } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readSoftwareRunState } from './run-state'
import { activeSoftwareCommands, redactSoftwareOutput } from './process-manager'
import { acceptanceScopeNote } from '../desktop/acceptance-evidence'

/** Presentation facts only. A historical PASS is never a fresh delivery
 * credential; launch/promotion keep their existing independent gates. */
export function softwareStatusView(projectId: string, busy: boolean): SoftwareStatusView {
  const project = findProject(projectId)
  let run: ReturnType<typeof readSoftwareRunState>
  let unavailable = false
  try { const value = readSoftwareRunState(projectId); if (value?.operationId === project.lean_operation_id) run = value } catch { unavailable = true }
  const inFlight = run && ['running','repairing','verifying'].includes(run.status)
  const execution = unavailable ? 'unavailable' : busy ? run?.status === 'verifying' || run?.status === 'repairing' ? run.status : 'running' : inFlight ? 'interrupted' : run?.status === 'verified' ? 'ended' : run?.status ?? (project.desktop_blocked ? 'blocked' : 'idle')
  const labels: Record<string, string> = { idle: '尚未执行', running: '正在执行', verifying: '正在检查', repairing: '正在修复', ended: '本轮已结束', blocked: '本轮需处理', cancelled: '本轮已停止', interrupted: '本轮已中断', waiting_user: '等待你确认', waiting_environment: '等待运行环境' }
  let verification: SoftwareStatusView['verification'] = { status: 'not_run', label: '尚无检查记录' }
  const file = join(getPromaHome(), 'software-verification', projectId + '.json')
  if (existsSync(file)) try {
    if (statSync(file).size > 2 * 1024 * 1024) throw Error('receipt too large')
    const receipt = JSON.parse(readFileSync(file, 'utf8'))
    const at = typeof receipt.at === 'number' && Number.isFinite(receipt.at) ? receipt.at : undefined
    if (receipt.state === 'running') verification = busy && execution === 'verifying' ? { status: 'running', label: '检查进行中', at } : { status: 'last_unverified', label: '上次检查未完成', at }
    else {
      if (receipt.state !== 'complete' || !receipt.result || createHash('sha256').update(JSON.stringify(receipt.result)).digest('hex') !== receipt.result_hash) throw Error('invalid receipt')
      const status = receipt.result.status
      verification = { status: status === 'passed' ? 'last_passed' : status === 'failed' ? 'last_failed' : 'last_unverified',
        label: status === 'passed' ? '最近检查通过（对应记录版本）' : status === 'failed' ? '最近检查未通过' : '最近检查尚未验证', at,
        scope_note:acceptanceScopeNote(receipt.result.core?.acceptance_evidence) }
    }
  } catch { verification = { status: 'unavailable', label: '检查记录需核对' } }
  const goal: SoftwareStatusView['goal'] = project.status === 'archived' || project.status === 'abandoned' ? { status: 'archived', label: '项目已归档或放弃' }
    : project.current_stage === 'completed' && project.desktop_phase === 'delivered' ? { status: 'delivered', label: '已交付' }
    : project.longterm_summary?.status === 'awaiting_confirmation' ? { status: 'waiting_confirmation', label: '本阶段待你核对' } : { status: 'not_delivered', label: '本轮尚未交付' }
  const reason = run?.error ?? project.desktop_blocked?.note
  let reviewPurpose: 'candidate' | 'binding' | 'coverage' | undefined
  if (busy && run) try {
    const path = qualityLedgerPath(projectId)
    if (existsSync(path) && statSync(path).size <= 2 * 1024 * 1024) {
      const review = readQualityLedger(projectId).reviews.find(review => review.status === 'pending' && review.run_id === run.runId && review.delegation && findDelegation(run.sessionId, review.delegation)?.status === 'running')
      if (review) reviewPurpose = review.purpose ?? 'candidate'
    }
  } catch { /* An unreadable/mismatched review is never presented as active. */ }
  let internalAllowanceAvailable = false
  if (!busy && /HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED/.test(reason ?? '')) try {
    const budget = leanBudget(projectId, 'desktop-implement').snapshot()
    internalAllowanceAvailable = budget.requests < budget.limits.requests && budget.limits.output - budget.output >= 512
  } catch { /* An unreadable allowance cannot enable a continue hint. */ }
  const guidance = softwareGuidance(execution, goal.status, reason, Boolean(project.workflow_retirement), internalAllowanceAvailable)
  if (reviewPurpose) { guidance.headline = reviewPurpose === 'coverage' ? '现在不用操作，正在核对检查是否完整。' : reviewPurpose === 'binding' ? '现在不用操作，正在确认问题能否被检查出来。' : '现在不用操作，正在独立检查程序。'; guidance.detail = '尚未交付；需要你确认时会明确提示。' }
  return { observed_at: Date.now(), operation_id: project.lean_operation_id, guidance, execution: { status: execution, review_purpose: reviewPurpose, label: labels[execution] ?? '现场需核对', reason: reason ? redactSoftwareOutput(reason).slice(0, 500) : undefined }, verification, goal,
    active_commands: activeSoftwareCommands(projectId, run?.sessionId ?? project.last_session_id ?? '').length }
}

/** Action-first copy is derived from host facts, never assistant wording or old PASS. */
export function softwareGuidance(execution: string, goal: SoftwareStatusView['goal']['status'], reason?: string, retired = false, internalAllowanceAvailable = false): NonNullable<SoftwareStatusView['guidance']> {
  if (retired || goal === 'archived') return { headline: '这个项目已停止制作，请返回项目列表。', detail: '原有记录保留，不会自动继续。', action: 'inspect', action_label: '查看项目记录' }
  if (execution === 'unavailable') return { headline: '暂时无法读取进度，请重新读取。', detail: '现有程序和记录保留；这不会重新制作。' }
  if (['running', 'repairing', 'verifying'].includes(execution)) return {
    headline: execution === 'verifying' ? '现在不用操作，正在帮你检查程序。' : execution === 'repairing' ? '现在不用操作，正在帮你修复问题。' : '现在不用操作，正在帮你制作程序。',
    detail: '你可以继续输入想法；需要你确认时会明确提示。' }
  if (goal === 'delivered') return { headline: '程序做好了，点击“打开程序”开始使用。', detail: '程序已通过原交付流程。', action: 'open', action_label: '打开程序' }
  if (goal === 'waiting_confirmation' || execution === 'waiting_user') return { headline: '请确认当前结果是否符合你的要求。', detail: '请查看当前确认项，再选择确认或提出调整；不会替你确认。', action: 'inspect', action_label: '查看确认事项' }
  if (/CHANNEL|MODEL_(?:NOT|UNAVAILABLE|MISSING)|NO_MODEL|API_KEY_MISSING/.test(reason ?? '')) return { headline: '请先连接一个可用的AI模型。', detail: '连接后再继续，制作进度会保留。', action: 'settings', action_label: '去连接模型' }
  if (internalAllowanceAvailable && /HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED/.test(reason ?? '')) return { headline: '点击“继续制作”，接着完成剩余检查。', detail: '上次达到处理上限；当前处理额度已有余量，继续前仍会检查费用和运行条件。', action: 'continue', action_label: '继续制作' }
  if (/(?:BUDGET|OUTPUT|REQUEST|FUNDING|BALANCE|COST).*(?:EXHAUSTED|INSUFFICIENT|EXCEEDED|DENIED)|(?:PAUSED|PAUSE_GENERATION)/.test(reason ?? '')) return { headline: '这次制作已暂停，请先查看继续处理方式。', detail: '进度与用量已保留；不会自动增加额度或恢复付费。', action: 'inspect', action_label: '查看处理说明' }
  if (execution === 'waiting_environment') return { headline: '请先处理运行环境问题，再继续制作。', detail: '进度已保存，具体需要处理的事项在记录中。', action: 'inspect', action_label: '查看环境问题' }
  if (['blocked', 'interrupted', 'cancelled', 'ended'].includes(execution)) return { headline: '程序还没完成，点击“继续制作”接着处理。', detail: '会先核对当前条件，继续沿用原进度与用量；不会跳过检查。', action: 'continue', action_label: '继续制作' }
  return { headline: '告诉我你想做什么，我会带你一步步完成。', detail: '直接在下方输入想法，不需要编程知识。' }
}
