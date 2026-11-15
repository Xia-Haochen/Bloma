import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const statuses = new Set(['completed','timed_out','budget_exhausted','agent_error','infra_error','user_stopped'])

// This consumes externally adjudicated observations. File hashes bind their
// identity; an independent evaluator remains responsible for their meaning.
export function scoreTrial(suiteBytes, trial, evidenceRoot) {
  const suite = JSON.parse(suiteBytes)
  assert.equal(trial.protocol_sha256, sha256(suiteBytes), 'PROTOCOL_CHANGED')
  assert.ok(['H','P'].includes(trial.track), 'TRACK_REQUIRED')
  for (const field of ['run_id','system_id','configuration_id','seed','evaluator_id']) {
    assert.ok(typeof trial[field] === 'string' && trial[field].trim(), field+' required')
  }
  assert.ok(statuses.has(trial.execution_status), 'EXECUTION_STATUS_REQUIRED')
  const task = suite.tasks.find(item => item.id === trial.task_id)
  assert.ok(task, 'UNKNOWN_TASK')
  assert.equal(new Set(task.checks.map(check => check.id)).size, task.checks.length)
  assert.equal(task.checks.reduce((sum, check) => sum + check.points, 0), 100)
  assert.ok(Number.isFinite(trial.wall_seconds) && trial.wall_seconds >= 0)
  assert.ok(Number.isInteger(trial.technical_interventions) && trial.technical_interventions >= 0)
  assert.ok(trial.cost_rmb === null || Number.isFinite(trial.cost_rmb) && trial.cost_rmb >= 0)
  assert.ok(Array.isArray(trial.observations))
  const observations = new Map()
  for (const row of trial.observations) {
    assert.ok(task.checks.some(check => check.id === row.check_id), 'UNKNOWN_CHECK')
    assert.ok(!observations.has(row.check_id), 'DUPLICATE_CHECK')
    assert.ok(['pass','fail','unverified'].includes(row.status))
    if (row.status === 'pass') {
      assert.match(trial.artifact_sha256 ?? '', /^[a-f0-9]{64}$/)
      assert.equal(row.artifact_sha256, trial.artifact_sha256, 'ARTIFACT_CHANGED')
      assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0, 'EVIDENCE_REQUIRED')
      for (const file of row.evidence) {
        assert.equal(sha256(readFileSync(resolve(evidenceRoot,file.path))), file.sha256, 'EVIDENCE_CHANGED')
      }
    }
    observations.set(row.check_id,row)
  }
  const dimensions = Object.fromEntries(Object.keys(suite.dimensions).map(key => [key,0]))
  const missing = []
  for (const check of task.checks) {
    assert.ok(Object.hasOwn(dimensions,check.dimension))
    assert.ok(Number.isFinite(check.points) && check.points > 0)
    if (observations.get(check.id)?.status === 'pass') dimensions[check.dimension] += check.points
    else if (check.mandatory) missing.push(check.id)
  }
  for (const [dimension, total] of Object.entries(suite.dimensions)) {
    assert.equal(task.checks.filter(check => check.dimension === dimension).reduce((sum,check)=>sum+check.points,0),total)
  }
  const inBudget = trial.wall_seconds <= suite.limits.wall_seconds &&
    trial.cost_rmb !== null && trial.cost_rmb <= suite.limits.cost_rmb
  const artifactComplete = missing.length === 0
  const excluded = ['infra_error','user_stopped'].includes(trial.execution_status)
  return {
    run_id:trial.run_id, task_id:task.id, system_id:trial.system_id, track:trial.track,
    protocol_status:suite.status, rank_eligible:suite.status === 'frozen' && !excluded,
    artifact_complete:artifactComplete,
    autonomous_complete:artifactComplete && inBudget && !excluded && trial.technical_interventions === 0,
    quality_points:Object.values(dimensions).reduce((sum,points)=>sum+points,0),
    dimensions, missing_mandatory:missing, budget_verified:inBudget,
    wall_seconds:trial.wall_seconds, cost_rmb:trial.cost_rmb,
    technical_interventions:trial.technical_interventions, execution_status:trial.execution_status,
    unverified:task.checks.filter(check=>!observations.has(check.id)||observations.get(check.id).status==='unverified').map(check=>check.id),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [suiteFile, trialFile] = process.argv.slice(2)
  assert.ok(suiteFile && trialFile,'Usage: node scripts/score-software-benchmark.mjs SUITE_JSON TRIAL_JSON')
  console.log(JSON.stringify(scoreTrial(readFileSync(suiteFile),JSON.parse(readFileSync(trialFile,'utf8')),dirname(resolve(trialFile))),null,2))
}
