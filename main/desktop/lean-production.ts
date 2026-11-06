import {createToolState} from '../agent/loop/agent-loop'
import { checkpointProjectHistory } from '../coding/project-git'
import { locallyVerifiedSoftware } from '../software/verification'
import {ModelRequestRefusal} from '../platform/llm/model-request-refusal'
import {applyApprovedNativeCorrections} from '../software/native-gui-registration'
import {currentFundedExecutionWindow,fundedExecutionLimits,configureSoftwareExecutionLimits} from '../software/execution-limits'
import { productDesignPolicy } from '../project/product-design-policy'
import { beginProjectAssignment } from '../software/task-assignment'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'
import { runAgentLoop } from '../agent/loop/agent-loop'
import { registerParentLoopContext, disposeParentDelegationState, stopDelegations, settleParentDelegationRuns } from '../agent/delegation/agent-collaboration'
import { findProject, updateProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { prdScopeFingerprint, requirementEvidenceHash } from '../project/requirement-contract'

import { productionAgentTools } from './production-tool-assembly'
import { leanBudget, leanBudgetStopMessage, withLeanRuntime } from './lean-budget'
import { guardDispatcherCompletion } from './production-completion'

import { runCoreVerification, type CoreVerificationResult } from './core-verification'
import { verificationFingerprint, softwareVerificationFingerprint } from './verification-fingerprint'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import { commitDesktopDelivery } from './delivery-state'
import { defaultQuickSecurityGate, type DesktopRouteDeps, type DesktopRouteInput } from './production-contracts'
import { sessionMaterials } from '../platform/attachments/material-context'
import { buildLeanGuiTool } from './lean-gui-tool'
import { buildLeanCliTool, cliSuitePath } from './lean-cli-check'
import { guiSuitePath } from './gui-acceptance'
import { readLaunchDeclaration, runLaunchSmoke } from './launch-smoke'
import { createHash, randomUUID } from 'node:crypto'
import { finishCorrectionSession, hasActiveCorrectionSession, settleCorrectionTeardown } from './correction-session'
import { readCorrectionSubmission, clearCorrectionSubmission } from './correction-outbox'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { buildLeanScopeTool } from './lean-scope-tool'
import { writeTextFileAtomic } from '../../storage/json-store'
import { isSoftwareProject } from './workflow-policy'
import { createSoftwareCollaborationPolicy } from '../software/collaboration-policy'
import { buildSoftwareAgentTools, SOFTWARE_ENGINEERING_INSTRUCTIONS } from '../software/agent-tools'
import { stopSoftwareSession, settleSoftwareCommands } from '../software/process-manager'
import { closeDebugSessions, retainedDebugVersion } from '../software/debug-sessions'
import { prepareSoftwareRelease, promoteSoftwareRelease, sealSoftwareRelease, verifyReleaseSource } from '../software/release-store'
import { saveSoftwareRegressionBaseline } from '../software/regression-baseline'
import { verifySoftwareCandidate, recentSoftwareVerification } from '../software/verification'
import { verificationResponse, verificationToolFeedback } from '../software/verification-report'
import { importedProjectContext } from '../software/import-project'
import { saveSoftwareRunState, readSoftwareRunState, recordSoftwareRepair, type SoftwareRunStatus } from '../software/run-state'
import { monetaryStopMessage, monetaryInputBlocked } from '../platform/llm/monetary-budget'
import { trialFeedbackText } from '../software/trial'
import { prepareIndependentDesign } from '../software/independent-design'
import { currentIndependentSemantics, recordIndependentDisputes } from '../software/independent-quality'
import { recordEvaluationEvent, activatePendingEvaluation } from '../software/harness-evaluation'
import { isLongtermSoftware, ensureLongtermState, stageLongtermMilestone, longtermPendingDecision } from '../software/longterm-state'
import { handleLongtermMessage } from '../software/longterm-message'
import { workflowRetirementReason } from './workflow-retirement'
import { renderSoftwareWorkingContext } from '../software/working-context'
import { createQualityReview } from '../software/quality-review'
import { readQualityLedger } from '../software/quality-ledger'

// Dissatisfaction is a repair request, not cancellation of the new workflow.
const isStop = (text: string) => text.split(/[，。；！？,;!?\n]+/).some(part => /^(?:(?:请|先|现在|马上|暂时)\s*)*(?:停止|取消|暂停|停下|先停|别推进|暂缓|先别做|不要开工|stop|cancel|pause)(?:(?:当前|本次|这个)?(?:任务|流程|运行|执行|制作)|一下|吧|了|\s)*$/i.test(part.trim()))

/** A continuous Pi executor followed by one host verification boundary. No
 * dispatcher dialogue, PHASE_ADVANCE markers or synthetic architecture stages. */
export async function runLeanProduction(input: DesktopRouteInput, deps: DesktopRouteDeps): Promise<void> {
  let project = findProject(input.projectId)
  const retirement=workflowRetirementReason(project)
  if(retirement){deps.publish(input,'message_delta',{text:retirement});deps.complete(input.sessionId,input.projectId,'incomplete');return}
  if(project.status==='archived'||project.status==='abandoned'){
    deps.publish(input,'message_delta',{text:'项目已归档或放弃，版本和数据保留；恢复项目后才能继续制作。'});deps.complete(input.sessionId,input.projectId,'incomplete');return
  }
  if(await handleLongtermMessage(input,deps))return
  project=findProject(input.projectId)
  if(input.cardOptionId){deps.publish(input,'message_delta',{text:'确认卡已不属于当前制作阶段，请刷新任务单或当前里程碑后操作。'});deps.complete(input.sessionId,input.projectId,'incomplete');return}
  if (isSoftwareProject(input.projectId) && /^(?:继续|恢复|查看进度|查看结果)[。！!\s]*$/.test(input.content.trim())) {
    const saved = readSoftwareRunState(input.projectId)
    if (saved?.status === 'waiting_environment' && saved.operationId === project.lean_operation_id && saved.source
      && saved.source === softwareVerificationFingerprint(project.root_path)) {
      deps.publish(input, 'message_delta', { text: saved.error ?? '本机试用版本已保留，独立环境验收仍待完成；当前没有新的环境证据。' })
      deps.complete(input.sessionId, input.projectId, 'incomplete'); return
    }
  }
  if (/^(?:谢谢|谢谢你|好的|收到|查看进度|查看结果)[。！!\s]*$/.test(input.content.trim()) || project.status === 'completed' && /^(?:继续|恢复)[。！!\s]*$/.test(input.content.trim())
    && !readCorrectionSubmission(input.projectId) && !hasActiveCorrectionSession(input.projectId)) {
    deps.publish(input, 'message_delta', { text: project.status === 'completed' ? '产物和验证记录已保留，可启动试用或继续提出修改。' : '当前现场已保留，可继续制作或提出具体修改。' })
    deps.complete(input.sessionId, input.projectId, project.status === 'completed' ? undefined : 'incomplete'); return
  }
  if (project.status === 'completed' && !isStop(input.content)) {
    // A new explicit user task, never a repair/resume/requirement revision.
    updateProject(input.projectId, { lean_operation_id: randomUUID(), status: 'active' })
  }
  if (!isStop(input.content)) {
    if (hasActiveCorrectionSession(input.projectId)) finishCorrectionSession({ projectId: input.projectId })
    if (isSoftwareProject(input.projectId)) await settleCorrectionTeardown(input.projectId)
    const correction = readCorrectionSubmission(input.projectId)
    if (correction) {
      const content = input.content.includes(correction.content) ? input.content : `${correction.content}\n用户补充：${input.content}`
      appendSessionMessage(input.sessionId, { role: 'user', origin: 'user', client_message_id: correction.id,
        content: [{ type: 'text', text: content }], timestamp: Date.now() })
      const query = input.query
      // Admission failure leaves the outbox pending. Once a model request starts,
      // Pi already owns the durable task; later continuation reads its transcript.
      input = { ...input, content, initialMessagePersisted: true, query: async function* (prompt, options) {
        clearCorrectionSubmission(correction.projectId, correction.id)
        yield* query(prompt, options)
      } }
    }
  }
  try {
    const window=currentFundedExecutionWindow()
    if(window&&!isStop(input.content)&&window.remainingRmb>0&&window.remainingRequests>0){
      const current=findProject(input.projectId),before=leanBudget(input.projectId,'desktop-implement').snapshot()
      configureSoftwareExecutionLimits(input.projectId,current.lean_operation_id??'initial',{...fundedExecutionLimits(before,window),reason:'宿主已准入外层窗口，保持累计计数并对齐剩余执行额度。'})
    }
    activatePendingEvaluation(input.projectId)
    recordEvaluationEvent(input.projectId,'operation_started',{session_id:input.sessionId,request_id:input.requestId})
    const finish = await withLeanRuntime(input.projectId, 'desktop-implement', input.signal,
      signal => runLeanProductionInner({ ...input, signal }, deps))
    await finish?.()
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    const monetaryNotice = monetaryStopMessage(error)
    const reason = monetaryNotice ? `${code}：${monetaryNotice}` : code
    if (!input.signal?.aborted && !/LEASE_ACTIVE|ALREADY_ACTIVE/.test(reason)) updateProject(input.projectId, { status: 'active', current_stage: 'generating_mvp', desktop_phase: 'desktop-implement',
      desktop_blocked: { reason: 'verification-incomplete', note: reason, at: new Date().toISOString() } })
    const text = `本次执行未完成，现场与用量保留：${reason}`
    deps.persistAssistant(input.sessionId, text); deps.publish(input, 'message_delta', { text })
    deps.complete(input.sessionId, input.projectId, 'incomplete')
  }
}

async function runLeanProductionInner(input: DesktopRouteInput, deps: DesktopRouteDeps): Promise<(() => Promise<void>) | undefined> {
  const project = findProject(input.projectId)
  const signal = input.signal ?? new AbortController().signal
  if (signal.aborted) return
  if (isStop(input.content)) {
    if (project.status !== 'completed') updateProject(input.projectId, { desktop_blocked: { reason: 'user-stop', note: input.content.slice(0, 200), at: new Date().toISOString() } })
    if (isSoftwareProject(input.projectId)) saveSoftwareRunState({ projectId: input.projectId, sessionId: input.sessionId, runId: randomUUID(), status: 'cancelled', error: input.content.slice(0, 200) })
    deps.publish(input, 'message_delta', { text: '已停止，已有文件和修改意见已保留。' }); deps.complete(input.sessionId, input.projectId, 'incomplete'); return
  }
  const historyBase = await checkpointProjectHistory(project.root_path, { kind: 'production_base', summary: '制作前的实际工程基线' }, signal)
  signal.throwIfAborted()
  recordEvaluationEvent(input.projectId, 'project_history', { ...historyBase, boundary: 'before_implementation' })
  const recoveredTests=applyApprovedNativeCorrections(input.projectId,signal)
  const brief = readPrdBackplane(input.projectId), scope = prdScopeFingerprint(brief)
  if(!isSoftwareProject(input.projectId))throw Error('SOFTWARE_WORKFLOW_REQUIRED')
  const continuation=/^(?:继续|恢复|验收|重新验收|运行验收|按已确认目标制作|开始桌面交付流程)[。！!\s]*$/.test(input.content.trim())
  const originalSource=softwareVerificationFingerprint(project.root_path)
  const runId = randomUUID()
  let assignment: ReturnType<typeof beginProjectAssignment> | undefined
  const checkpoint = (status: SoftwareRunStatus, patch: { error?: string; candidateId?: string; source?: string; check?: { path: string; sha256: string } } = {}) => {
    assignment?.checkpoint(status, patch)
    saveSoftwareRunState({ projectId: input.projectId, sessionId: input.sessionId, runId, status, ...patch })
  }
  const collaboration = createSoftwareCollaborationPolicy(input.projectId, project.root_path, input.sessionId)
  const quality = createQualityReview(input.projectId, input.sessionId, collaboration, input.env)
  const observeRuntime = (observation: import('../agent/loop/runtime-observation').RuntimeObservation) => {
    const review = readQualityLedger(input.projectId).reviews.find(r => r.child === observation.session_id)
    recordEvaluationEvent(input.projectId, 'runtime_identity', { observation: { ...observation,
      ...(review ? { quality_role: review.kind === 'visual' ? 'V' : 'C' } : {}) } })
  }
  const versionOf = () => {
    const current = readPrdBackplane(input.projectId)
    const rules = [guiSuitePath(input.projectId), cliSuitePath(input.projectId)].map(file =>
      existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null)
    return verificationFingerprint(project.root_path, { scope: prdScopeFingerprint(current), confirmed: Boolean(current.user_confirmed_at),
      ux: findProject(input.projectId).ux_confirmation ?? null, rules }, 'software')
  }
  const emit = (type: Parameters<DesktopRouteDeps['publish']>[1], payload: Record<string, unknown>) => {
    if(type.startsWith('delegation_'))recordEvaluationEvent(input.projectId,type,payload)
    deps.publish(input, type, payload)
  }
  const blocked = (reason: string, confirmation = false, state: SoftwareRunStatus = 'blocked') => {
    if (/\b(?:MONETARY_(?:BUDGET|OPERATION)_EXHAUSTED|HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED|REQUEST_BUDGET_EXHAUSTED)\b/.test(reason)) {
      try {
        const observed = retainedDebugVersion(input.projectId, input.sessionId)
        const current = observed && softwareVerificationFingerprint(project.root_path)
        if (current && current !== observed.source) reason += '\n当前文件还包含上次宿主观察之后的修改，尚未确认这些修改能正常运行；不能把上次可用画面当作当前版本。修改与旧观察已保留，恢复时应先核对这部分差异。'
      } catch { reason += '\n无法核对上次观察版本，当前修改仍未验收；恢复时先核对文件和运行结果。' }
    }
    updateProject(input.projectId, { status: 'active', current_stage: confirmation ? 'blocked_for_user_decision' : 'generating_mvp', desktop_phase: confirmation ? undefined : 'desktop-implement',
      desktop_blocked: { reason: 'verification-incomplete', note: reason, at: new Date().toISOString() } })
    checkpoint(confirmation ? 'waiting_user' : state, { error: reason })
    deps.persistAssistant(input.sessionId, reason)
    emit('message_delta', { text: reason }); deps.complete(input.sessionId, input.projectId, 'incomplete')
  }
  if (!brief.user_confirmed_at || !brief.lean_brief) { blocked('目标尚未确认，本次没有开始制作。', true); return }
  let ux: ReturnType<typeof readConfirmedUxBinding>
  try { ux = readConfirmedUxBinding(input.projectId, brief) } catch (error) { blocked(String(error), true); return }
  if(isLongtermSoftware(input.projectId))ensureLongtermState(input.projectId,input.sessionId)

  const budget = leanBudget(input.projectId, 'desktop-implement')
  let initialBudgetStop: string | undefined
  {
    const admission = budget.admission()
    if (!admission.allowed) {
      const registered = brief.lean_brief.ui === 'required' ? guiSuitePath(input.projectId) : cliSuitePath(input.projectId)
      if (!existsSync(registered)) { blocked(leanBudgetStopMessage(input.projectId, 'desktop-implement', admission.reason!)); return }
      if(!continuation&&!(await recentSoftwareVerification(input.projectId,input.requestId,signal))){blocked('本轮新请求尚未由模型处理，现有测试只覆盖此前确认的目标，不能据此宣称新请求已完成。进度和预算已保留。');return}
      initialBudgetStop = admission.reason
    }
    if(!initialBudgetStop&&monetaryInputBlocked(input.env.ANTHROPIC_BASE_URL,input.env.ANTHROPIC_MODEL)){
      const registered=brief.lean_brief.ui==='required'?guiSuitePath(input.projectId):cliSuitePath(input.projectId)
      if(!existsSync(registered)){blocked('当前金额保护连保守输入预留都无法放行，尚未发出模型请求。现有验收规则缺失，程序和账本已保留；不能跳过检查交付。');return}
      if(!continuation&&!(await recentSoftwareVerification(input.projectId,input.requestId,signal))){blocked('当前金额保护未放行模型，本轮新请求尚未处理；不能用旧版测试替代新增或修改目标的验收。已有程序和账本已保留。');return}
      initialBudgetStop='MONETARY_BUDGET_EXHAUSTED'
      emit('message_delta',{text:'当前金额保护无法放行新的模型请求；已有冻结测试，我先停止模型调用，执行免费的宿主验收。只有实际通过才交付。'})
    }
  }
  if ((!initialBudgetStop)) {
    const design = await prepareIndependentDesign({projectId:input.projectId,sessionId:input.sessionId,query:input.query,primaryEnv:input.env,signal})
    if(design.status==='blocked'){blocked(`独立验收设计尚未就绪：${design.reason}`);return}
    if(design.status==='frozen'&&design.contract){
      const semantics=currentIndependentSemantics(input.projectId,design.contract)
      if(!semantics.ready){await recordIndependentDisputes(input.projectId,semantics,signal);blocked(`独立案例的预期或覆盖声明尚有争议，未开始迎合这些预期的实现，也未改动确认目标或冻结断言：\n${JSON.stringify(semantics)}`,true);return}
    }
  }
  if (!deps.coreVerification && !deps.securityScan && !deps.launchSmoke) assignment = beginProjectAssignment(input.projectId,input.sessionId,runId)
  checkpoint('running', { source: softwareVerificationFingerprint(project.root_path) })
  const runSignal = signal
  const budgetedQuery = budget.wrap(input.query)
  let monetaryFailure: unknown
  // Pi persists an error string. Retain this run's typed refusal at the query
  // boundary so its cost breakdown survives the native session adapter.
  const query: SDKQuery = quality.wrapQuery(async function* (prompt, options) {
    try { yield* budgetedQuery(prompt, { ...options, requestGuard: request => {
      options.requestGuard?.(request)
      try {
        const body = JSON.parse(request.body)
        const effort = body.output_config?.effort ?? body.reasoning_effort ?? body.reasoning?.effort
        const allowedEffort = ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(effort) ? effort : 'unknown'
        recordEvaluationEvent(input.projectId,'request_prepared', { session_id: options.accounting?.parentSessionId ?? input.sessionId,
          model: typeof body.model === 'string' ? body.model : 'unknown', thinking_type: ['enabled','disabled','adaptive'].includes(body.thinking?.type) ? body.thinking.type : 'unknown',
          reasoning_effort: allowedEffort, max_tokens: Number.isSafeInteger(body.max_tokens) ? body.max_tokens : null,
          source: 'transport_request_guard', sent: 'not_confirmed', provider_parameter_acceptance: 'unknown' })
      } catch { /* observational only; never store raw request bodies or credentials */ }
    } }) }
    catch (error) { if (monetaryStopMessage(error)) monetaryFailure = error; throw error }
  })
  const baseTools = buildSoftwareAgentTools(input.projectId, 'parent', collaboration,
    url => emit('software_preview_changed', { preview_url: url ?? null }), () => emit('software_suggestions_changed', {}),()=>emit('longterm_changed',{summary:findProject(input.projectId).longterm_summary}))
  let scopePending = false
  const tools = productionAgentTools(baseTools, [
    ...quality.parentTools,
    buildLeanScopeTool(input.projectId, input.content, emit, () => { scopePending = true }),
    brief.lean_brief.ui === 'required' ? buildLeanGuiTool(input.projectId) : buildLeanCliTool(input.projectId)])
  const system = [
    SOFTWARE_ENGINEERING_INSTRUCTIONS,
    `宿主恢复检查点：${JSON.stringify(historyBase)}。这是版本恢复事实，不是工程提交或通过判定；由你检查产品仓库、处理可恢复问题并管理有意义的提交。`,
    ...(brief.lean_brief?.work_items?.length ? ['建议工作清单：'+JSON.stringify(brief.lean_brief.work_items)+'。随调查和实验调整，不按勾选状态判断交付；业务范围与完成标准仍须遵守。'] : []),
    ...(brief.project_plan ? ['已确认阶段计划：'+JSON.stringify(brief.project_plan)+'。按计划实现，局部检查反馈不代表完整交付。'] : []),
    '稳定候选交给verify_app，宿主统一执行、结算已绑定问题、安排必要的C/V并发布。模型负责实现与修复，不维护通过凭据或重复记账。read_quality_findings可查看实际阻塞；疑点与案例的对应关系由独立审阅确认，普通案例通过不能自行排除疑点。',
    '验证失败时沿实际反馈修复；建议与争议不自动扩大需求。修复集中完成后复验，稳定候选不再作无关修改。审阅期间不写入、不运行命令；确认的缺陷仍须实际复测。',
    '临时观察使用inspect_app，宿主保存在诊断目录；不要修改稳定候选来保存临时脚本。观察帮助定位问题，不替代冻结案例的执行证据。',
    '预期与确认需求矛盾时保留争议，按工具反馈提供证据；不降低断言掩盖失败。批准的纠正由宿主应用和复验。',
    `项目根：${project.root_path}。平台组件是可选资源；先查契约和关键未知，必要时委派独立实验，依据实际证据集成并复验。`,
    ...(project.imported_source ? [JSON.stringify(importedProjectContext(input.projectId))] : []),
    ux?.html_path ? `已确认外观：${ux.html_path}，先读后沿用；用户后续修改仅改相关部分。` : brief.lean_brief.ui === 'required' ? '用户明确授权直接制作界面，无需先画草图。' : '本任务无需额外外观设计。',
    '局部外观和缺陷直接修改。用户新增、删除业务能力或改变业务预期时，先用propose_scope_change保留原功能及新增预期并等待确认，不能在旧任务单下宣称新增功能已验收。',
    JSON.stringify({ goal: brief.positioning, source_statements:brief.lean_brief?.intent_sources??brief.requirements_model?.sources, requirements: brief.requirements.map(row => ({ id: row.id, description: row.description,
      expected: brief.acceptance[row.id], requirement_hash: requirementEvidenceHash(brief, row) })), constraints: brief.constraints,
      intent: brief.requirements_model && { experience: brief.requirements_model.experience, rules: brief.requirements_model.rules, workflows: brief.requirements_model.workflows }, out_of_scope: brief.out_of_scope, assumptions: brief.assumptions, design_policy: productDesignPolicy(brief), delivery: brief.lean_brief.delivery, distribution: brief.lean_brief.distribution ?? 'local' }),
    '保留真实用户数据与配置；测试使用隔离数据目录。预期依据已确认目标，不能改预期掩盖失败。特殊能力登记与执行细节可通过read_production_context按需读取。',
    '正式检查的输入格式以工具声明和当前反馈为准，按需读取验收上下文。',
    '宿主将独立运行核心检查、安全扫描及正常启动；你结束执行不等于交付通过。',
  ].join('\n\n')
  // Shared physical-request, output, monetary and active-time budgets own the
  // stop boundary; another 96-turn limit only interrupts useful work early.
  const maxTurns = Number.MAX_SAFE_INTEGER
  registerParentLoopContext(input.sessionId, { query, env: input.env, maxTokens: input.maxTokens, maxTurns,
    delegationMaxTurns: 24, delegationTurnLimits: { review: 48 }, delegationTurnCaps: { review: 48 }, permissionMode: 'allow-all', temperature: .1, system, editFormat: 'diff', runtimeScope: 'lean-build',
    executionScope: budget.executionScope, materials: sessionMaterials(input.projectId, input.sessionId), publish: emit,
    childMaterialsBuilder: child => quality.isQualityChild(child) ? undefined : sessionMaterials(input.projectId, input.sessionId),
    onRuntimeObservation: observeRuntime,
    ...(({ maxConcurrentDelegations: 2, allowChannelOverrides: false, delegationSummaryLimit: 3000,
      prepareDelegation: value => {
        const lease = quality.prepare(value)
        recordEvaluationEvent(input.projectId, 'delegation_started', {
          session_id: value.childSessionId, parent_session_id: input.sessionId,
          source: quality.isQualityChild(value.childSessionId) ? 'required_quality' : 'model_selected',
          reason: value.args.expectedOutput ?? value.args.task,
          task: value.args.task, role: value.args.role ?? 'implement', write_paths: value.args.writePaths ?? [],
          max_children: 2, budget_scope: budget.executionScope,
        })
        let released = false
        return { ...lease, release: () => {
          lease.release()
          if (!released) recordEvaluationEvent(input.projectId, 'delegation_released', { session_id: value.childSessionId, verification: 'not_implied' })
          released = true
        } }
      },
      childSystemBuilder: (_role: import('../../shared/delegation-run-context').DelegationRunRole, child: string) =>
        quality.system(child) ?? (collaboration.experiments.has(child) ? `你负责独立实验。先核对输入和关键未知，查必要资料，再运行最小可判定探针；失败先定位类别再调整，不原样重试。${collaboration.experiments.describe(child)}。可写文件和执行命令仅用于实验，不修改正式项目、不递归委派。用record_experiment_result交接方法、结论及真实产物；supports/refutes是解释，不是产品PASS。` : `完成主负责人交付的具体子任务，先读负责人指出的当前设计和相关文件，沿用已确定职责与接口；发现设计不成立时回报依据，由负责人更新设计。项目根：${project.root_path}。文件权限：${collaboration.describe(child)}。仅在归属范围内修改；不运行命令、不再委派、不修改目标/验收输入。需要跨边界修改时回报主负责人。简短交接实际修改、检查和未验证项，不自报产品通过。全局约束：${JSON.stringify(brief.constraints)}`) })),
    childToolsBuilder: (id, role, _format, child) => {
      const childTools = buildSoftwareAgentTools(id, role, collaboration,undefined,undefined,undefined,child)
      return role === 'review' ? quality.reviewTools(childTools, child) : childTools
    } })
  const cancelChildren = () => { stopDelegations(input.sessionId) }
  runSignal.addEventListener('abort', cancelChildren, { once: true })
  let task = input.observedSoftwareVersion ? trialFeedbackText(input.projectId, input.observedSoftwareVersion, input.content) : input.content
  let initial = true
  const waitForProductionChildren=(ctx:import('../agent/loop/agent-loop').ToolContext)=>guardDispatcherCompletion(ctx,undefined,undefined,quality.acceptedHandoff)
  const advanceCloseout = async (ctx: import('../agent/loop/agent-loop').ToolContext, locallyChecked = false) => {
    const waiting = await waitForProductionChildren(ctx)
    if (waiting) return waiting
    // A maker stopping is not evidence of a stable candidate. Let the common
    // verifier/repair loop observe failures before purchasing any review.
    if (!locallyChecked && !await recentSoftwareVerification(input.projectId, input.requestId, ctx.signal)) return
    const attemptedReviews=new Set<string>()
    for (;;) {
      const action = await quality.completionAction(ctx.signal), gap = action.gate
      if(action.halt)throw Error(gap)
      if(action.next_tool==='apply_test_correction'){applyApprovedNativeCorrections(input.projectId,ctx.signal);const checked=await verifySoftwareCandidate(input.projectId,input.requestId,ctx.signal);if(checked.status!=='passed')return JSON.stringify(verificationResponse(input.projectId,checked));continue}
      if(!['start_quality_review','start_visual_review'].includes(action.next_tool))return gap?action.feedback:undefined
      if(attemptedReviews.has(action.next_tool))return action.feedback
      attemptedReviews.add(action.next_tool)
      const visual = action.next_tool==='start_visual_review'
      await quality.begin(ctx, visual ? 'visual' : 'code')
      const summary = await waitForProductionChildren(ctx)
      const completedReview=readQualityLedger(input.projectId).reviews.filter(r=>(r.kind??'code')===(visual?'visual':'code')).at(-1)
      if(completedReview?.status!=='complete'){const interrupted=await quality.completionAction(ctx.signal);throw new ModelRequestRefusal(interrupted.halt?interrupted.gate!:'QUALITY_REVIEW_INTERRUPTED: 宿主审阅未完成，已保留现场，未追加制作请求。'+(summary??''))}
      // Reconcile new review bindings against the same candidate evidence before routing again.
      const checked=await verifySoftwareCandidate(input.projectId,input.requestId,ctx.signal)
      if(!locallyVerifiedSoftware(checked))return 'QUALITY_CLOSEOUT_CHECK_REQUIRED: '+JSON.stringify(verificationResponse(input.projectId,checked))
      const after = await quality.completionAction(ctx.signal)
      if (after.next_tool===action.next_tool && after.gate) {
        return after.feedback
      }
      if (!after.gate && after.next_tool === 'verify_app') return undefined
    }
  }
  try {
    for (;;) {
      runSignal.throwIfAborted()
      updateProject(input.projectId, { status: 'active', desktop_phase: 'desktop-implement', current_stage: 'generating_mvp', desktop_blocked: undefined })
      emit('stage_changed', { stage: 'desktop-implement' })
      let result: Awaited<ReturnType<typeof runAgentLoop>> | undefined, modelBudgetStop: string | undefined
      let hostCompleted=false
      if (initialBudgetStop) { modelBudgetStop = initialBudgetStop; initialBudgetStop = undefined }
      else try {
        // A resume of an unchanged verified candidate belongs to host closeout.
        // New instructions, images or changed inputs still enter the maker loop.
        if(initial&&continuation&&!input.images?.length&&!input.observedSoftwareVersion){
          let verified=await recentSoftwareVerification(input.projectId,input.requestId,runSignal)
          if(!verified&&recoveredTests){const checked=await verifySoftwareCandidate(input.projectId,input.requestId,runSignal);if(checked.status==='passed')verified=checked;else task+='\n'+JSON.stringify(verificationResponse(input.projectId,checked))}
          if(verified){
          if(!input.initialMessagePersisted){appendSessionMessage(input.sessionId,{role:'user',origin:'user',content:[{type:'text',text:input.content}],timestamp:Date.now()});input.initialMessagePersisted=true}
          const feedback=await advanceCloseout({projectId:input.projectId,sessionId:input.sessionId,requestId:input.requestId,signal:runSignal,state:createToolState()})
          if(feedback)task+='\n'+feedback;else hostCompleted=true
          }
        }
        if(!hostCompleted)result = await runAgentLoop({ runtimeScope: 'lean-build', system, task, query, env: input.env, tools,
        onRuntimeObservation: observeRuntime,
        projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, signal: runSignal,
        maxTokens: input.maxTokens, maxTurns, permissionMode: 'allow-all', workMode: 'implementation', executionScope: budget.executionScope,
        materials: sessionMaterials(input.projectId, input.sessionId), images: initial ? input.images : undefined,
        initialMessagePersisted: initial ? input.initialMessagePersisted : false,
        shouldPause: () => scopePending,
        beforeComplete: advanceCloseout,
        afterTools: async (ctx, calls) => {
          // Only an actual full verification for the exact current inputs
          // starts closeout. Partial stage checks and self-reported success do not.
          if(scopePending||!calls.some(c=>c.status==='ok'&&!c.pending&&['verify_app','inspect_app'].includes(c.name)))return
          const verified=await recentSoftwareVerification(input.projectId,input.requestId,ctx.signal)
          if(!verified)return
          const feedback = await advanceCloseout(ctx)
          return feedback ? { feedback,verification:verificationToolFeedback(verified) } : { complete: true,verification:verificationToolFeedback(verified) }
        }, recoveryContext: () => renderSoftwareWorkingContext(input.projectId), publish: emit }) }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const detailedError = monetaryFailure instanceof Error && reason.includes(monetaryFailure.message) ? monetaryFailure : error
        const admissionCode = detailedError instanceof Error ? detailedError.message : reason
        const admissionStopped = /^(?:HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED|REQUEST_BUDGET_EXHAUSTED|MONETARY_(?:BUDGET|OPERATION)_EXHAUSTED)$/.test(admissionCode)
        const registered = brief.lean_brief.ui === 'required' ? guiSuitePath(input.projectId) : cliSuitePath(input.projectId)
        if (runSignal.aborted || !admissionStopped || !existsSync(registered)) throw detailedError
        if(!continuation&&originalSource===softwareVerificationFingerprint(project.root_path)&&!(await recentSoftwareVerification(input.projectId,input.requestId,runSignal)))throw detailedError
        modelBudgetStop = reason
        emit('message_delta', { text: `${monetaryStopMessage(detailedError) ?? (admissionCode === 'MONETARY_OPERATION_EXHAUSTED' ? '当前操作的费用预留未放行请求，进度已保留。' : admissionCode === 'HARNESS_OUTPUT_BUDGET_EXHAUSTED' ? '当前累计输出额度未放行请求，进度已保留。' : '当前请求次数额度未放行请求，进度已保留。')}已有验收规则，我会停止模型调用，继续运行宿主检查；只有实际通过才交付。` })
      }
      initial = false
      if (scopePending) { checkpoint('waiting_user'); deps.complete(input.sessionId, input.projectId, 'incomplete'); return }
      if (!modelBudgetStop && !hostCompleted && result?.status !== 'completed') { blocked(result?.status === 'cancelled' ? '已停止，程序和现场已保留。' : `制作尚未完成（${result?.termination_detail?.reason ?? result?.status}），可沿当前现场继续。`, false, result?.status === 'cancelled' ? 'cancelled' : 'blocked'); return }
      // Integration checks own a quiet tree. Never race outstanding writers or dev servers.
      await settleSoftwareCommands(input.projectId, input.sessionId, runSignal)
      stopDelegations(input.sessionId)
      { await closeDebugSessions(input.projectId, input.sessionId); await stopSoftwareSession(input.projectId, input.sessionId); emit('software_preview_changed', { preview_url: null }) }
      await settleParentDelegationRuns(input.sessionId)
      updateProject(input.projectId, { desktop_phase: 'desktop-verify', current_stage: 'testing' })
      emit('stage_changed', { stage: 'desktop-verify' })
      const version = versionOf()
      if (!version || prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope) { blocked('验证前目标或文件版本发生变化，请沿当前版本继续。'); return }
      let candidate: Awaited<ReturnType<typeof prepareSoftwareRelease>> | undefined
      let core: CoreVerificationResult, failure: string | undefined, cleanEnvironmentPending = false, failureCategory = 'unknown', failureFingerprint: string | undefined
      if ((!deps.coreVerification) && !deps.securityScan && !deps.launchSmoke) {
        // The agent tool and final delivery share one verifier. Every fresh
        // attempt invalidates earlier receipts, including failures at closure.
        checkpoint('verifying', { source: softwareVerificationFingerprint(project.root_path) })
        const checked = await verifySoftwareCandidate(input.projectId, input.requestId, runSignal)
        if(checked.status==='unverified'&&checked.independent?.semantics?.ready===false){blocked(`独立案例的业务预期或覆盖声明尚待澄清，未将其记为产品失败，也未改动目标或冻结断言：\n${checked.summary}`,true);return}
        failureCategory=checked.failure?.category??'unknown'
        failureFingerprint=verificationToolFeedback(checked).fingerprint
        candidate = checked.candidate
        core = checked.core ?? { status: 'unverified', checked_at: new Date().toISOString(), summary: checked.summary, missing: [checked.summary], evidence: [] }
        cleanEnvironmentPending = checked.status === 'environment_blocked' && core.local_status === 'passed'
          && core.distribution?.status === 'environment_blocked' && checked.launch?.passed === true
        if (checked.status !== 'passed' && !cleanEnvironmentPending) failure = JSON.stringify(verificationResponse(input.projectId,checked))
        if (checked.launch) writeTextFileAtomic(join(project.root_path, '00_VERIFY/launch-smoke.json'), JSON.stringify(checked.launch, null, 2))
        checkpoint('verifying', { source: softwareVerificationFingerprint(project.root_path), candidateId: candidate?.id })
      } else {
        let preparationFailure: string | undefined
        {
          try { candidate = await prepareSoftwareRelease(input.projectId, project.root_path, runSignal) }
          catch (error) { runSignal.throwIfAborted(); preparationFailure = `发布候选未准备完成：${String(error)}` }
        }
        const checkRoot = candidate?.root ?? project.root_path
        const priorSecurity = (!preparationFailure)
          ? deps.securityScan ? deps.securityScan(input.projectId) : defaultQuickSecurityGate(input.projectId, checkRoot) : undefined
        checkpoint('verifying', { source: softwareVerificationFingerprint(project.root_path), candidateId: candidate?.id })
        core = preparationFailure ? { status: 'unverified', checked_at: new Date().toISOString(), summary: preparationFailure, missing: [preparationFailure], evidence: [] }
          : ((!priorSecurity?.passed || priorSecurity.blocking > 0)) ? { status: 'unverified', checked_at: new Date().toISOString(), summary: `执行产品前的静态检查未通过：${priorSecurity?.listing ?? '扫描未能完成'}`, missing: [], evidence: [] }
          : deps.coreVerification ? await deps.coreVerification(input.projectId, runSignal)
          : await runCoreVerification({ projectId: input.projectId, sandboxRoot: checkRoot, signal: runSignal, reuse: false })
        runSignal.throwIfAborted()
        cleanEnvironmentPending = (core.local_status === 'passed') && core.distribution?.status === 'environment_blocked'
        if (core.status !== 'passed' && !cleanEnvironmentPending) failure = `${core.summary}\n${core.missing.join('\n')}`
        else {
          const security = priorSecurity
          if (!security || !security.passed || security.blocking > 0) failure = `安全检查未通过或未执行：${security?.listing ?? '无有效证据'}`
          else {
            const declared = readLaunchDeclaration(checkRoot)
            const command = brief.lean_brief.ui === 'none' && declared?.ok && declared.launch.mode === 'command'
            const launch = deps.launchSmoke ? await deps.launchSmoke(input.projectId, runSignal) : command
              ? await runLaunchSmoke(checkRoot, { signal: runSignal, allowCleanExit: true }) : (await runLaunchSmoke(checkRoot, { signal: runSignal }))
            runSignal.throwIfAborted()
            writeTextFileAtomic(join(project.root_path, '00_VERIFY/launch-smoke.json'), JSON.stringify(launch, null, 2))
            if (brief.lean_brief.ui === 'required' && launch?.criteria?.degraded) { blocked('正常窗口验证环境不可用，程序已保留，未将仅存活检查当作交付通过。'); return }
            const browser = (brief.lean_brief.delivery === 'browser') && declared?.ok && declared.launch.ui === 'browser'
            const windowReady = brief.lean_brief.ui !== 'required' || browser && launch?.http_ready === true || launch?.criteria && launch.criteria.window_found && launch.criteria.responsive && launch.criteria.stable && launch.criteria.closed_gracefully
            if (!launch?.passed || !windowReady) failure = `正常启动未通过：${launch?.detail ?? '未执行或证据缺失'}\n${launch?.outputExcerpt ?? ''}`
          }
        }
      }
      runSignal.throwIfAborted()
      if (!failure && !modelBudgetStop) {
        failure = await advanceCloseout({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId,
          signal: runSignal, state: createToolState() }, true)
        if (failure) { failureCategory = 'quality'; failureFingerprint = undefined }
      }
      if (failure) {
        if (modelBudgetStop) { blocked(`${modelBudgetStop.startsWith('MONETARY_') ? '当前费用预留不足以放行下一次调用' : modelBudgetStop === 'HARNESS_OUTPUT_BUDGET_EXHAUSTED' ? '当前累计输出额度未放行调用' : '当前请求次数额度未放行调用'}，宿主检查未通过，未再调用模型：\n${failure}`); return }
        if (core.status === 'environment_blocked' && !cleanEnvironmentPending) { blocked(failure); return }
        {
          const progress = recordSoftwareRepair({ projectId: input.projectId, sessionId: input.sessionId, runId, error: failure,category:failureCategory, failureFingerprint,
            source: softwareVerificationFingerprint(project.root_path), candidateId: candidate?.id,
            observations: { gui: core.host_gui?.steps, cli: core.host_cli?.cases } })
          if (!progress.allowed) { blocked(`连续${progress.repeats}次验证得到相同失败观察，尚无可见改善，已停止自动重试并保留现场：\n${failure}`); return }
        }
        const attempt = consumeProjectAttempt(input.projectId, 'lean-repair', undefined)
        if (!attempt.allowed) { blocked(failure); return }
        emit('message_delta', { text: '验证发现具体缺口，我会沿当前现场局部修复。' })
        task = `宿主实际验证反馈（修复${attempt.used}${'，共享原请求与费用预算'}）：\n${failure}\n保留已正确实现，不改已确认目标或测试期望；核对失败入口后做最小修复。`
        continue
      }
      const qualityGap = await quality.gate(runSignal)
      if (qualityGap) { blocked(qualityGap); return }
      if (prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope || versionOf() !== version) {
        blocked('验证期间目标或产物发生变化，本次通过记录未用于交付。'); return
      }
      if (candidate) await verifyReleaseSource(candidate, runSignal)
      const text = `${modelBudgetStop ? '模型调用已停止；宿主沿已登记规则完成了实际验证。' : ''}已登记的本机案例、安全与启动检查通过，可从项目交付入口启动试用。完整需求效果尚未独立评定。${core.llm ? 'AI请求与异常分支已做本机HTTP检查，外部供应商连通与生成效果尚未实测。' : ''}继续修改可直接描述或点选。`
      return async () => {
        runSignal.throwIfAborted()
        const finalQualityGap = await quality.gate(runSignal)
        if (finalQualityGap) { blocked(finalQualityGap); return }
        if (prdScopeFingerprint(readPrdBackplane(input.projectId)) !== scope || versionOf() !== version) { blocked('收口前产物或验证输入发生变化，本次未交付。'); return }
        const persistCandidate = async (mode: 'seal' | 'trial' | 'deliver') => {
          if (!candidate) return
          const began = Date.now(); let accounted = false
          try {
            await (mode === 'seal' ? sealSoftwareRelease : promoteSoftwareRelease)(candidate,
              { version, scope, at: new Date().toISOString(), collaboration_id: readQualityLedger(input.projectId).collaboration?.at(-1)?.id }, runSignal,
              () => { budget.recordRuntime(Date.now() - began); accounted = true; return prdScopeFingerprint(readPrdBackplane(input.projectId)) === scope && versionOf() === version }, mode === 'deliver')
          } finally { if (!accounted) budget.recordRuntime(Date.now() - began) }
        }
        if (candidate) {
          if (isLongtermSoftware(input.projectId)) await persistCandidate('seal')
          else if (cleanEnvironmentPending) await persistCandidate('trial')
          saveSoftwareRegressionBaseline(input.projectId, version)
        }
        if (cleanEnvironmentPending) {
          blocked(`本机功能、安全及启动检查已通过，可以从交付入口试用。${core.distribution!.detail}`, false, 'waiting_environment')
          return
        }
        resetProjectAttemptScope(input.projectId, 'lean-repair')
        const report = join(candidate?.root ?? project.root_path, '00_VERIFY/core-verification.json')
        checkpoint('verified', { candidateId: candidate?.id, source: softwareVerificationFingerprint(project.root_path),
          ...(existsSync(report) ? { check: { path: report, sha256: createHash('sha256').update(readFileSync(report)).digest('hex') } } : {}) })
        if(candidate&&isLongtermSoftware(input.projectId)){
          stageLongtermMilestone(input.projectId,input.sessionId,input.requestId,candidate)
          emit('longterm_changed',{summary:findProject(input.projectId).longterm_summary})
          emit('user_decision_required',longtermPendingDecision(input.projectId,input.sessionId)!)
          const message='当前里程碑已登记的本机检查通过，可启动这个版本核对完整效果。确认本阶段后再决定下一轮；待办没有自动进入实现。'
          deps.persistAssistant(input.sessionId,message);emit('message_delta',{text:message});deps.complete(input.sessionId,input.projectId,'incomplete');return
        }
        if (candidate) await persistCandidate('deliver')
        else commitDesktopDelivery(input.projectId, runSignal)
        recordEvaluationEvent(input.projectId,'delivery_final',{status:'delivered',candidate_id:candidate?.id})
        emit('stage_changed', { stage: 'delivered' })
        deps.persistAssistant(input.sessionId, text); emit('message_delta', { text }); deps.complete(input.sessionId, input.projectId)
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const monetaryNotice = monetaryStopMessage(error)
    blocked(runSignal.aborted ? '执行已停止或到达运行时限，已有结果与用量记录保留。'
      : monetaryNotice ? `${reason}：${monetaryNotice}`
      : /^HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED$/.test(reason) ? leanBudgetStopMessage(input.projectId, 'desktop-implement', reason)
      : `当前执行受阻：${reason}`, reason.startsWith('QUALITY_INDEPENDENT_SEMANTICS_UNRESOLVED'), runSignal.aborted ? 'interrupted' : 'blocked')
  } finally {
    runSignal.removeEventListener('abort', cancelChildren)
    disposeParentDelegationState(input.sessionId)
    {
      const cleanup = await Promise.allSettled([closeDebugSessions(input.projectId, input.sessionId), stopSoftwareSession(input.projectId, input.sessionId), settleParentDelegationRuns(input.sessionId)])
      emit('software_preview_changed', { preview_url: null })
      const failed = cleanup.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
}
