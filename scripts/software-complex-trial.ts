import { resolveGenerationMaxTokens } from '../main/platform/llm/model-resolution'
import { execFileSync } from 'node:child_process'
import { inspectDocuments } from './complex-documents-acceptance'
import { inspectPrimary } from './complex-primary-acceptance'
import { fileURLToPath } from 'node:url'
import { writeTextFileAtomic } from '../storage/json-store'
import { app } from 'electron'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  if (!['preflight', 'run', 'resume', 'change', 'confirm', 'inspect', 'replan', 'approve-ux', 'retry-ux'].includes(phase) || !Object.hasOwn(tasks, which)) throw Error('TRIAL_PHASE_INVALID')
  const task = tasks[which as keyof typeof tasks], home = join(root, 'home'), profile = join(root, 'electron-profile')
  mkdirSync(home, { recursive: true }); mkdirSync(profile, { recursive: true })
  process.env.PROMA_HOME = home; process.env.BLOMA_DISPATCH_EXPERIMENT = '0'; delete process.env.BLOMA_EXPERIMENT_UNLIMITED_MONETARY
  cpSync(join(process.env.APPDATA!, 'bloma', 'Local State'), join(profile, 'Local State'))
  app.setPath('userData', profile); await app.whenReady()
  const source = join(homedir(), '.proma', 'bloma-channels.json'), copied = join(home, 'bloma-channels.json')
  cpSync(source, copied)
  const binding = resolveDelegationChannelOverride({ channelId: 'c0711f40-a244-4df1-96bd-b06a323b829e', modelId: 'deepseek-flash' })!
  if (binding.modelName !== 'deepseek-flash' || binding.env.ANTHROPIC_BASE_URL !== 'https://api.deepseek.com/anthropic') throw Error('TRIAL_ROUTE_CHANGED')
  const generationMaxTokens = resolveGenerationMaxTokens({ max_tokens: binding.maxTokens })
  const key = binding.env.ANTHROPIC_AUTH_TOKEN ?? binding.env.ANTHROPIC_API_KEY
  if (!key) throw Error('KEY_UNAVAILABLE')
  const safe = (v: unknown) => redactSoftwareOutput(JSON.stringify(v)).split(key).join('[REDACTED]')
  const get = async (path: string) => {
    const response = await fetch(`https://api.deepseek.com/${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error(`PREFLIGHT_HTTP_${response.status}`)
    return response.json() as Promise<any>
  }
  const manifestPath = join(root, 'manifest.json'), policy = join(root, 'monetary-policy.json')
  if (phase === 'preflight') {
    if (existsSync(manifestPath) || existsSync(policy)) throw Error('TRIAL_ALREADY_INITIALIZED')
    if (process.env.BLOMA_COMPLEX_TRIAL_AUTHORIZED_CAP !== '10') throw Error('EXPLICIT_TEN_RMB_AUTHORIZATION_REQUIRED')
    if (customCases && !process.env.BLOMA_COMPLEX_TRIAL_AUTHORIZATION_TEXT?.trim()) throw Error('NEW_TRIAL_AUTHORIZATION_TEXT_REQUIRED')
    const models = await get('models'), balance = await get('user/balance')
    const cny = balance.balance_infos?.find((r: any) => r.currency === 'CNY')
    if (!models.data?.some((r: any) => r.id === binding.modelName) || balance.is_available !== true || Number(cny?.total_balance) < 10) throw Error('MODEL_OR_BALANCE_UNAVAILABLE')
    const response = await fetch('https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error('PRICING_UNAVAILABLE')
    const pricing = await response.text(), compact = pricing.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
    if (!compact.includes('deepseek-flash') || !compact.includes('2元') || !compact.includes('8元') || !compact.includes('0.04元')) throw Error('PRICING_REVIEW_REQUIRED')
    writeFileSync(join(root, 'pricing.html'), pricing)
    const oldEpoch = join(process.env.LOCALAPPDATA!, 'Bloma', 'monetary-epochs', hash('api.deepseek.com\ndeepseek-flash') + '.json')
    const oldFiles = existsSync(oldEpoch) ? [oldEpoch, JSON.parse(readFileSync(oldEpoch, 'utf8')).policy_path] : []
    for (const p of [...oldFiles]) if (existsSync(p + '.state.json')) oldFiles.push(p + '.state.json')
    const rates = { host: 'api.deepseek.com', model: binding.modelName, cap_rmb: 10, context_tokens: 1048576, input_rmb_per_million: 2, output_rmb_per_million: 8, cache_rmb_per_million: .04 }
    writeFileSync(policy, JSON.stringify({ version: 1, models: [rates] }, null, 2))
    writeFileSync(manifestPath, JSON.stringify({ version: 1, at: new Date().toISOString(), source_head: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      authorization: { source: 'direct_user_confirmation', cap_rmb: 10, user_text: customCases ? process.env.BLOMA_COMPLEX_TRIAL_AUTHORIZATION_TEXT : '换一个大型一点的真实的任务，上限10元，你自己安排，可以多跑几种' },
      selector_sha256: hash(readFileSync(source)), policy_sha256: hash(readFileSync(policy)), rates, tasks,
      balance_before: cny.total_balance, model_catalog: models.data.map((r: any) => r.id),
      old_accounting: oldFiles.map(path => ({ path, sha256: hash(readFileSync(path)) })),
      boundaries: 'All tasks, changes, repairs and retries share one 10 RMB ledger. B disabled; existing same-model C/V remain. No product-side paid services or server-side search tools.' }, null, 2))
    console.log(safe({ status: 'ready', balance_rmb: cny.total_balance, cap_rmb: 10, model: binding.modelName, generation_requests: 0 })); return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.authorization?.cap_rmb !== 10 || JSON.stringify(manifest.tasks)!==JSON.stringify(tasks) || manifest.selector_sha256 !== hash(readFileSync(source)) || manifest.policy_sha256 !== hash(readFileSync(policy))) throw Error('TRIAL_AUTHORIZATION_OR_CONFIGURATION_CHANGED')
  for (const old of manifest.old_accounting) if (hash(readFileSync(old.path)) !== old.sha256) throw Error('OLD_ACCOUNTING_CHANGED')
  process.env.BLOMA_MONETARY_POLICY = policy; process.env.BLOMA_MONETARY_EPOCH_DIR = join(root, 'epochs')
  const existing = existsSync(policy + '.state.json') ? JSON.parse(readFileSync(policy + '.state.json', 'utf8')).entries.length : 0
  if (existing >= 512) throw Error('TRIAL_REQUEST_LIMIT')
  const money = () => {
    if (existsSync(policy + '.state.json')) return readMonetaryBudget(policy)
    if (existsSync(join(root,'generation-started'))) throw Error('TRIAL_ACCOUNTING_MISSING')
    return []
  }
  const control = createRequestBudget(binding.env, { requests: 512 - existing, outputTokens: generationMaxTokens, rmb: 10 })
  const paid = control.wrap(anthropicMessagesQueryViaProviders), signal = AbortSignal.timeout(45 * 60000)
  const query: SDKQuery = async function* (prompt, options) {
    if(existsSync(join(root,'pause-generation')))throw Error('TRIAL_PAUSED_BETWEEN_REQUESTS')
    writeFileSync(join(root,'generation-started'), 'started')
    const briefText: string[] = []
    try { for await (const message of paid(prompt, { ...options, monetaryPolicyPath: policy, thinkingLevel: 'low', signal: AbortSignal.any([options.signal, signal]),
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
  const taskDir = join(root, which); mkdirSync(taskDir, { recursive: true })
  const projectFile = join(taskDir, 'project.json')
  if (phase === 'run' && existsSync(projectFile)) throw Error('TRIAL_ALREADY_RAN_USE_RESUME')
  if (phase !== 'run' && !existsSync(projectFile)) throw Error('TRIAL_PROJECT_MISSING')
  const project = phase === 'run' ? createProject({ request_id: randomUUID(), mode: 'longterm', initial_message: task.name }, { workflowVersion: 'software-v1' }) : findProject(JSON.parse(readFileSync(projectFile, 'utf8')).project_id)
  const sid = `complex-${which}`, runId = randomUUID(), reportPath = join(taskDir, `${phase}-${runId}.json`)
  if (phase === 'run') writeFileSync(projectFile, JSON.stringify({ project_id: project.project_id, session_id: sid, root: project.root_path }))
  recordSessionActivity(sid, project.project_id)
  const report: any = { version: 1, phase, task: which, project_id: project.project_id, session_id: sid, started_at: new Date().toISOString(), status: 'running', paid_cap_rmb: 10, runtime_sha256: hash(readFileSync(fileURLToPath(import.meta.url))) }
  let lastSave=0
  const save = (force=false) => { if(!force&&Date.now()-lastSave<500)return; lastSave=Date.now();writeTextFileAtomic(reportPath, safe({ ...report, operation: control.snapshot(), money: money() })) }
  const cards: AgentEvent[] = []
  const event = (type: AgentEvent['type'], payload: Record<string, unknown>) => {
    if (type === 'user_decision_required') cards.push({ type, payload } as AgentEvent)
    appendFileSync(join(taskDir, 'events.jsonl'), safe({ at: new Date().toISOString(), phase, run_id: runId, type, payload }) + '\n')
    save()
  }
  const model = { query, env: binding.env, signal, sessionId: sid, history: [], maxTokens: generationMaxTokens,
    persistAssistant: (text: string) => appendSessionMessage(sid, { role: 'assistant', origin: 'agent', content: [{ type: 'text', text }], timestamp: Date.now() }) }
  try {
    save(true)
    if (phase === 'inspect') {
      report.independent=customCases?{status:'unverified',reason:'需按当前样本独立oracle执行实际交互；不使用旧任务的专用验收器冒充通过。'}:which==='primary'?await inspectPrimary(project.project_id,join(taskDir,'independent'),process.env.BLOMA_COMPLEX_REGRESSION==='1'):await inspectDocuments(project.project_id,join(taskDir,'independent'))
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
      await enterDesktopLine({ projectId: project.project_id, sessionId: sid, requestId: runId, content: '继续完成已确认目标，沿已有现场检查和修复。', maxTokens: generationMaxTokens, signal }, query, binding.env,
        { publish: (_target, type, payload) => event(type, payload), persistAssistant: (_sid, text) => model.persistAssistant(text), persistSystem: () => {}, complete: (_s, _p, result) => { report.completion = result } })
    }
    const final = findProject(project.project_id), state = readLongtermState(project.project_id)
    report.project_status = final.status; report.current_stage = final.current_stage; report.blocked = final.desktop_blocked
    report.longterm = state; report.release = (await activeSoftwareRelease(project.project_id))?.id; report.usage = readProjectUsage(project.project_id)
    report.status = report.release ? 'released_pending_independent_acceptance' : state?.milestones.find(m => m.id === state.current_id)?.status === 'awaiting_confirmation' ? 'host_checked_pending_independent_acceptance' : 'incomplete'
  } catch (error) { report.status = 'failed'; report.error = String(error) }
  finally {
    report.finished_at = new Date().toISOString()
    report.balance_after = (await get('user/balance').catch(() => undefined))?.balance_infos?.find((r: any) => r.currency === 'CNY')?.total_balance
    report.old_accounting_unchanged = manifest.old_accounting.every((r: any) => hash(readFileSync(r.path)) === r.sha256)
    save(true); console.log(safe({ status: report.status, money: money(), report: reportPath }))
  }
}
