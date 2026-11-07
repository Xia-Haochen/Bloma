import * as commandRuntime from '../../../main/software/command-runtime'
import { execFileSync } from 'node:child_process'
import { withEmptyQualityReview } from '../../fixtures/quality-review-query'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { findProject, createProject as createBareProject } from '../../../main/project/project-service'
import { createEngineeringProject as createProject } from '../../fixtures/engineering-project'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine, isDesktopLineActive, type DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/stages/orchestration-contracts'
import { runCoreVerification } from '../../../main/desktop/core-verification'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import { launchSoftwareForUser } from '../../../main/software/user-launch'
import { createEvaluationProtocol, stageEvaluationRun } from '../../../main/software/harness-evaluation'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-loop-')); process.env.PROMA_HOME = home })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it.each<{mode:'quick'|'longterm';peer:boolean;hold?:boolean}>([{mode:'quick',peer:false},{mode:'longterm',peer:false},{mode:'quick',peer:true},{mode:'quick',peer:true,hold:true}])('real Pi software loop builds, commits and delivers ($mode, peer=$peer, hold=$hold)', async ({mode,peer,hold}) => {
  vi.stubEnv('BLOMA_ENGINEERING_PARTNER',peer?'1':'0')
  let peerCalls=0,peerCancelled=false,pendingProbes=0,reviewWithActiveProbe=false
  if(hold){
    const execute=commandRuntime.executeSoftwareCommand
    vi.spyOn(commandRuntime,'executeSoftwareCommand').mockImplementation(args=>{
      if(Array.isArray(args.command)&&args.command[2]==='advisory-probe-await-cancel')return new Promise((_resolve,reject)=>{
        pendingProbes++
        const stop=()=>{pendingProbes--;peerCancelled=true;reject(Error('advisory cancelled after parent completion'))}
        if(args.signal?.aborted)stop();else args.signal?.addEventListener('abort',stop,{once:true})
      })
      return execute(args)
    })
  }
  const project = createBareProject({ request_id: 'c', mode }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '计算加法', ui: 'none', delivery: 'command', requirements: [{ description: '计算加法', expected: '2加3得5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '计算加法', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const confirmed=readPrdBackplane(project.project_id)
  stageEvaluationRun(project.project_id,createEvaluationProtocol([{id:'sum',goal:confirmed.positioning,delivery:'command',requirements:confirmed.requirements.map(r=>({description:r.description,expected:confirmed.acceptance[r.id]})),constraints:confirmed.constraints??[],out_of_scope:confirmed.out_of_scope??[]}]),'sum','single','production-identity')
  const calls: SDKQueryOptions[] = [], events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
  const query: SDKQuery = async function* (_prompt, options) {
    if(options.accounting?.role==='research'){
      if(hold){peerCalls++;yield{type:'assistant',message:{role:'assistant',content:peerCalls===1?[{type:'text',text:'PEER_PUBLIC_FINDING: validate the actual entry.'},use('peer-context','read_file',{path:'context.json'})]:[use('peer-hold','run_command',{command:['node','-e','advisory-probe-await-cancel']})]}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}};return}

      expect(JSON.stringify(options.messages?.filter(m=>m.role==='system'))).not.toContain('负责整个工程')
      expect(options.maxTokens).toBeLessThanOrEqual(16384)
      yield {type:'assistant',message:{role:'assistant',content:++peerCalls%2===1?[use('peer-context','read_file',{path:'context.json'}),...(peerCalls===1?[use('peer-note','write_file',{path:'notes.md',content:'核对确认的命令行交付、实际入口与数据边界。'})]:[])]:[{type:'text',text:'独立核对：当前任务为无持久状态的命令行计算，验证实际构建入口及正常输入；仍以真实测试为依据。'}]}}
      yield {type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}};return
    }
    calls.push(options)
    yield { type: 'assistant', message: { role: 'assistant', content: calls.length === 1 ? [
      use('design', 'write_file', {path:'DESIGN.md', content:'CLI entry owns argument parsing and output; calculation is stateless. Build script only copies application sources to dist. No persistence, server or GUI. Errors propagate as process failures. Verify addition through the normal built entry with two arguments.'}),
      use('package', 'write_file', { path: 'package.json', content: JSON.stringify({ name: 'real-software-loop', scripts: { build: 'node build.cjs' } }) }),
      use('source', 'write_file', { path: 'app.cjs', content: 'console.log(process.argv.length>2?Number(process.argv[2])+Number(process.argv[3]):5)' }),
      use('builder', 'write_file', { path: 'build.cjs', content: 'const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.copyFileSync("app.cjs","dist/app.cjs");console.log("built real source")' }),
      use('build', 'run_command', { command: ['npm', 'run', 'build'] }),
      use('launch', 'write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'dist/app.cjs'] }) }),
      use('check', 'register_cli_check', { expectations: { 'F-001': '2加3得5' }, cases: [{ name: 'sum', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] }),
    ] : calls.length>2 ? [{type:'text',text:'已结合独立意见核对当前实现，进入已有宿主检查。'}] : [
      use('git-status','run_command',{command:['git','status','--short']}),
      use('git-add','run_command',{command:['git','add','--','DESIGN.md','package.json','app.cjs','build.cjs','LAUNCH.json','dist/app.cjs']}),
      use('git-commit','run_command',{command:['git','-c','user.name=Fixture','-c','user.email=fixture@local','-c','commit.gpgsign=false','-c','core.hooksPath=','commit','-m','Implement stateless addition CLI; validate build and normal entry']}),
      use('verify','verify_app',{}),
    ] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 20 } }
  }
  const reviewedQuery=withEmptyQualityReview(query)
  const trackedQuery:SDKQuery=async function*(prompt,options){
    if(options.accounting?.role==='review'){expect(JSON.stringify(options.messages)).not.toContain('PEER_PUBLIC_FINDING');if(pendingProbes>0)reviewWithActiveProbe=true}
    yield* reviewedQuery(prompt,options)
  }
  const deps: DesktopRouteDeps = { publish: (_target, type, payload) => events.push({ type, payload }), persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} }
  expect(await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '直接实现', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, trackedQuery, {}, deps)).toBe(true)
  if(mode==='longterm'){
    expect(findProject(project.project_id)).toMatchObject({status:'active',current_stage:'blocked_for_user_decision',longterm_summary:{status:'awaiting_confirmation'}})
    expect(await activeSoftwareRelease(project.project_id)).toBeUndefined()
    expect(events.some(event=>event.type==='user_decision_required'&&event.payload.kind==='longterm_milestone')).toBe(true)
    await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'user-confirm',content:'确认本阶段',maxTokens:4096,signal:AbortSignal.timeout(90000)},trackedQuery,{},deps)
  }
  expect(findProject(project.project_id)).toMatchObject({ status: 'completed', desktop_phase: 'delivered' })
  expect(readFileSync(join(project.root_path, 'dist/app.cjs'), 'utf8')).toContain('console.log')
  expect(existsSync(join(project.root_path, 'app.py'))).toBe(false)
  if(hold){expect(JSON.stringify(calls)).toContain('PEER_PUBLIC_FINDING');expect(reviewWithActiveProbe).toBe(true);expect(peerCancelled).toBe(true);expect(pendingProbes).toBe(0)}else if(peer){expect(peerCalls).toBe(4);expect(calls.length).toBeGreaterThanOrEqual(2);expect(calls.length).toBeLessThanOrEqual(4)}else expect(calls).toHaveLength(2)
  const evaluation=readFileSync(join(home,'harness-evaluation',project.project_id,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  const observed=evaluation.filter(e=>e.kind==='runtime_identity').map(e=>e.data.observation)
  expect(observed.some(o=>o.role==='orchestrator'&&o.runtime.packages['pi-coding-agent']==='1.4.0')).toBe(true)
  expect(observed.some(o=>o.quality_role==='C'&&o.role==='review')).toBe(true)
  const checkpoints=evaluation.filter(e=>e.kind==='project_history')
  expect(checkpoints.some(e=>e.data.boundary==='before_implementation')).toBe(true)
  expect(checkpoints.every(e=>e.data.boundary==='before_implementation')).toBe(true)
  expect(observed.some(o=>o.role==='orchestrator'&&o.skills.names.includes('software-engineering'))).toBe(true)
  expect(observed.filter(o=>o.role==='review').every(o=>o.skills.names.length===0)).toBe(true)
  expect(execFileSync('git',['log','-1','--pretty=%s'],{cwd:project.root_path,encoding:'utf8',windowsHide:true})).toContain('Implement stateless addition CLI')
  expect(execFileSync('git',['show','HEAD:DESIGN.md'],{cwd:project.root_path,encoding:'utf8',windowsHide:true})).toContain('CLI entry owns')
  expect(evaluation.some(e=>e.kind==='collaboration_selected'&&e.data.selection.required.includes('code'))).toBe(true)
  expect(JSON.stringify(calls[0].messages)).not.toContain('schema_version\\":1,\\"command\\":[\\"python\\"')
  expect(events.some(event => event.type === 'stage_changed' && event.payload.stage === 'delivered')).toBe(true)
  expect(isDesktopLineActive({ ...findProject(project.project_id), desktop_phase: undefined })).toBe(true)
  const released = await activeSoftwareRelease(project.project_id)
  expect(released?.verified).toBeDefined(); expect(released?.root).not.toBe(project.root_path)
  expect(JSON.parse(readFileSync(join(released!.root, '00_VERIFY/core-verification.json'), 'utf8')).status).toBe('passed')
  writeFileSync(join(project.root_path, 'dist/app.cjs'), 'console.log("unverified working version")')
  expect(await launchSoftwareForUser(project.project_id, project.root_path, released!.launch, async () => {})).toMatchObject({ started: true, detail: '5' })
}, 120000)
it('confirmed desktop delivery cannot silently use a browser launch declaration', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '桌面记事', ui: 'required', delivery: 'desktop', requirements: [{ description: '保存文字', expected: '重开保留' }] }),
    { projectId: project.project_id, sessionId: 's', source: '桌面记事', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, command: ['node', 'server.cjs'], ui: 'browser', url: 'http://127.0.0.1:45679' }))
  const result = await runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path })
  expect(result.status).not.toBe('passed'); expect(result.missing.join()).toContain('DELIVERY_TARGET_MISMATCH')
})
