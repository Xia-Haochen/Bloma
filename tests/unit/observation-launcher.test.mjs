import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {prepareObservation,readObservationRuntime} from '../../scripts/software-observation-trial.mjs'
let root
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'observation-launcher-'))})
afterEach(()=>rmSync(root,{recursive:true,force:true}))
it('compile failure never publishes a runnable descriptor',async()=>{
  await expect(prepareObservation(root,async()=>{throw Error('compile failed')})).rejects.toThrow('compile failed')
  expect(existsSync(join(root,'runtime.json'))).toBe(false)
})
it('prepares the real entry without Electron or network, and refuses changes or a second prepare',()=>{
  execFileSync(process.execPath,['scripts/software-observation-trial.mjs','prepare'],{cwd:process.cwd(),env:{...process.env,BLOMA_OBSERVATION_ROOT:root},stdio:'pipe'})
  const frozen=readObservationRuntime(root)
  expect(existsSync(join(root,'home'))).toBe(false);expect(existsSync(join(root,'manifest.json'))).toBe(false)
  expect(()=>execFileSync(process.execPath,['scripts/software-observation-trial.mjs','prepare'],{env:{...process.env,BLOMA_OBSERVATION_ROOT:root},stdio:'pipe'})).toThrow()
  const entry=join(frozen.runtime,'runner.mjs');writeFileSync(entry,readFileSync(entry,'utf8')+'\n// changed after preparation')
  expect(()=>readObservationRuntime(root)).toThrow('RUNTIME_CHANGED')
},60000)
it('rejects old intervention commands before preparing a runtime',()=>{
  for(const phase of ['resume','confirm','retry-ux','extend-execution'])expect(()=>execFileSync(process.execPath,['scripts/software-observation-trial.mjs',phase],{env:{...process.env,BLOMA_OBSERVATION_ROOT:root},stdio:'pipe'})).toThrow()
  expect(existsSync(join(root,'runtime.json'))).toBe(false)
})
it('keeps both legacy entry files removed',()=>{
  expect(existsSync('scripts/software-complex-trial.mjs')).toBe(false)
  expect(existsSync('scripts/software-complex-trial.ts')).toBe(false)
})
it('prepares simulated-user mode separately without overwriting the original runtime, report or budget',async()=>{
  const {mkdirSync}=await import('node:fs');mkdirSync(join(root,'task'))
  writeFileSync(join(root,'manifest.json'),JSON.stringify({runtime_tree_sha256:'old',tasks:{task:{goal:'save'}}}))
  writeFileSync(join(root,'runtime.json'),'original runtime')
  writeFileSync(join(root,'monetary-policy.json'),'original policy')
  writeFileSync(join(root,'monetary-policy.json.state.json'),'old spend')
  writeFileSync(join(root,'task/project.json'),'original project')
  writeFileSync(join(root,'task/run-first.json'),JSON.stringify({status:'awaiting_user'}))
  await prepareObservation(root,async options=>writeFileSync(options.outfile,'// offline fixture'),'用户允许模拟用户测试')
  const prepared=readObservationRuntime(root,true)
  expect(prepared.migration.previous_runtime_digest).toBe('old')
  expect(readFileSync(join(root,'runtime.json'),'utf8')).toBe('original runtime')
  expect(readFileSync(join(root,'monetary-policy.json.state.json'),'utf8')).toBe('old spend')
  await expect(prepareObservation(root,async()=>{},'再次')).rejects.toThrow('NOT_FRESH')
})
it('records an explicit preview-failure retest without resetting old spend or attempt markers',async()=>{
  const {mkdirSync}=await import('node:fs');mkdirSync(join(root,'task'));mkdirSync(join(root,'home'))
  writeFileSync(join(root,'manifest.json'),JSON.stringify({tasks:{task:{}},runtime_tree_sha256:'old'}))
  writeFileSync(join(root,'monetary-policy.json'),'policy');writeFileSync(join(root,'monetary-policy.json.state.json'),'{"entries":[{"status":"reported","charged_micro_rmb":385620}]}')
  writeFileSync(join(root,'task/project.json'),'project');writeFileSync(join(root,'home/projects.json'),JSON.stringify({projects:[{project_id:'p',status:'active',current_stage:'blocked_for_user_decision'}]}))
  writeFileSync(join(root,'task/user-run-first.json'),JSON.stringify({status:'failed',error:'Error: SIMULATED_USER_PREVIEW_NOT_LOCAL',project_id:'p',session_id:'s',started_at:'2026-11-05T10:00:00Z',finished_at:'2026-11-05T10:01:00Z'}))
  writeFileSync(join(root,'user-run-claimed.json'),'old claim');const previous=process.env.BLOMA_OBSERVATION_RETEST;process.env.BLOMA_OBSERVATION_RETEST='preview-fixed'
  try{await prepareObservation(root,async options=>writeFileSync(options.outfile,'// test'),'测试新版本');expect(readObservationRuntime(root,true).migration.boundary.project_id).toBe('p');expect(readFileSync(join(root,'user-run-claimed.json'),'utf8')).toBe('old claim');expect(readFileSync(join(root,'monetary-policy.json.state.json'),'utf8')).toContain('385620')}
  finally{if(previous===undefined)delete process.env.BLOMA_OBSERVATION_RETEST;else process.env.BLOMA_OBSERVATION_RETEST=previous}
})
