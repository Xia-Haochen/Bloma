import { trialOutputCap } from './trial-output-cap'
import {trialResultStatus} from './trial-status'
import {createTrialRequestRecorder} from './trial-request-recorder'
import {softwareVerificationFingerprint} from '../main/desktop/verification-fingerprint'
import {readQualityLedger} from '../main/software/quality-ledger'
import {ModelRequestRefusal} from '../main/platform/llm/model-request-refusal'
import {verifyProjectStage} from '../main/software/project-stages'
import {inspectRetestDoodle} from './personal-doodle-retest-acceptance'
import {buildSoftwareVerifyTool} from '../main/software/verification-tool'
import {createSoftwareCollaborationPolicy} from '../main/software/collaboration-policy'
import {createQualityReview} from '../main/software/quality-review'
import {createToolState} from '../main/agent/loop/agent-loop'
import {runtimeInventory} from '../main/software/release-store'
import { leanBudget } from '../main/desktop/lean-budget'
import { inspectDoodleFaults } from './personal-doodle-fault-acceptance'
import { configureSoftwareExecutionLimits } from '../main/software/execution-limits'
import { inspectDoodle } from './personal-doodle-acceptance'
import { resolveGenerationMaxTokens } from '../main/platform/llm/model-resolution'
import { execFileSync } from 'node:child_process'
import { inspectDocuments } from './complex-documents-acceptance'
import { inspectPrimary } from './complex-primary-acceptance'
import { fileURLToPath } from 'node:url'
import { writeTextFileAtomic } from '../storage/json-store'
import { app } from 'electron'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveDelegationChannelOverride } from '../main/agent/delegation/delegation-channel'
import { anthropicMessagesQueryViaProviders } from '../main/platform/upstream/providers/loop-query'
import { createRequestBudget } from '../main/platform/llm/request-budget'
import { readMonetaryBudget } from '../main/platform/llm/monetary-budget'
import { createProject, findProject } from '../main/project/project-service'
import { readPrdBackplane } from '../main/project/prd-store'
import { handleGuideMessage } from '../main/guide/stages/guide-pipeline'
import { enterDesktopLine } from '../main/desktop/desktop-route'
import { readLongtermState } from '../main/software/longterm-state'
import { performLongtermAction } from '../main/software/longterm-control'
import { activeSoftwareRelease } from '../main/software/release-store'
import { readProjectUsage } from '../main/platform/llm/request-ledger'
import { redactSoftwareOutput } from '../main/software/process-manager'
import { recordSessionActivity } from '../main/platform/sessions/session-service'
import { appendSessionMessage } from '../main/platform/sessions/session-tree'
import type { AgentEvent } from '../shared/types'
import type { SDKQuery } from '../main/orchestration/stages/orchestration-contracts'

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const defaultTasks = {
  primary: {
    name: '社团活动与物资筹备台',
    goal: '做一个我能在本机浏览器里使用的社团活动筹备工具。我负责活动和公共物资，需要登记活动日期、地点、负责人和筹备状态；物资档案要有名称、总数量、借出数量和维修数量。可以为某场活动借出和分批归还物资，不能超出可用数量，维修中的数量不能借出，修改一个物品不能影响另一个。登记采购和实际开销并关联活动，按活动和月份汇总支出。物资清单可以从CSV导入，先预览并说明错误行，有错误时不提交半份数据；借还台账可以导出CSV。需要搜索和筛选，关闭软件再打开，所有记录和关联都保留。单人本机使用，不需要登录、联网服务或消息通知。先打通物资登记和借还，再补活动、采购和报表，但最终需要完整功能。界面简洁、信息清楚，你自行安排，不用草图。',
    change: '现在增加借用审批：新增借用先处于待审批状态，批准时才占用库存，可以拒绝；已产生的借用历史继续保留且原来的库存和统计不能改变。请保留所有已有功能，完成后检查借用、归还、维修和活动报表之间的关联。',
  },
  secondary: {
    name: '课程资料与阅读整理台',
    goal: '做一个本机课程资料整理工具，供我管理几门课程的PDF、Word和文本资料。可以批量导入，预览标题和来源，区分同名但内容不同的文件；单个坏文件要说明原因并让其他文件正常导入。可以按课程、标签和关键词找资料，查看原文片段及来源文件，修改标题、添加阅读笔记和完成状态，并导出资料目录与笔记。原文件不能被修改或删除。关闭重开后资料、笔记和标签都保留。用本机浏览器使用，不需要账号、联网AI或云同步。界面你安排，不用草图。',
    change: '增加按最近阅读时间筛选，保留已有笔记和来源关联。',
  },
}

