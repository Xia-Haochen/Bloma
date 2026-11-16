import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron } from 'playwright'

const [root, pack, assets, channelHome, previousProfile, speechPython] = process.argv.slice(2).map(value => resolve(value))
const repo = process.cwd()
const require = createRequire(import.meta.url)
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const write = (file, value) => writeFileSync(join(root, file), JSON.stringify(value, null, 2))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function command(file, ...args) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}
const bench = (...args) => command(process.execPath, join(pack, 'tools/bench.mjs'), ...args)
bench('verify-pack')
command(process.execPath, join(pack, 'tools/verify-assets.mjs'), assets)
bench('init', 'voice-conversation', root)
const runHome = join(root, 'bloma-home')
const profile = join(root, 'electron-profile')
const materials = join(root, 'voice-inputs')
mkdirSync(runHome)
mkdirSync(profile)
cpSync(join(previousProfile, 'Local State'), join(profile, 'Local State'))
cpSync(join(pack, 'inputs/voice'), materials, { recursive: true })
const channels = read(join(channelHome, 'bloma-channels.json'))
const channel = channels.channels.find(row => row.enabled && row.provider_type === 'deepseek' && row.models.some(model => model.id === 'deepseek-flash' && model.enabled))
assert.ok(channel)
channel.models = channel.models.filter(model => model.id === 'deepseek-flash')
Object.assign(channel.models[0], {context_window: 1048576, max_output_tokens: 32768})
channel.max_tokens = 32768
writeFileSync(join(runHome, 'bloma-channels.json'), JSON.stringify({version:1,channels:[channel]}))
const rate = { host:'api.deepseek.com', model:'deepseek-flash', cap_rmb:10, context_tokens:1048576,
  input_rmb_per_million:2, output_rmb_per_million:8, cache_rmb_per_million:0.04 }
