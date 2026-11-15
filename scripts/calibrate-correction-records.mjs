import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {createHash} from 'node:crypto'

const trial = resolve(process.argv[2])
const output = resolve(process.argv[3])
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const home = join(trial, 'ui-home')
const project = read(join(home, 'projects.json')).projects[0]
const stateFile = join(home, 'software-test-corrections', project.project_id, 'state.json')
const originalHash = digest(stateFile)
const state = read(stateFile)
const golden = digest('main/templates/tools/voice-golden.wav')
const rows = state.proposals.map(proposal => {
  const evidence = proposal.decision?.evidence ?? []
  const records = evidence.map(item => {
    assert.equal(digest(item.path), item.sha256)
    const record = read(item.path)
    const execution = record.input.proposed_execution
    return {
      path: item.path, sha256: item.sha256, decision: record.decision,
      execution: execution && {
        candidate: execution.candidate, source_unchanged: execution.source_unchanged,
        product_verified: execution.product_verified, status: execution.result?.status,
        error: execution.result?.error, cases: execution.result?.case_results,
      },
    }
  })
  const knownFixtures = proposal.after.files.filter(file => file.sha256 === golden).map(file => {
    const frozen = join(home, 'gui-native-tests', project.project_id, proposal.after.digest, file.path)
    assert.equal(digest(frozen), golden)
    return {path: file.path, sha256: golden, provenance: 'exact_host_voice_golden_bytes'}
  })
  return {id: proposal.id, status: proposal.status, reason: proposal.reason,
    before: proposal.before.digest, after: proposal.after.digest, knownFixtures, records}
})
assert.equal(digest(stateFile), originalHash)
mkdirSync(output, {recursive: true})
writeFileSync(join(output, 'correction-records.json'), JSON.stringify({
  project: project.project_id, original_state_sha256: originalHash, source_unchanged: true,
  calibration: 'read-only evidence audit; expected judgments are documented separately; no new model verdict',
  rows,
}, null, 2))
console.log(JSON.stringify({project: project.project_id,proposals:rows.length,
  known_fixture_proposals:rows.filter(row=>row.knownFixtures.length).length,source_unchanged:true}))
