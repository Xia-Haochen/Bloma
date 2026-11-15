import { expect, it } from 'vitest'
import { runCapabilityVerifiers, type CapabilityContext } from '../../../main/desktop/capability-verifiers'

const context = (manifest: Record<string, unknown>): CapabilityContext => ({ projectId: 'fixture', root: process.cwd(), manifest,
  backplane: { requirements: [{ id: 'F-001', description: '讲解', capabilities: ['llm'] }, { id: 'F-002', description: '追问', capabilities: ['llm'] }] } as never })
it('names missing and unknown model feature mappings before trying an invalid client', async () => {
  const results=await runCapabilityVerifiers(context({ llm: { module: 'must-not-load', factory: 'Client', method: 'call', covers: ['F-001', 'F-999'] } }))
  expect(results[0]).toMatchObject({status:'unverified',features:{'F-001':'unverified','F-002':'unverified'}})
  expect(results[0].missing.join()).toMatch(/MODEL_COVERAGE_INVALID:.*"missing":\["F-002"\].*"unknown":\["F-999"\]/)
})
it('preserves a separate speech declaration failure when model coverage also has errors', async () => {
  const input=context({speech:{module:'src/voice.cjs',factory:'Voice',method:'transcribe'},llm:{covers:['F-999']}})
  input.backplane.requirements.push({id:'F-003',description:'麦克风输入',capabilities:['speech']} as never)
  const results=await runCapabilityVerifiers(input)
  expect(results.map(row=>row.verifier_id)).toEqual(['speech','llm'])
  expect(results[0].report?.speech?.error).toContain('ASR_ENTRY_INVALID')
  expect(results[1].missing.join()).toContain('MODEL_COVERAGE_INVALID')
})
it('keeps undeclared model features unverified and identifies the missing feature IDs', async () => {
  const results = await runCapabilityVerifiers(context({}))
  expect(results[0]).toMatchObject({ status: 'unverified', features: { 'F-001': 'unverified', 'F-002': 'unverified' } })
  expect(results[0].missing.join()).toContain('F-001,F-002')
})
