import {loadUserTestFiles} from './user-test-files'
import { trialOutputCap } from './trial-output-cap'
import {createTrialRequestRecorder} from './trial-request-recorder'
import {softwareVerificationFingerprint} from '../main/desktop/verification-fingerprint'
import {readQualityLedger} from '../main/software/quality-ledger'
import {ModelRequestRefusal} from '../main/platform/llm/model-request-refusal'
import { resolveGenerationMaxTokens } from '../main/platform/llm/model-resolution'
import { execFileSync } from 'node:child_process'
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
import { handleGuideMessage } from '../main/guide/stages/guide-pipeline'
import { activeSoftwareRelease } from '../main/software/release-store'
import { readProjectUsage } from '../main/platform/llm/request-ledger'
import { redactSoftwareOutput } from '../main/software/process-manager'
import { recordSessionActivity } from '../main/platform/sessions/session-service'
import { appendSessionMessage } from '../main/platform/sessions/session-tree'
import type { AgentEvent } from '../shared/types'
import type { SDKQuery } from '../main/orchestration/stages/orchestration-contracts'
import {simulateUserSession,decideAsUser} from './simulated-user'
import {enterDesktopLine} from '../main/desktop/desktop-route'
import {SimulatedUserSurface} from './simulated-user-surface'
import {assertSimulatedContinuation,observationBalance,readObservationQuote,claimObservationRun,requireObservationPhase,assertFrozenObservation,observeOneTurn,observationOutcome} from './observation-control'
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
function trialTasks(): Record<string, { name: string; goal: string; change?: string }> {
  const path = process.env.BLOMA_OBSERVATION_CASES
  if (!path) throw Error('OBSERVATION_CASE_REQUIRED')
  const bytes = readFileSync(resolve(path)); if (bytes.length > 128 * 1024) throw Error('TRIAL_CASES_TOO_LARGE')
  const value = JSON.parse(bytes.toString('utf8'))
  if (!value || Array.isArray(value) || Object.keys(value).length !== 1
    || Object.entries(value).some(([id, row]) => !/^[a-z0-9_-]{1,64}$/.test(id) || !row || typeof row !== 'object'
      || Object.keys(row).some(k => !['name','goal','change'].includes(k))
      || ['name','goal'].some(k => typeof (row as Record<string, unknown>)[k] !== 'string' || !String((row as Record<string, unknown>)[k]).trim()))) throw Error('TRIAL_CASES_INVALID')
  return value
}

