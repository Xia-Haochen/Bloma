import assert from 'node:assert/strict'

export function equipmentFacts(facts) {
  assert.deepEqual(facts.after_partial,{E01:{total:5,outstanding:2,available:3},E02:{total:3,outstanding:1,available:2},E03:{total:2,outstanding:1,available:1}})
  assert.deepEqual([...facts.overdue].sort(),['M01:E01:1','M02:E03:1'])
  assert.deepEqual(facts.after_restart,{E01:3,E02:2,E03:2,E04:4})
  assert.equal(facts.after_import_and_return.E01,4)
  return {numeric_checks:'passed',covers:['B2','B3','P1','P2'],remaining:'Confirm UI actions, full records and other criteria using evaluator/equipment-lending.md'}
}
export function documentFacts(facts,expected) {
  assert.deepEqual([...facts.imported_files].sort(),Object.keys(expected.files).sort())
  const identity=row=>row.file+'|'+row.location+'|'+row.text
  assert.deepEqual(facts.search_results.map(identity).sort(),expected.search.map(identity).sort())
  assert.deepEqual([...facts.selected_files].sort(),[...expected.selected].sort())
  assert.equal(facts.original_input_sha256_before,facts.original_input_sha256_after)
  assert.match(facts.original_input_sha256_before,/^[a-f0-9]{64}$/)
  assert.ok(facts.exported_text.includes('300'))
  assert.ok(facts.exported_text.includes('林舟'))
  assert.ok(!facts.exported_text.includes('3000'))
  return {data_checks:'passed',covers:['B1','B2','B3','R2','P2'],remaining:'Confirm source navigation, actual service calls, semantic correctness and recovery using evaluator/document-batch-workflow.md'}
}
export function voiceFacts(facts) {
  assert.equal(facts.rounds.length,3)
  for(const round of facts.rounds){
    assert.ok(round.duration>1 && round.ended && !round.muted && round.played_seconds>=round.duration-.15)
    assert.equal(round.text_audio_match,true)
  }
  assert.deepEqual([...facts.recalled_facts].sort(),['300','周五','蓝色','语音助手'].sort())
  assert.equal(facts.current_input_in_request,true)
  assert.equal(facts.history_in_request,true)
  return {observed_checks:'passed',covers:['B2','B3'],remaining:'Validate recorded observations and live-provider semantics with two evaluators using evaluator/voice-conversation.md'}
}
