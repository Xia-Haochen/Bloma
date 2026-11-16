import {build} from 'esbuild'
import {spawn} from 'node:child_process'
import {cpSync} from 'node:fs'
import { withEmptyQualityReview } from '../../fixtures/quality-review-query'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { findProject } from '../../../main/project/project-service'
import { createEngineeringProject as createProject } from '../../fixtures/engineering-project'
import { createProductionBudget } from '../../../main/desktop/production-budget'
import { leanBudget, withLeanRuntime } from '../../../main/desktop/lean-budget'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine, type DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { readSoftwareRunState, recordSoftwareRepair, saveSoftwareRunState } from '../../../main/software/run-state'
import { readProjectAttempts } from '../../../main/platform/execution/project-attempts'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-long-task-')); process.env.PROMA_HOME = home })
afterEach(() => { vi.useRealTimers(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('recovers the last heartbeat plus a bounded tail, records unmeasured downtime and retains every request/output reservation', () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000)
  const budget = createProductionBudget('p', 'same-operation', 'desktop-implement', undefined, 'lease'), file = budget.snapshot().file
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, requests: 2, output: 4096, phases: { 'desktop-implement': 2 }, runtimeMs: 1000,
    runtimeStartedAt: 880000, runtimeHeartbeatAt: 900000, runtimeOwner: '11111111-1111-1111-1111-111111111111' }))
  expect(budget.startRuntime()).toBe(26000)
  expect(budget.snapshot()).toMatchObject({ requests: 2, output: 4096, runtimeUncertainMs: 95000 })
  expect(() => createProductionBudget('p', 'same-operation', 'prepare', undefined, 'lease').startRuntime()).toThrow('ALREADY_ACTIVE')
  vi.setSystemTime(1_003_000); budget.heartbeatRuntime(); budget.finishRuntime()
  expect(budget.snapshot()).toMatchObject({ requests: 2, output: 4096, runtimeMs: 29000 })
  const restarted = createProductionBudget('p', 'same-operation', 'desktop-implement', undefined, 'lease')
  expect(restarted.snapshot()).toMatchObject({ requests: 2, output: 4096, runtimeMs: 29000 })
})
it('refuses a fresh foreign lease and allows software continuation without clearing its accumulated usage', async () => {
  const foreign = createProductionBudget('p', 'foreign', 'desktop-implement', undefined, 'lease'), file = foreign.snapshot().file, now = Date.now()
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, requests: 1, output: 8192, phases: {}, runtimeStartedAt: now - 500, runtimeHeartbeatAt: now - 100, runtimeOwner: '22222222-2222-2222-2222-222222222222' }))
  expect(() => foreign.startRuntime()).toThrow('LEASE_ACTIVE')
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }), budget = leanBudget(project.project_id, 'desktop-implement')
  const saved = budget.snapshot(); writeFileSync(saved.file, JSON.stringify({ version: 1, requests: 7, output: 3000, phases: { 'desktop-implement': 7 }, runtimeMs: 3600000 }))
  await withLeanRuntime(project.project_id, 'desktop-implement', undefined, async () => 'continued')
  expect(budget.snapshot()).toMatchObject({ requests: 7, output: 3000 }); expect(budget.snapshot().runtimeMs).toBeGreaterThanOrEqual(3600000)
})
it('keeps software running beyond 30 minutes while heartbeating and retaining request/output reservations', async () => {
  vi.useFakeTimers()
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }), budget = leanBudget(project.project_id, 'desktop-implement')
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  const saved = budget.snapshot(); writeFileSync(saved.file, JSON.stringify({ version: 1, requests: 7, output: 3000, phases: { 'desktop-implement': 7 }, runtimeMs: 3600000 }))
  let active: AbortSignal | undefined
  const running = withLeanRuntime(project.project_id, 'desktop-implement', undefined, async signal => {
    active = signal
    await new Promise<void>(done => setTimeout(done, 31 * 60_000))
    signal.throwIfAborted(); return 'finished after 31 minutes'
  })
  const completion = expect(running).resolves.toBe('finished after 31 minutes')
  await vi.advanceTimersByTimeAsync(31 * 60_000)
  await completion; expect(active?.aborted).toBe(false)
  expect(budget.snapshot()).toMatchObject({ requests: 7, output: 3000, runtimeMs: 3600000 + 31 * 60_000 })
  expect(budget.snapshot().runtimeOwner).toBeUndefined()
})
it('still cancels software explicitly after 30 minutes and releases its lease', async () => {
  vi.useFakeTimers()
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const abort = new AbortController(), reason = Error('explicit user stop')
  let active: AbortSignal | undefined
  const running = withLeanRuntime(project.project_id, 'desktop-implement', abort.signal, async signal => {
    active = signal
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const completion = expect(running).rejects.toBe(reason)
  await vi.advanceTimersByTimeAsync(31 * 60_000)
  expect(active?.aborted).toBe(false)
  abort.abort(reason); await completion
  expect(leanBudget(project.project_id, 'desktop-implement').snapshot().runtimeOwner).toBeUndefined()
})
it('stops repeated unchanged observations, permits actual improvement and retains counts across explicit continuation', () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }), base = { projectId: project.project_id, sessionId: 's', runId: 'one', error: 'GUI result incorrect; token=SECRET_TOKEN' }
  saveSoftwareRunState({ ...base, status: 'running' })
  expect(recordSoftwareRepair({ ...base, observations: { actual: 0 } }).allowed).toBe(true)
  expect(recordSoftwareRepair({ ...base, observations: { actual: 1 } }).repeats).toBe(1)
  expect(recordSoftwareRepair({ ...base, observations: { actual: 1 } }).allowed).toBe(true)
  expect(recordSoftwareRepair({ ...base, observations: { actual: 1 } })).toMatchObject({ allowed: false, repeats: 3, total: 4 })
  expect(recordSoftwareRepair({ ...base, runId: 'human-continuation', observations: { actual: 1 } })).toMatchObject({ allowed: true, repeats: 1, total: 5 })
  const stored = readSoftwareRunState(project.project_id)!
  expect(JSON.stringify(stored)).not.toContain('SECRET_TOKEN'); expect(stored).not.toHaveProperty('observations')
  saveSoftwareRunState({ ...base, runId: 'resume', status: 'running' })
  expect(readSoftwareRunState(project.project_id)?.error).toBeUndefined()
  expect(readSoftwareRunState(project.project_id)?.last_failure?.error).toContain('REDACTED')
})
it('heartbeats the active lease, aborts on accounting corruption and releases its in-memory ownership even when the final read fails', async () => {
  vi.useFakeTimers(); const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const budget = leanBudget(project.project_id, 'desktop-implement'), file = budget.snapshot().file; let saved = ''
  await expect(withLeanRuntime(project.project_id, 'desktop-implement', undefined, async signal => {
    const first = budget.snapshot().runtimeHeartbeatAt!
    await vi.advanceTimersByTimeAsync(6000)
    expect(budget.snapshot().runtimeHeartbeatAt).toBeGreaterThan(first)
    saved = readFileSync(budget.snapshot().file, 'utf8'); writeFileSync(budget.snapshot().file, 'corrupt accounting')
    await vi.advanceTimersByTimeAsync(5000); expect(signal.aborted).toBe(true)
  })).rejects.toThrow('HARNESS_BUDGET_UNREADABLE')
  const restored = JSON.parse(saved); delete restored.runtimeStartedAt; delete restored.runtimeOwner; delete restored.runtimeHeartbeatAt; delete restored.runtimePid
  writeFileSync(file, JSON.stringify(restored))
  await expect(withLeanRuntime(project.project_id, 'desktop-implement', undefined, async () => 'recovered after actual accounting repair')).resolves.toBe('recovered after actual accounting repair')
})
it('continues the real Pi transcript after cancellation without replaying an already completed setup command or resetting its budget', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description: '输出5', expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const controller = new AbortController(); let calls = 0
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
  const query: SDKQuery = async function* () {
    if (++calls === 2) { controller.abort(); return }
    yield { type: 'assistant', message: { role: 'assistant', content: [
      use('app', 'write_file', { path: 'app.cjs', content: 'console.log(5)' }),
      use('setup', 'write_file', { path: 'setup.cjs', content: 'require("fs").appendFileSync("completed-setup.txt","one real side effect\\n")' }),
      use('la', 'write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }) }),
      use('ck', 'register_cli_check', { expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] }),
      use('effect', 'run_command', { command: ['node', 'setup.cjs'] }),
    ] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 20 } }
  }
  const deps: DesktopRouteDeps = { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'first', content: '开始实现', maxTokens: 4096, signal: controller.signal }, withEmptyQualityReview(query), {}, deps)
  const file = join(project.root_path, 'completed-setup.txt'), before = readFileSync(file, 'utf8'), usage = leanBudget(project.project_id, 'desktop-implement').snapshot()
  expect(before.split('one real side effect').length - 1).toBe(1)
  expect(readSoftwareRunState(project.project_id)?.status).toMatch(/cancelled|interrupted/)
  const resume: SDKQuery = async function* (_prompt, options) {
    expect(JSON.stringify(options.messages)).toContain('setup.cjs')
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已有步骤与登记均保留，交给宿主沿当前版本验证。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'resume', content: '继续', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(resume), {}, deps)
  expect(findProject(project.project_id).status).toBe('completed'); expect(readFileSync(file, 'utf8')).toBe(before)
  const after = leanBudget(project.project_id, 'desktop-implement').snapshot()
  expect(after.file).toBe(usage.file); expect(after.requests).toBeGreaterThan(usage.requests); expect(after.output).toBeGreaterThanOrEqual(usage.output)
  expect(readSoftwareRunState(project.project_id)?.status).toBe('verified')
}, 120000)
it.each([{ values: [0, 1, 2, 5], completed: true }, { values: [0, 0, 0, 0], completed: false }])('uses actual changed CLI observations for repairs beyond two attempts; unchanged failures stop ($completed)', async ({ values, completed }) => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description: '输出5', expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  let calls = 0
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
  const query: SDKQuery = async function* () {
    const call = calls++, round = Math.floor(call / 2)
    yield { type: 'assistant', message: { role: 'assistant', content: call % 2 === 0 ? [
      ...(call > 0 ? [use(`read-${call}`, 'read_file', { path: 'app.cjs' })] : []),
      use(`write-${call}`, 'write_file', { path: 'app.cjs', content: `console.log(${values[Math.min(round, values.length - 1)]})` }),
      ...(call === 0 ? [use('launch', 'write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }) }),
        use('check', 'register_cli_check', { expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] })] : []),
    ] : [{ type: 'text', text: '当前修改已保存，等待实际检查。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  const deps: DesktopRouteDeps = { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '完成输出5', maxTokens: 4096, signal: AbortSignal.timeout(120000) }, withEmptyQualityReview(query), {}, deps)
  expect(findProject(project.project_id).status === 'completed', JSON.stringify({ calls, blocked: findProject(project.project_id).desktop_blocked,
    state: readSoftwareRunState(project.project_id), app: readFileSync(join(project.root_path, 'app.cjs'), 'utf8') })).toBe(completed)
  expect(calls).toBe(completed ? 8 : 6)
  if (completed) expect(readProjectAttempts(project.project_id).total['lean-repair']).toBe(3)
  else expect(readSoftwareRunState(project.project_id)).toMatchObject({ status: 'blocked', stop_code: 'no_progress', failure: { repeats: 3 } })
}, 150000)

it('stops unchanged reruns but allows an actual source revision or changed observation within the same budget', () => {
  const project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const base={projectId:project.project_id,sessionId:'s',runId:'r',failureFingerprint:'same-observed-assertion'}
  expect(recordSoftwareRepair({...base,error:'report A at time 1',source:'revision1'}).repeats).toBe(1)
  expect(recordSoftwareRepair({...base,error:'report B at time 2',source:'revision1'}).repeats).toBe(2)
  expect(recordSoftwareRepair({...base,error:'report C at time 3',source:'revision1'})).toMatchObject({repeats:3,allowed:false})
  expect(recordSoftwareRepair({...base,error:'report C at time 4',source:'revision2'})).toMatchObject({repeats:1,allowed:true,total:4})
  expect(recordSoftwareRepair({...base,error:'report D',failureFingerprint:'actual-result-changed'})).toMatchObject({repeats:1,allowed:true})
})


it('recovers a real exited process with the same Pi project and budget without replaying completed side effects',async()=>{
 const runtime=join(process.cwd(),'run-artifacts','closeout-process-fixture')
 mkdirSync(runtime,{recursive:true});cpSync(join(process.cwd(),'main/templates'),join(runtime,'templates'),{recursive:true})
 const worker=join(runtime,'worker.mjs')
 await build({entryPoints:[join(process.cwd(),'tests/fixtures/closeout-process-worker.ts')],outfile:worker,bundle:true,platform:'node',format:'esm',external:['playwright','typescript','@earendil-works/pi-coding-agent','@earendil-works/pi-agent-core','@earendil-works/pi-ai'],plugins:[{name:'unused-electron-shell',setup(builder){builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test-shell'}));builder.onLoad({filter:/.*/,namespace:'test-shell'},()=>({contents:'export const app={isPackaged:false};export const net={},protocol={},session={},shell={},dialog={},ipcMain={},clipboard={},nativeImage={},screen={},desktopCapturer={},nativeTheme={},webContents={};export class BrowserWindow{};export class Notification{};',loader:'js'}))}}]})
 const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!/^(?:BLOMA_|ANTHROPIC_|OPENAI_|PROMA_|ELECTRON_)/.test(key))) as Record<string,string>
 const run=(phase:string)=>new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{let stdout='',stderr='';const child=spawn(process.execPath,[worker,phase],{cwd:process.cwd(),env:{...env,PROMA_HOME:home},windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}))})
 const first=await run('crash');expect(first.code,first.stderr).toBe(23)
 const before=JSON.parse(readFileSync(join(home,'before-process-exit.json'),'utf8')),fixture=JSON.parse(readFileSync(join(home,'process-fixture.json'),'utf8'))
 expect(before.runtimePid).toBe(fixture.pid);expect(before.requests).toBe(2)
 const second=await run('resume');expect(second.code,second.stderr).toBe(0)
 const after=JSON.parse(readFileSync(join(home,'after-process-resume.json'),'utf8'))
 expect(after.pid).not.toBe(fixture.pid);expect(after.status).toBe('completed');expect(after.phase).toBe('delivered');expect(after.release).toBeTruthy()
 expect(after.effect).toBe('once\n');expect(after.makerCalls).toBe(0)
 expect(after.budget.file).toBe(before.file);expect(after.budget.requests).toBeGreaterThan(before.requests);expect(after.budget.output).toBeGreaterThanOrEqual(before.output)
 writeFileSync(join(runtime,'evidence.json'),JSON.stringify({first_pid:fixture.pid,second_pid:after.pid,before:{requests:before.requests,output:before.output},after,scope:'real two-process Pi/CLI recovery; controlled provider; no paid calls'},null,2))
},180000)