function trialTasks(): Record<string, { name: string; goal: string; change: string }> {
  const path = process.env.BLOMA_COMPLEX_TRIAL_CASES
  if (!path) return defaultTasks
  const bytes = readFileSync(resolve(path)); if (bytes.length > 128 * 1024) throw Error('TRIAL_CASES_TOO_LARGE')
  const value = JSON.parse(bytes.toString('utf8'))
  if (!value || Array.isArray(value) || Object.keys(value).length < 1 || Object.keys(value).length > 4
    || Object.entries(value).some(([id, row]) => !/^[a-z0-9_-]{1,64}$/.test(id) || !row || typeof row !== 'object'
      || Object.keys(row).some(k => !['name','goal','change'].includes(k))
      || ['name','goal','change'].some(k => typeof (row as Record<string, unknown>)[k] !== 'string' || !String((row as Record<string, unknown>)[k]).trim()))) throw Error('TRIAL_CASES_INVALID')
  return value
}

/** Explicitly funded fresh run; preflight never calls a generation endpoint. */
export async function main() {
  if (!process.env.BLOMA_COMPLEX_TRIAL_ROOT) throw Error('TRIAL_ROOT_REQUIRED')
  const root = resolve(process.env.BLOMA_COMPLEX_TRIAL_ROOT), phase = process.env.BLOMA_COMPLEX_TRIAL_PHASE ?? 'preflight'
  const tasks = trialTasks(), customCases = Boolean(process.env.BLOMA_COMPLEX_TRIAL_CASES)
  const which = process.env.BLOMA_COMPLEX_TRIAL_TASK ?? Object.keys(tasks)[0]
  if (!['preflight', 'status', 'verify-current', 'verify-stage', 'run', 'resume', 'change', 'confirm', 'inspect', 'replan', 'approve-ux', 'retry-ux', 'extend-execution', 'inspect-faults'].includes(phase) || !Object.hasOwn(tasks, which)) throw Error('TRIAL_PHASE_INVALID')
  const task = tasks[which as keyof typeof tasks], home = join(root, 'home'), profile = join(root, 'electron-profile')
  mkdirSync(home, { recursive: true }); mkdirSync(profile, { recursive: true })
  process.env.PROMA_HOME = home; process.env.BLOMA_DISPATCH_EXPERIMENT = '0'; delete process.env.BLOMA_EXPERIMENT_UNLIMITED_MONETARY
  cpSync(join(process.env.APPDATA!, 'bloma', 'Local State'), join(profile, 'Local State'))
  app.setPath('userData', profile); await app.whenReady()
  const source = join(homedir(), '.proma', 'bloma-channels.json'), copied = join(home, 'bloma-channels.json')
  cpSync(source, copied)
  const binding = resolveDelegationChannelOverride({ channelId: 'c0711f40-a244-4df1-96bd-b06a323b829e', modelId: 'deepseek-flash' })!
  if (binding.modelName !== 'deepseek-flash' || binding.env.ANTHROPIC_BASE_URL !== 'https://api.deepseek.com/anthropic') throw Error('TRIAL_ROUTE_CHANGED')
  const trialThinking=process.env.BLOMA_COMPLEX_TRIAL_THINKING??'low'
  if(trialThinking!=='low'&&trialThinking!=='off')throw Error('TRIAL_THINKING_MODE_INVALID')
  binding.env.BLOMA_LOOP_THINKING=trialThinking
  const generationMaxTokens = resolveGenerationMaxTokens({ max_tokens: binding.maxTokens })
  const key = binding.env.ANTHROPIC_AUTH_TOKEN ?? binding.env.ANTHROPIC_API_KEY
  if (!key) throw Error('KEY_UNAVAILABLE')
  const safe = (v: unknown) => redactSoftwareOutput(JSON.stringify(v)).split(key).join('[REDACTED]')
  const get = async (path: string) => {
    const response = await fetch(`https://api.deepseek.com/${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error(`PREFLIGHT_HTTP_${response.status}`)
    return response.json() as Promise<any>
  }
  const windowId = process.env.BLOMA_COMPLEX_TRIAL_WINDOW ?? ''
  if (windowId && !/^[a-z0-9-]{1,60}$/.test(windowId)) throw Error('TRIAL_WINDOW_INVALID')
  const suffix = windowId ? '-' + windowId : ''
  const manifestPath = join(root, 'manifest' + suffix + '.json'), policy = join(root, 'monetary-policy' + suffix + '.json'), startedMarker = join(root, 'generation-started' + suffix)
  const capRmb = phase === 'preflight' ? Number(process.env.BLOMA_COMPLEX_TRIAL_AUTHORIZED_CAP) : JSON.parse(readFileSync(manifestPath, 'utf8')).authorization?.cap_rmb
  if (typeof capRmb !== 'number' || !Number.isFinite(capRmb) || capRmb <= 0 || !Number.isSafeInteger(Math.round(capRmb * 1e6))) throw Error('EXPLICIT_RMB_AUTHORIZATION_REQUIRED')
  if (phase === 'preflight') {
    if (existsSync(manifestPath) || existsSync(policy)) throw Error('TRIAL_ALREADY_INITIALIZED')
    if ((customCases || windowId || capRmb !== 10) && !process.env.BLOMA_COMPLEX_TRIAL_AUTHORIZATION_TEXT?.trim()) throw Error('NEW_TRIAL_AUTHORIZATION_TEXT_REQUIRED')
    const models = await get('models'), balance = await get('user/balance')
    const cny = balance.balance_infos?.find((r: any) => r.currency === 'CNY')
    if (!models.data?.some((r: any) => r.id === binding.modelName) || balance.is_available !== true || Number(cny?.total_balance) < capRmb) throw Error('MODEL_OR_BALANCE_UNAVAILABLE')
    const response = await fetch('https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error('PRICING_UNAVAILABLE')
    const pricing = await response.text(), compact = pricing.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
    if (!compact.includes('deepseek-flash') || !compact.includes('2元') || !compact.includes('8元') || !compact.includes('0.04元')) throw Error('PRICING_REVIEW_REQUIRED')
    const pricingPath=join(root,'pricing'+suffix+'.html')
    writeFileSync(pricingPath, pricing)
    const oldEpoch = join(process.env.LOCALAPPDATA!, 'Bloma', 'monetary-epochs', hash('api.deepseek.com\ndeepseek-flash') + '.json')
    const oldFiles = existsSync(oldEpoch) ? [oldEpoch, JSON.parse(readFileSync(oldEpoch, 'utf8')).policy_path] : []
    if (windowId) for (const name of readdirSync(root).filter(name => /^monetary-policy(?:-[a-z0-9-]+)?\.json$/.test(name))) { const prior = join(root, name); if (prior !== policy) oldFiles.push(prior) }
    for (const p of [...oldFiles]) if (existsSync(p + '.state.json')) oldFiles.push(p + '.state.json')
    const rates = { host: 'api.deepseek.com', model: binding.modelName, cap_rmb: capRmb, context_tokens: 1048576, input_rmb_per_million: 2, output_rmb_per_million: 8, cache_rmb_per_million: .04 }
    trialOutputCap(capRmb, generationMaxTokens, rates)
    writeFileSync(policy, JSON.stringify({ version: 1, models: [rates] }, null, 2))
    writeFileSync(manifestPath, JSON.stringify({ version: 1, at: new Date().toISOString(), source_head: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      authorization: { source: 'direct_user_confirmation', cap_rmb: capRmb, user_text: (customCases || windowId || capRmb !== 10) ? process.env.BLOMA_COMPLEX_TRIAL_AUTHORIZATION_TEXT : '换一个大型一点的真实的任务，上限10元，你自己安排，可以多跑几种' },
      selector_sha256: hash(readFileSync(source)), policy_sha256: hash(readFileSync(policy)), pricing_path:pricingPath,pricing_sha256:hash(pricing),rates, tasks,
      balance_before: cny.total_balance, model_catalog: models.data.map((r: any) => r.id),
      old_accounting: oldFiles.map(path => ({ path, sha256: hash(readFileSync(path)) })),
      boundaries: `All tasks, changes, repairs and retries share one ${capRmb} RMB window. Previous policies and ledgers are preserved; B disabled. No product-side paid services or server-side search tools.` }, null, 2))
    console.log(safe({ status: 'ready', balance_rmb: cny.total_balance, cap_rmb: capRmb, model: binding.modelName, generation_requests: 0 })); return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.aggregation_status && manifest.aggregation_status !== 'active') throw Error('TRIAL_MERGE_NOT_ACTIVE')
  if (manifest.authorization?.cap_rmb !== capRmb || JSON.stringify(manifest.tasks)!==JSON.stringify(tasks) || manifest.selector_sha256 !== hash(readFileSync(source)) || manifest.policy_sha256 !== hash(readFileSync(policy))) throw Error('TRIAL_AUTHORIZATION_OR_CONFIGURATION_CHANGED')
  if(manifest.pricing_path&&hash(readFileSync(manifest.pricing_path))!==manifest.pricing_sha256)throw Error('TRIAL_PRICING_EVIDENCE_CHANGED')
  const policyRate = JSON.parse(readFileSync(policy, 'utf8')).models.find((r: any) => r.host === 'api.deepseek.com' && r.model === binding.modelName)
  if (!policyRate || policyRate.cap_rmb !== capRmb) throw Error('TRIAL_POLICY_CAP_MISMATCH')
  const requestMaxTokens = trialOutputCap(capRmb, generationMaxTokens, policyRate)
  for (const old of manifest.old_accounting) if (hash(readFileSync(old.path)) !== old.sha256) throw Error('OLD_ACCOUNTING_CHANGED')
  process.env.BLOMA_MONETARY_POLICY = policy; process.env.BLOMA_MONETARY_EPOCH_DIR = windowId ? join(root, 'epochs', windowId) : join(root, 'epochs')
  const existing = existsSync(policy + '.state.json') ? JSON.parse(readFileSync(policy + '.state.json', 'utf8')).entries.length : 0
  const requestLimit = manifest.execution_request_limit ?? 512
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 4096) throw Error('TRIAL_REQUEST_LIMIT_INVALID')
  if (existing >= requestLimit) throw Error('TRIAL_REQUEST_LIMIT')
  const money = () => {
    if (existsSync(policy + '.state.json')) return readMonetaryBudget(policy)
    if (existsSync(startedMarker)) throw Error('TRIAL_ACCOUNTING_MISSING')
    return []
  }
  const control = createRequestBudget(binding.env, { requests: requestLimit - existing, outputTokens: requestMaxTokens, rmb: capRmb })
  let latestStage:string|undefined
  const trace=createTrialRequestRecorder(join(root,'trace'),safe,session=>{
    try{const p=findProject(project.project_id);return{project_id:p.project_id,status:p.status,current_stage:latestStage??p.current_stage,persisted_stage:p.current_stage,desktop_phase:p.desktop_phase,source:softwareVerificationFingerprint(p.root_path),review_kind:readQualityLedger(p.project_id).reviews.find(r=>r.child===session)?.kind}}catch{return{phase}}
  },policyRate)
  const paid = control.wrap(anthropicMessagesQueryViaProviders), signal = AbortSignal.timeout(45 * 60000)
  const rawQuery: SDKQuery = async function* (prompt, options) {
    if(existsSync(join(root,'pause-generation')))throw new ModelRequestRefusal('TRIAL_PAUSED_BETWEEN_REQUESTS')
    writeFileSync(startedMarker, 'started')
    const briefText: string[] = []
    try { for await (const message of paid(prompt, { ...options, monetaryPolicyPath: policy, thinkingLevel: trialThinking, signal: AbortSignal.any([options.signal, signal]),
      requestGuard: request => {
        options.requestGuard?.(request)
        const body = JSON.parse(request.body)
        const wireSystems = body.system ?? (body.messages ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content)
        appendFileSync(join(root, 'request-shapes.jsonl'), JSON.stringify({ at: new Date().toISOString(), task: which, phase, state: 'prepared_not_proof_of_send', requested_max_tokens: options.maxTokens, wire_max_tokens: body.max_tokens, system_sha256: hash(JSON.stringify(wireSystems)), system_bytes: Buffer.byteLength(JSON.stringify(wireSystems)), body_bytes: Buffer.byteLength(request.body), thinking: body.thinking?.type }) + '\n')
        if ((body.tools ?? []).some((t: any) => t.type && !['custom','function'].includes(t.type))) throw Error('SERVER_SIDE_PAID_TOOLS_NOT_AUTHORIZED')
      } })) {
      if (options.accounting?.role === 'brief' && message.type === 'assistant' && message.message) {
        for (const block of message.message.content) if (block.type === 'text' && typeof block.text === 'string') briefText.push(block.text)
      }
      yield message
    } } finally { if (options.accounting?.role === 'brief') writeFileSync(join(root,`${which}-brief-${randomUUID()}.json`),safe({text:briefText.join('')})) }
  }
  const query:SDKQuery=trace.wrap(rawQuery,phase)
  const taskDir = join(root, which); mkdirSync(taskDir, { recursive: true })
  const projectFile = join(taskDir, 'project.json')
  if (phase === 'run' && existsSync(projectFile)) throw Error('TRIAL_ALREADY_RAN_USE_RESUME')
  if (phase !== 'run' && !existsSync(projectFile)) throw Error('TRIAL_PROJECT_MISSING')
  const project = phase === 'run' ? createProject({ request_id: randomUUID(), mode: 'longterm', initial_message: task.name }, { workflowVersion: 'software-v1' }) : findProject(JSON.parse(readFileSync(projectFile, 'utf8')).project_id)
  const sid = `complex-${which}`, runId = randomUUID(), reportPath = join(taskDir, `${phase}-${runId}.json`)
  if (phase === 'run') writeFileSync(projectFile, JSON.stringify({ project_id: project.project_id, session_id: sid, root: project.root_path }))
  recordSessionActivity(sid, project.project_id)
  const report: any = { version: 1, phase, task: which, project_id: project.project_id, session_id: sid, started_at: new Date().toISOString(), status: 'running', paid_cap_rmb: capRmb, budget_window: windowId || 'initial', thinking_mode:trialThinking, runtime_sha256: hash(readFileSync(fileURLToPath(import.meta.url))) }
  let lastSave=0
  const save = (force=false) => { if(!force&&Date.now()-lastSave<500)return; lastSave=Date.now();writeTextFileAtomic(reportPath, safe({ ...report, operation: control.snapshot(), money: money() })) }
  const cards: AgentEvent[] = []
  const observerFailures=new Map<string,number>()
  const event = (type: AgentEvent['type'], payload: Record<string, unknown>) => {
    if(type==='thinking_delta')return
    if(type==='stage_changed'&&typeof payload.stage==='string')latestStage=payload.stage
    trace.event(type,{...payload,phase,run_id:runId})
    if(type==='tool_call_completed'){
      const tool=String(payload.tool)
      if(payload.is_error===false)for(const k of observerFailures.keys())if(k.startsWith(tool+':'))observerFailures.delete(k)
      const code=payload.is_error===true?String(payload.output_summary??'').match(/\b(?:PROJECT_STAGE|GUI_NATIVE|QUALITY|MONETARY|SOFTWARE|REQUEST|HARNESS)_[A-Z_]+\b/)?.[0]:undefined
      if(code){const k=tool+':'+code,n=(observerFailures.get(k)??0)+1;observerFailures.set(k,n);if(n===3){
        writeFileSync(join(root,'pause-generation'),'Observer pause after repeated host contract refusal: '+k)
        trace.event('observer_pause',{cause:k,repeated:n,action:'stop_before_next_model_request',source:'trial_supervisor_not_product_pass'})
      }}
    }
    if (type === 'user_decision_required') cards.push({ type, payload } as AgentEvent)
    appendFileSync(join(taskDir, 'events.jsonl'), safe({ at: new Date().toISOString(), phase, run_id: runId, type, payload }) + '\n')
    save()
  }
  const model = { query, env: binding.env, signal, sessionId: sid, history: [], maxTokens: requestMaxTokens,
    persistAssistant: (text: string) => appendSessionMessage(sid, { role: 'assistant', origin: 'agent', content: [{ type: 'text', text }], timestamp: Date.now() }) }
  try {
    save(true)
    if(phase==='status'){
      report.execution_budget=leanBudget(project.project_id,'desktop-implement').snapshot()
    }else if(phase==='verify-current'){
      const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,sid),ctx={projectId:project.project_id,sessionId:sid,requestId:runId,signal,state:createToolState()}
      const result=await buildSoftwareVerifyTool(project.project_id,policy).execute({script:process.env.BLOMA_TRIAL_VERIFY_SCRIPT,restart:process.env.BLOMA_TRIAL_VERIFY_RESTART==='1'},ctx)
      report.host_verification={is_error:result.isError===true,result:JSON.parse(result.output),feedback:result.feedback};trace.event('observer_full_verification',report.host_verification)
      if(!result.isError&&process.env.BLOMA_TRIAL_FINDINGS_FILE){
        const cases=JSON.parse(readFileSync(process.env.BLOMA_TRIAL_FINDINGS_FILE,'utf8')),quality=createQualityReview(project.project_id,sid,policy),check=quality.parentTools.find(t=>t.name==='check_quality_finding')!
        report.finding_checks=[]
        for(const input of cases){const checked=await check.execute(input,ctx);report.finding_checks.push({is_error:checked.isError,result:JSON.parse(checked.output)});trace.event('observer_finding_check',report.finding_checks.at(-1))}
      }
    }else if(phase==='verify-stage'){
      if(!process.env.BLOMA_TRIAL_STAGE||!process.env.BLOMA_TRIAL_STAGE_SCRIPT)throw Error('TRIAL_STAGE_INPUT_REQUIRED')
      report.stage_verification=await verifyProjectStage(project.project_id,process.env.BLOMA_TRIAL_STAGE,process.env.BLOMA_TRIAL_STAGE_SCRIPT,signal)
      trace.event('observer_stage_verification',{stage:process.env.BLOMA_TRIAL_STAGE,result:report.stage_verification,source:'independent_host_run_no_model'})
    } else if (phase === 'inspect-faults') {
      if (which !== 'interaction-doodle') throw Error('FAULT_ADAPTER_NOT_AVAILABLE')
      report.independent = await inspectDoodleFaults(project.project_id, join(taskDir, 'independent'))
    } else if(phase==='inspect'&&process.env.BLOMA_TRIAL_UI_ADAPTER==='retest-doodle'){
      report.independent=await inspectRetestDoodle(project.project_id,join(taskDir,'independent'),process.env.BLOMA_TRIAL_MUTE_SELECTOR,process.env.BLOMA_TRIAL_BASELINE_DATA,process.env.BLOMA_TRIAL_MUTE_SOUND_SELECTOR)
    } else if (phase === 'inspect') {
      report.independent=customCases?which==='interaction-doodle'?await inspectDoodle(project.project_id,join(taskDir,'independent')):{status:'unverified',reason:'需按当前样本独立oracle执行实际交互；不使用旧任务的专用验收器冒充通过。'}:which==='primary'?await inspectPrimary(project.project_id,join(taskDir,'independent'),process.env.BLOMA_COMPLEX_REGRESSION==='1'):await inspectDocuments(project.project_id,join(taskDir,'independent'))
    } else if (phase === 'extend-execution') {
      if (process.env.BLOMA_COMPLEX_TRIAL_CONTINUATION_AUTH !== 'same-money-cap') throw Error('EXECUTION_CONTINUATION_AUTH_REQUIRED')
      const execution = leanBudget(project.project_id, 'desktop-implement').snapshot()
      report.execution_limits = configureSoftwareExecutionLimits(project.project_id, project.lean_operation_id ?? 'initial', {requests:Math.max(execution.limits.requests,execution.requests+256),output:Math.max(execution.limits.output,execution.output+1048576),reason:'用户授权诊断后继续完整流程；保留原operation请求/输出计量，当前已授权计费窗口上限为'+capRmb+'元，旧账本保持不变。'})
    } else if (phase === 'retry-ux') {
      await handleGuideMessage({ project_id: project.project_id, session_id: sid, request_id: runId, mode: 'longterm', current_stage: 'blocked_for_user_decision', content: '重新生成草图', metadata: { source: 'card_option', selected_option_id: 'ux_retry' } }, e => event(e.type, e.payload), model)
    } else if (phase === 'approve-ux') {
      report.ux_confirmation = 'actual persisted UX card; trial operator reviewed preview before confirmation'
      await handleGuideMessage({ project_id: project.project_id, session_id: sid, request_id: runId, mode: 'longterm', current_stage: 'blocked_for_user_decision', content: '按草图开工', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } }, e => event(e.type, e.payload), model)
    } else if (phase === 'confirm') {
      const state = readLongtermState(project.project_id)
      if (!state) throw Error('MILESTONE_MISSING')
      report.confirmation = await performLongtermAction({ request_id: runId, project_id: project.project_id, session_id: sid, revision: state.revision, action: 'confirm' }, signal, { busy: false, emit: event })
    } else if (phase === 'run' || phase === 'change' || phase === 'replan' || !readPrdBackplane(project.project_id).user_confirmed_at) {
      const content = phase === 'change' ? task.change : task.goal
      const input = { project_id: project.project_id, session_id: sid, request_id: runId, mode: 'longterm' as const, current_stage: 'clarifying' as const, content }
      appendSessionMessage(sid, { role: 'user', origin: 'user', content: [{ type: 'text', text: content }], timestamp: Date.now() })
      await handleGuideMessage(input, e => event(e.type, e.payload), model)
      const scope = cards.find(e => e.payload.kind === 'lean_scope')
      const option = (scope?.payload.questions as Array<{ id: string }> | undefined)?.find(q => q.id.startsWith('lean_confirm:'))
      if (option) {
        report.scope_confirmation = 'actual generated scope card; bounded trial operator approves ordinary business scope'
        report.confirmed_brief = readPrdBackplane(project.project_id)
        await handleGuideMessage({ ...input, request_id: randomUUID(), content: '按这份做', metadata: { source: 'card_option', selected_option_id: option.id } }, e => event(e.type, e.payload), model)
      }
    } else {
      await enterDesktopLine({ projectId: project.project_id, sessionId: sid, requestId: runId, content: process.env.BLOMA_COMPLEX_TRIAL_FEEDBACK_FILE ? readFileSync(resolve(process.env.BLOMA_COMPLEX_TRIAL_FEEDBACK_FILE), 'utf8') : '继续完成已确认目标，沿已有现场检查和修复。', maxTokens: requestMaxTokens, signal }, query, binding.env,
        { publish: (_target, type, payload) => event(type, payload), persistAssistant: (_sid, text) => model.persistAssistant(text), persistSystem: () => {}, complete: (_s, _p, result) => { report.completion = result } })
    }
    const final = findProject(project.project_id), state = readLongtermState(project.project_id)
    report.project_status = final.status; report.current_stage = final.current_stage; report.blocked = final.desktop_blocked
    report.longterm = state; report.release = (await activeSoftwareRelease(project.project_id))?.id; report.usage = readProjectUsage(project.project_id)
    const milestone=state?.milestones.find(m=>m.id===state.current_id),source=(await runtimeInventory(final.root_path)).digest
    report.current_source_matches_milestone=source===milestone?.source_digest
    report.status = trialResultStatus({...report,milestone_status:milestone?.status,source_matches_milestone:report.current_source_matches_milestone})
  } catch (error) { report.status = 'failed'; report.error = String(error) }
  finally {
    trace.finish()
    report.finished_at = new Date().toISOString()
    report.balance_after = (await get('user/balance').catch(() => undefined))?.balance_infos?.find((r: any) => r.currency === 'CNY')?.total_balance
    report.old_accounting_unchanged = manifest.old_accounting.every((r: any) => hash(readFileSync(r.path)) === r.sha256)
    save(true); console.log(safe({ status: report.status, money: money(), report: reportPath }))
  }
}