const policy = join(root, 'monetary-policy.json')
write('monetary-policy.json', {version:1,models:[rate]})
write('monetary-policy.json.state.json', {version:1, policy_hash:hash(readFileSync(policy)), entries:[]})
const source = command('git','rev-parse','HEAD')
const build = hash(readFileSync(join(repo,'dist-main/main/index.js')))
write('authorization.json', {user_text:'可以，单独给这轮10块钱，开始跑Bloma的语音任务吧', cap_rmb:10,
  existing_ledgers:'retained', pricing_source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'})
const study = read(join(root, 'study.json'))
const env = {...process.env, PROMA_HOME:runHome, BLOMA_MONETARY_POLICY:policy,
  BLOMA_MONETARY_EPOCH_DIR:join(root,'monetary-epochs'), BLOMA_EXPERIMENT_THINKING:'high',
  BLOMA_BENCHMARK_OUTPUT_CEILING:'32768', BLOMA_BENCHMARK_REQUEST_LOG:join(root,'provider-requests.jsonl'),
  BLOMA_SPEECH_MODEL_DIR:join(assets,'speech-models/sensevoice-int8')}
delete env.ELECTRON_RUN_AS_NODE
delete env.BLOMA_DISPATCH_EXPERIMENT
delete env.BLOMA_EXPERIMENT_UNLIMITED_MONETARY
const trial = read(join(root, 'trial.json'))
Object.assign(trial,{system_id:'Bloma',configuration_id:'0.1.3-voice-high',evaluator_id:'Codex pilot operator'})
write('trial.json', trial)
const controls = read(join(root, 'interventions.json'))
const note = (kind, info = {}) => {
  appendFileSync(join(root,'operator.jsonl'),JSON.stringify({at:new Date().toISOString(),kind,...info})+'\n')
  console.log(kind, JSON.stringify(info))
}
write('run-environment.json',{
  ...read(join(root,'run-environment.json')), system_id:'Bloma',agent_version:'0.1.0',
  build_or_commit:{source,main_bundle_sha256:build},windows_version:os.version()+' '+os.release(),
  hardware:{cpu:os.cpus()[0].model,logical_processors:os.cpus().length,memory_bytes:os.totalmem()},
  api_protocol:'Anthropic Messages for text, OpenAI Chat Completions for vision',
  common_assets_verified:true,common_assets_path:assets,speech_python_path:speechPython,
  device_and_volume:'User confirmed physical microphone availability. Physical recording and listening remain separate observations.',
  redacted_request_evidence:'provider-requests.jsonl'
})
const app = await _electron.launch({executablePath:require('electron'),args:[repo,'--user-data-dir='+profile],cwd:repo,env,
  recordVideo:{dir:join(root,'recordings'),size:{width:1280,height:800}},timeout:45000})
const page = await app.firstWindow()
let started = false, terminal = 'infra_error', latestProject, deadline, recordings
const stop = page.locator('button[aria-label="停止本轮制作"]:visible')
const progressFile = join(root,'progress.json')
const seen = new Set()
try {
  await app.evaluate(async ({safeStorage}, encrypted) => {
    const key = safeStorage.decryptString(Buffer.from(encrypted,'hex'))
    const headers = {authorization:'Bearer '+key}
    const [balance, models] = await Promise.all(['/user/balance','/v1/models'].map(async path => {
      const response = await fetch('https://api.deepseek.com'+path,{headers,signal:AbortSignal.timeout(15000)})
      if (!response.ok) throw Error('provider preflight HTTP '+response.status)
      return response.json()
    }))
    if (!balance.is_available || !models.data.some(model=>model.id==='deepseek-flash')) throw Error('DeepSeek unavailable')
    return Number(balance.balance_infos.find(row=>row.currency==='CNY')?.total_balance)
  },channel.api_key).then(balance => {
    assert.ok(balance >= 2.359296,'Provider balance cannot cover the initial full-input reserve')
    note('provider_preflight',{protocol:'Anthropic Messages',model:'deepseek-flash',balance_rmb:balance,local_cap_rmb:10})
  })
  const text = readFileSync(join(pack,'participant/voice-conversation.md'),'utf8').trim()
  const file = join(root,'公开输入与环境.txt')
  writeFileSync(file,[
    '本任务的公开语音输入目录：'+materials,
    '包含三段标准 WAV、空白 WAV 和对应文本。真实业务服务配置由操作者提供。',
    '公共语音资源目录：'+env.BLOMA_SPEECH_MODEL_DIR,
    '公共语音辅助模块：'+join(assets,'speech-tools'),
    '已准备的 Python 环境：'+speechPython,
    '统一环境：Windows 11、Node 22.22.2、Electron 39.8.10、Python 3.13.7。',
    '真实业务模型：deepseek-flash，高思考，单次输出上限 4096，OpenAI 兼容协议。'
  ].join('\n'))
  const input = page.getByRole('textbox',{name:'你的软件想法'})
  const send = page.locator('button[data-ai-id="create-project-button"]')
  await input.waitFor({timeout:30000})
  assert.doesNotMatch(await input.getAttribute('placeholder') ?? '', /还没有连接/)
  const submission=text+'\n\n## 本次公开输入与环境\n\n'+readFileSync(file,'utf8')
  await input.fill(submission)
  assert.equal(await input.inputValue(),submission)
  recordings = page.video()
  assert.ok(recordings,'UI video capture unavailable')
  bench('event',root,'start','Submitted frozen participant task and public input details')
  started = true
  deadline = Date.now()+study.wall_limit_seconds*1000
  const timer = setTimeout(async ()=>{
    note('wall_cutoff')
    try { await stop.first().click({timeout:1000}) } catch {}
    try { await app.close() } catch {}
  }, study.wall_limit_seconds*1000)
  timer.unref()
  await send.click()
  note('request_submitted',{task_sha256:hash(text),submission_sha256:hash(submission),pid:app.process().pid})
  let previous
  while (Date.now() < deadline && !page.isClosed()) {
    const projects = join(runHome,'projects.json')
    if (existsSync(projects)) latestProject=read(projects).projects[0]
    const status = latestProject && {id:latestProject.project_id, stage:latestProject.current_stage,
      phase:latestProject.desktop_phase, status:latestProject.status, root:latestProject.root_path}
    const ledger = read(policy+'.state.json').entries
    const progress = {status,requests:ledger.length,reported:ledger.filter(row=>row.status==='reported').length,
      accounted_upper_rmb:ledger.reduce((total,row)=>total+row.charged_micro_rmb,0)/1e6,deadline:new Date(deadline).toISOString()}
    const serialized = JSON.stringify(progress)
    if (serialized!==previous) {write('progress.json',progress);previous=serialized}
    if (status?.phase==='delivered' && status.status==='completed') {terminal='completed';break}
    if (existsSync(join(root,'stop-requested'))) {terminal='user_stopped';break}
    const items = await page.locator('button[data-ai-id^="card-option-"]:visible, button[data-ai-id="confirm-sketch-button"]:visible').evaluateAll(buttons=>buttons.map(button=>({
      id:button.getAttribute('data-ai-id'),label:button.textContent.trim(),disabled:button.disabled
    })))
    const choice=items.find(item=>!item.disabled&&!seen.has(item.id)&&(/^(card-option-lean_confirm:|card-option-ux_confirm_go$|confirm-sketch-button$)/.test(item.id)))
    if (choice) {
      seen.add(choice.id)
      const record={at:new Date().toISOString(),label:choice.label,id:choice.id,script:'participant/clarifications.md'}
      controls.normal_participation.push(record)
      write('interventions.json',controls)
      await page.locator('button[data-ai-id="'+choice.id+'"]:visible').first().click({timeout:4000})
      note('normal_confirmation',record)
    }
    await delay(2500)
  }
  if (Date.now()>=deadline) terminal='timed_out'
  clearTimeout(timer)
} catch(error) {
  note('operator_error',{message:error.message})
  if (Date.now()>=deadline) terminal='timed_out'
  else process.exitCode=1
} finally {
  if(started && !page.isClosed() && terminal!=='completed') {
    try {await stop.first().click({timeout:1500})}catch{}
  }
  if(started) bench('event',root,'stop',terminal)
  try { await app.close() } catch {}
  if (recordings) await recordings.saveAs(join(root,'bloma-run.webm')).catch(()=>{})
  const entries=read(policy+'.state.json').entries
  const upper=entries.reduce((sum,row)=>sum+row.charged_micro_rmb,0)/1e6
  write('run-result.json',{terminal, project_id:latestProject?.project_id, project_path:latestProject?.root_path,
    requests:entries.length, accounted_upper_rmb:upper, ledger_statuses:entries.reduce((counts,row)=>({...counts,[row.status]:(counts[row.status]??0)+1}),{})})
  if (started && latestProject?.root_path && existsSync(latestProject.root_path)) {
    try {
      bench('snapshot',latestProject.root_path,join(root,'artifact-manifest.json'))
      Object.assign(trial,{execution_status:terminal==='timed_out'?'timeout':terminal,cost_rmb:upper})
      write('trial.json',trial)
      bench('finalize',root)
    } catch(error) { note('snapshot_or_finalize_pending',{message:error.message}) }
  }
  note('trial_finished',{terminal,upper})
}
