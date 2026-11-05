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
it('retires every old launcher phase before reading accounts or creating a project',()=>{
  for(const phase of ['preflight','run','resume','confirm','inspect']){
    try{execFileSync(process.execPath,['scripts/software-complex-trial.mjs'],{env:{...process.env,BLOMA_COMPLEX_TRIAL_ROOT:root,BLOMA_COMPLEX_TRIAL_PHASE:phase},stdio:'pipe'});throw Error('legacy command unexpectedly succeeded')}
    catch(error){expect(String(error.stderr)).toContain('LEGACY_TRIAL_RETIRED')}
  }
  expect(existsSync(join(root,'home'))).toBe(false);expect(existsSync(join(root,'manifest.json'))).toBe(false)
})