/** Explicitly funded fresh run; preflight never calls a generation endpoint. */
export async function main() {
  if (!process.env.BLOMA_OBSERVATION_ROOT) throw Error('TRIAL_ROOT_REQUIRED')
  const root = resolve(process.env.BLOMA_OBSERVATION_ROOT), phase = process.env.BLOMA_OBSERVATION_PHASE ?? ''
  const tasks = trialTasks()
  const which = process.env.BLOMA_OBSERVATION_TASK ?? Object.keys(tasks)[0]
  requireObservationPhase(phase)
  if(!Object.hasOwn(tasks,which))throw Error('OBSERVATION_TASK_INVALID')
  const runtimeHash=hash(readFileSync(fileURLToPath(import.meta.url)))
  const thinking=process.env.BLOMA_OBSERVATION_THINKING??'low'
  const runtimeTree=process.env.BLOMA_OBSERVATION_RUNTIME_DIGEST
  if(!runtimeTree)throw Error('OBSERVATION_PREPARED_RUNTIME_REQUIRED')
  const continuation=phase==='simulate'?assertSimulatedContinuation(root,thinking,runtimeTree):undefined
  if(phase==='run')assertFrozenObservation(root,runtimeHash,thinking,runtimeTree)
  else if(phase!=='simulate'&&(existsSync(join(root,'home'))||existsSync(join(root,'manifest.json'))))throw Error('OBSERVATION_ROOT_NOT_FRESH')
  const task = tasks[which as keyof typeof tasks], home = join(root, 'home'), profile = join(root, 'electron-profile')
  mkdirSync(home, { recursive: true }); mkdirSync(profile, { recursive: true })
  process.env.PROMA_HOME = home; process.env.BLOMA_DISPATCH_EXPERIMENT = '0'; delete process.env.BLOMA_EXPERIMENT_UNLIMITED_MONETARY
  cpSync(join(process.env.APPDATA!, 'bloma', 'Local State'), join(profile, 'Local State'))
  app.setPath('userData', profile); await app.whenReady()
  const source = join(homedir(), '.proma', 'bloma-channels.json'), copied = join(home, 'bloma-channels.json')
  cpSync(source, copied)
  const binding = resolveDelegationChannelOverride({ channelId: 'c0711f40-a244-4df1-96bd-b06a323b829e', modelId: 'deepseek-flash' })!
  if (binding.modelName !== 'deepseek-flash' || binding.env.ANTHROPIC_BASE_URL !== 'https://api.deepseek.com/anthropic') throw Error('TRIAL_ROUTE_CHANGED')
  const trialThinking=process.env.BLOMA_OBSERVATION_THINKING??'low'
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
  const manifestPath=join(root,'manifest.json'),policy=join(root,'monetary-policy.json'),startedMarker=join(root,'generation-started')
  const capRmb = phase === 'preflight' ? Number(process.env.BLOMA_OBSERVATION_AUTHORIZED_CAP) : JSON.parse(readFileSync(manifestPath, 'utf8')).authorization?.cap_rmb
  if (typeof capRmb !== 'number' || !Number.isFinite(capRmb) || capRmb <= 0 || !Number.isSafeInteger(Math.round(capRmb * 1e6))) throw Error('EXPLICIT_RMB_AUTHORIZATION_REQUIRED')
  if (phase === 'preflight') {
    if (existsSync(manifestPath) || existsSync(policy)) throw Error('TRIAL_ALREADY_INITIALIZED')
    if (!process.env.BLOMA_OBSERVATION_AUTHORIZATION_TEXT?.trim()) throw Error('NEW_TRIAL_AUTHORIZATION_TEXT_REQUIRED')
    const models = await get('models'), balance = await get('user/balance')
    const availableBalance=observationBalance(models,balance,capRmb)
    const quoteFile=process.env.BLOMA_OBSERVATION_QUOTE_FILE
    if(!quoteFile)throw Error('OBSERVATION_QUOTE_REVIEW_REQUIRED')
    const {quote,source:pricing}=readObservationQuote(resolve(quoteFile))
    const pricingPath=join(root,'pricing.html')
    writeFileSync(pricingPath,pricing,{flag:'wx'})
    const oldEpoch = join(process.env.LOCALAPPDATA!, 'Bloma', 'monetary-epochs', hash('api.deepseek.com\ndeepseek-flash') + '.json')
    const oldFiles = existsSync(oldEpoch) ? [oldEpoch, JSON.parse(readFileSync(oldEpoch, 'utf8')).policy_path] : []
    for (const p of [...oldFiles]) if (existsSync(p + '.state.json')) oldFiles.push(p + '.state.json')
    const rates = {host:quote.host,model:quote.model,cap_rmb:capRmb,context_tokens:quote.context_tokens,input_rmb_per_million:quote.input_rmb_per_million,output_rmb_per_million:quote.output_rmb_per_million,cache_rmb_per_million:quote.cache_rmb_per_million}
    trialOutputCap(capRmb, generationMaxTokens, rates)
    writeFileSync(policy, JSON.stringify({ version: 1, models: [rates] }, null, 2))
    writeFileSync(manifestPath, JSON.stringify({ version: 1, at: new Date().toISOString(), source_head: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      runtime_sha256:runtimeHash,runtime_tree_sha256:runtimeTree,thinking:trialThinking,authorization: { source: 'direct_user_confirmation', cap_rmb: capRmb, user_text: process.env.BLOMA_OBSERVATION_AUTHORIZATION_TEXT },
      selector_sha256: hash(readFileSync(source)), policy_sha256: hash(readFileSync(policy)), pricing_path:pricingPath,pricing_sha256:hash(pricing),quote_reviewed_at:quote.reviewed_at,pricing_source_url:quote.source_url,rates, tasks,user_files_sha256:existsSync(join(root,'user-files.json'))?hash(readFileSync(join(root,'user-files.json'))):null,
      balance_before: availableBalance, model_catalog: models.data.map((r: any) => r.id),
      old_accounting: oldFiles.map(path => ({ path, sha256: hash(readFileSync(path)) })),
      boundaries: `One original request and product-native execution share one ${capRmb} RMB window. Previous policies and ledgers are preserved; B disabled. No product-side paid services or server-side search tools.` }, null, 2))
    console.log(safe({ status: 'ready', balance_rmb: availableBalance, cap_rmb: capRmb, model: binding.modelName, generation_requests: 0 })); return
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.authorization?.cap_rmb !== capRmb || JSON.stringify(manifest.tasks)!==JSON.stringify(tasks) || manifest.selector_sha256 !== hash(readFileSync(source)) || manifest.policy_sha256 !== hash(readFileSync(policy))) throw Error('TRIAL_AUTHORIZATION_OR_CONFIGURATION_CHANGED')
  if(manifest.pricing_path&&hash(readFileSync(manifest.pricing_path))!==manifest.pricing_sha256)throw Error('TRIAL_PRICING_EVIDENCE_CHANGED')
  if((manifest.user_files_sha256??null)!==(existsSync(join(root,'user-files.json'))?hash(readFileSync(join(root,'user-files.json'))):null))throw Error('USER_TEST_FILES_CHANGED')
  const userFiles=loadUserTestFiles(root)
  const policyRate = JSON.parse(readFileSync(policy, 'utf8')).models.find((r: any) => r.host === 'api.deepseek.com' && r.model === binding.modelName)
  if (!policyRate || policyRate.cap_rmb !== capRmb) throw Error('TRIAL_POLICY_CAP_MISMATCH')
  const requestMaxTokens = trialOutputCap(capRmb, generationMaxTokens, policyRate)
  for (const old of manifest.old_accounting) if (hash(readFileSync(old.path)) !== old.sha256) throw Error('OLD_ACCOUNTING_CHANGED')
  process.env.BLOMA_MONETARY_POLICY = policy; process.env.BLOMA_MONETARY_EPOCH_DIR = join(root, 'epochs')
  if(!continuation&&existsSync(policy+'.state.json'))throw Error('OBSERVATION_LEDGER_NOT_FRESH')
  const existingRequests=existsSync(policy+'.state.json')?JSON.parse(readFileSync(policy+'.state.json','utf8')).entries.length:0
  if(existingRequests>=512)throw Error('TRIAL_REQUEST_LIMIT')
  if(continuation)writeFileSync(join(root,'user-run-claimed.json'),JSON.stringify({at:new Date().toISOString(),runtimeHash,previous_report:continuation.session_id}),{flag:'wx'})
  else claimObservationRun(root,{runtimeHash,thinking:trialThinking})
  const requestLimit=512-existingRequests
  const money = () => {
    if (existsSync(policy + '.state.json')) return readMonetaryBudget(policy)
    if (existsSync(startedMarker)) throw Error('TRIAL_ACCOUNTING_MISSING')
    return []
  }
  const control = createRequestBudget(binding.env, { requests: requestLimit, outputTokens: requestMaxTokens, rmb: capRmb })
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
  const projectFile=join(taskDir,'project.json')
  const prior=continuation?JSON.parse(readFileSync(projectFile,'utf8')):undefined
  const project=prior?findProject(prior.project_id):createProject({request_id:randomUUID(),mode:'quick',initial_message:task.name},{workflowVersion:'software-v1'})
  if(continuation&&(project.project_id!==continuation.project_id||project.current_stage!==continuation.current_stage||project.status!==continuation.project_status))throw Error('SIMULATED_USER_PROJECT_CHANGED')
  const sid=prior?.session_id??`observation-${randomUUID()}`,runId=randomUUID(),reportPath=join(taskDir,`${continuation?'user-run':'run'}-${runId}.json`)
  if(!continuation)writeFileSync(projectFile,JSON.stringify({project_id:project.project_id,session_id:sid,root:project.root_path}),{flag:'wx'})
  recordSessionActivity(sid, project.project_id)
  const report: any = { version: 1, phase, task: which, project_id: project.project_id, session_id: sid, started_at: new Date().toISOString(), status: 'running', paid_cap_rmb: capRmb, budget_window: 'shared-original-window', method:continuation?'simulated-user':'observation-only', carried_requests:existingRequests, thinking_mode:trialThinking, runtime_sha256: hash(readFileSync(fileURLToPath(import.meta.url))) }
  let lastSave=0
  const save = (force=false) => { if(!force&&Date.now()-lastSave<500)return; lastSave=Date.now();writeTextFileAtomic(reportPath, safe({ ...report, operation: control.snapshot(), money: money() })) }
  let latestCard:AgentEvent|undefined,previewUrl:string|undefined,publicReplyText=''
  const event=(e:AgentEvent)=>{
    if(e.type==='message_delta'&&typeof e.payload.text==='string')publicReplyText+=e.payload.text
    if(e.type==='user_decision_required')latestCard=e
    if(e.type==='ux_sketch_ready'&&typeof e.payload.preview_url==='string')previewUrl=e.payload.preview_url
    if(e.type==='thinking_delta')return
    if(e.type==='stage_changed'&&typeof e.payload.stage==='string')latestStage=e.payload.stage
    trace.event(e.type,{...e.payload,phase,run_id:runId})
    appendFileSync(join(taskDir,'events.jsonl'),safe({at:new Date().toISOString(),...e})+'\n');save()
  }
  const model = { query, env: binding.env, signal, sessionId: sid, history: [{role:'user' as const,content:task.goal}], maxTokens: requestMaxTokens,
    persistAssistant: (text: string) => appendSessionMessage(sid, { role: 'assistant', origin: 'agent', content: [{ type: 'text', text }], timestamp: Date.now() }) }
  try {
    save(true)
    if(continuation){
      const userSid=`simulated-user-${randomUUID()}`;recordSessionActivity(userSid,project.project_id)
      const surface=new SimulatedUserSurface(project.project_id,join(taskDir,'simulated-user'),userSid,userFiles)
      latestCard=continuation.turn?.decisions?.at(-1)
      if(!latestCard)throw Error('SIMULATED_USER_DECISION_MISSING')
      try{
        report.user_trial=await simulateUserSession({goal:task.goal,signal,
          turn:async reply=>{
            if(reply){
              const fromApp=!latestCard
              if(fromApp)await surface.assertFeedbackSource()
              await surface.close();latestCard=undefined;publicReplyText=''
              appendSessionMessage(sid,{role:'user',origin:'user',content:[{type:'text',text:reply.text}],timestamp:Date.now()})
              const current=findProject(project.project_id)
              const outcome=await observeOneTurn(async record=>{
                if(fromApp)await enterDesktopLine({projectId:project.project_id,sessionId:sid,requestId:randomUUID(),content:reply.text,initialMessagePersisted:true,maxTokens:requestMaxTokens,signal},query,binding.env,
                  {publish:(_target,type,payload)=>record({event_id:randomUUID(),session_id:sid,project_id:project.project_id,created_at:new Date().toISOString(),type,payload}),persistAssistant:(_sid,text)=>model.persistAssistant(text),persistSystem:()=>{},complete:()=>{}})
                else await handleGuideMessage({project_id:project.project_id,session_id:sid,request_id:randomUUID(),mode:'quick',current_stage:current.current_stage,content:reply.text,
                  ...(reply.selected?{metadata:{source:'card_option' as const,selected_option_id:reply.selected}}:{})},record,model)
              },event,signal)
              model.history.push({role:'user',content:reply.text})
              if(outcome.error||outcome.status==='stopped')return{failed:outcome.error??outcome.status}
              if(!latestCard&&['clarifying','blocked_for_user_decision'].includes(findProject(project.project_id).current_stage)&&publicReplyText.trim()){
                latestCard={event_id:randomUUID(),session_id:sid,project_id:project.project_id,created_at:new Date().toISOString(),type:'user_decision_required',payload:{kind:reply.selected?.startsWith('ux_')?'ux_feedback':'conversation',title:'平台回复',summary:publicReplyText,questions:[]}}
              }
            }
            return{card:latestCard}
          },
          view:async card=>{
            if(['ux_confirm','ux_feedback'].includes(String(card?.payload.kind))){
              if(!previewUrl)return undefined
              await surface.openPreview(previewUrl)
            }else if(card)return undefined
            else await surface.openApp()
            return surface.snapshot()
          },
          decide:input=>decideAsUser(query,{env:binding.env,signal,sessionId:userSid,accounting:{projectId:project.project_id,runId,parentSessionId:sid,role:'simulated-user',scope:'user-experience'}},input),
          act:action=>surface.act(action),
          record:row=>{appendFileSync(join(taskDir,'simulated-user.jsonl'),safe({at:new Date().toISOString(),actor:'simulated-user',...row as object})+'\n')}
        })
        report.turn={status:report.user_trial.status==='user_assessed'?'returned':report.user_trial.status}
      }finally{await surface.close()}
    }else{
      const content=task.goal
      const input={project_id:project.project_id,session_id:sid,request_id:runId,mode:'quick' as const,current_stage:'clarifying' as const,content}
      appendSessionMessage(sid,{role:'user',origin:'user',content:[{type:'text',text:content}],timestamp:Date.now()})
      report.turn=await observeOneTurn(record=>handleGuideMessage(input,record,model),event,signal)
    }
    const final=findProject(project.project_id)
    report.project_status=final.status;report.current_stage=final.current_stage;report.desktop_phase=final.desktop_phase;report.blocked=final.desktop_blocked
    report.release=(await activeSoftwareRelease(project.project_id))?.id;report.usage=readProjectUsage(project.project_id)
    report.status=observationOutcome(report.turn,final,report.release)
  } catch (error) { report.status = 'failed'; report.error = String(error) }
  finally {
    trace.finish()
    report.finished_at = new Date().toISOString()
    report.balance_after = (await get('user/balance').catch(() => undefined))?.balance_infos?.find((r: any) => r.currency === 'CNY')?.total_balance
    report.old_accounting_unchanged = manifest.old_accounting.every((r: any) => hash(readFileSync(r.path)) === r.sha256)
    save(true); console.log(safe({ status: report.status, money: money(), report: reportPath }))
  }
}
