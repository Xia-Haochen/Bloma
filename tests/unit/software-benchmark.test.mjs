import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,cpSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {scoreTrial,sha256} from '../../scripts/score-software-benchmark.mjs'

test('benchmark separates full completion, partial credit, budget, assistance and evidence integrity',()=>{
  const root=mkdtempSync(join(tmpdir(),'software-benchmark-'))
  try{
    const bytes=readFileSync('tests/fixtures/software-agent-benchmark/tasks.v0.1.json')
    const suite=JSON.parse(bytes)
    writeFileSync(join(root,'evidence.txt'),'controlled test evidence')
    for(const task of suite.tasks){
      const artifact='a'.repeat(64)
      const trial={protocol_sha256:sha256(bytes),run_id:'fixture',task_id:task.id,system_id:'fixture-system',
        configuration_id:'controlled',seed:'1',evaluator_id:'fixture-grader',track:'H',
        execution_status:'completed',wall_seconds:100,cost_rmb:1,technical_interventions:0,artifact_sha256:artifact,
        observations:task.checks.map(check=>({check_id:check.id,status:'pass',artifact_sha256:artifact,
          evidence:[{path:'evidence.txt',sha256:sha256('controlled test evidence')}]}))}
      assert.equal(scoreTrial(bytes,trial,root).autonomous_complete,true)
      assert.equal(scoreTrial(bytes,trial,root).rank_eligible,false)
      const calibrationPending=Buffer.from(JSON.stringify({...suite,status:'frozen',ranking_enabled:false}))
      assert.equal(scoreTrial(calibrationPending,{...trial,protocol_sha256:sha256(calibrationPending)},root).rank_eligible,false)
      const partial=structuredClone(trial)
      partial.observations[0].status='fail'
      assert.equal(scoreTrial(bytes,partial,root).quality_points,80)
      assert.equal(scoreTrial(bytes,partial,root).artifact_complete,false)
      assert.equal(scoreTrial(bytes,{...trial,technical_interventions:1},root).autonomous_complete,false)
      assert.equal(scoreTrial(bytes,{...trial,cost_rmb:null},root).autonomous_complete,false)
      assert.equal(scoreTrial(bytes,{...trial,wall_seconds:6000},root).autonomous_complete,false)
      assert.equal(scoreTrial(bytes,{...trial,execution_status:'infra_error'},root).autonomous_complete,false)
      assert.equal(scoreTrial(bytes,{...trial,observations:[]},root).quality_points,0)
      assert.throws(()=>scoreTrial(bytes,{...trial,artifact_sha256:'b'.repeat(64)},root),/ARTIFACT_CHANGED/)
      assert.throws(()=>scoreTrial(bytes,{...trial,observations:[...trial.observations,trial.observations[0]]},root),/DUPLICATE_CHECK/)
    }
    writeFileSync(join(root,'evidence.txt'),'tampered')
    const task=suite.tasks[0]
    const invalid={protocol_sha256:sha256(bytes),run_id:'x',task_id:task.id,system_id:'x',configuration_id:'x',seed:'1',evaluator_id:'x',track:'H',
      execution_status:'completed',wall_seconds:1,cost_rmb:1,technical_interventions:0,artifact_sha256:'a'.repeat(64),
      observations:[{check_id:'B1',status:'pass',artifact_sha256:'a'.repeat(64),evidence:[{path:'evidence.txt',sha256:sha256('controlled test evidence')}]}]}
    assert.throws(()=>scoreTrial(bytes,invalid,root),/EVIDENCE_CHANGED/)
  }finally{rmSync(root,{recursive:true,force:true})}
})

test('standalone benchmark rejects changed common settings and binds actual run environment at start',()=>{
  const root=mkdtempSync(join(tmpdir(),'benchmark-configuration-')),pack=join(root,'pack'),run=join(root,'trial')
  try{
    cpSync('benchmarks/software-v0.1',pack,{recursive:true})
    cpSync('scripts/score-software-benchmark.mjs',join(pack,'tools/scoring.mjs'))
    cpSync('tests/fixtures/software-agent-benchmark/tasks.v0.1.json',join(pack,'tasks.json'))
    const cli=(...args)=>spawnSync(process.execPath,[join(pack,'tools/bench.mjs'),...args],{encoding:'utf8'})
    assert.equal(cli('init','equipment-lending',run).status,0)
    const environment=JSON.parse(readFileSync(join(run,'run-environment.json'),'utf8').replaceAll('TO_BE_SET','controlled-test-fixture'))
    environment.common_assets_verified=true
    environment.effective_reasoning_effort='low'
    writeFileSync(join(run,'run-environment.json'),JSON.stringify(environment))
    let result=cli('event',run,'start','fixture only')
    assert.notEqual(result.status,0);assert.match(result.stderr,/configuration mismatch/)
    environment.effective_reasoning_effort='high'
    const environmentBytes=JSON.stringify(environment)
    writeFileSync(join(run,'run-environment.json'),environmentBytes)
    const studyBytes=readFileSync(join(run,'study.json'))
    const changed=JSON.parse(studyBytes);changed.output_limit=4096
    writeFileSync(join(run,'study.json'),JSON.stringify(changed))
    result=cli('event',run,'start','fixture only')
    assert.notEqual(result.status,0);assert.match(result.stderr,/frozen shared study/)
    writeFileSync(join(run,'study.json'),studyBytes)
    assert.equal(cli('event',run,'start','fixture only').status,0)
    const event=JSON.parse(readFileSync(join(run,'events.jsonl'),'utf8').trim())
    assert.equal(event.environment_sha256,sha256(environmentBytes))
    assert.equal(event.study_sha256,sha256(studyBytes))
    assert.equal(cli('event',run,'stop','fixture only').status,0)
    const trial=JSON.parse(readFileSync(join(run,'trial.json'),'utf8'))
    Object.assign(trial,{system_id:'fixture',configuration_id:'fixture',evaluator_id:'fixture'})
    writeFileSync(join(run,'trial.json'),JSON.stringify(trial))
    writeFileSync(join(run,'artifact-manifest.json'),JSON.stringify({artifact_sha256:'a'.repeat(64),files:[]}))
    writeFileSync(join(run,'run-environment.json'),environmentBytes+'\n')
    result=cli('finalize',run)
    assert.notEqual(result.status,0);assert.match(result.stderr,/run environment changed after start/)
    writeFileSync(join(run,'run-environment.json'),environmentBytes)
    result=cli('finalize',run)
    assert.equal(result.status,0,result.stderr)
    const score=JSON.parse(readFileSync(join(run,'score.json'),'utf8'))
    assert.equal(score.quality_points,0);assert.equal(score.artifact_complete,false)
  }finally{rmSync(root,{recursive:true,force:true})}
})
