import { expect, it } from 'vitest'
import { findingNeedsClosure, qualityCloseout, observedQualityFinding } from '../../../main/software/quality-closeout'
import { visualCoverageComplete } from '../../../main/software/visual-review-checklist'
import type { Identity, Ledger, QualityFinding } from '../../../main/software/quality-ledger'

const identity: Identity = { source: 'source', target: 'target', environment: 'env' }
const finding = (changes: Partial<QualityFinding> = {}): QualityFinding => ({ id: 'f', review: 'r', identity,
  requirement: 'F-001', expected_source: 'confirmed', category: 'data', severity: 'high', location: 'form',
  trigger: 'save', evidence: 'record', reproduction: 'save/reopen', unknowns: '', disposition: 'suspected', checks: [], ...changes })
const ledger = (findings: QualityFinding[]): Ledger => ({ version: 1, reviews: [], findings })
it('orders real defects before repeated reviews and defers enhancements without deleting evidence', () => {
  const rows = [finding(), finding({ id: 'idea', disposition: 'suggestion' }), finding({ id: 'dispute', disposition: 'disputed' })]
  const facts = ledger(rows), before = JSON.stringify(facts)
  expect(qualityCloseout(facts, identity, 'QUALITY_REVIEW_REQUIRED', 'rules')).toMatchObject({
    next_tool: 'check_quality_finding', investigate: ['f'], deferred: ['idea', 'dispute'], verification: 'not_issued' })
  expect(JSON.stringify(facts)).toBe(before)
  expect(qualityCloseout(ledger(rows.slice(1)), identity, undefined, 'rules').next_tool).toBe('verify_app')
})
it('keeps medium visual defects blocking until a passing check matches current source and frozen rules', () => {
  const check = { at: '', identity, case_name: 'layout', rules: 'rules', outcome: 'failed' as const, observation: 'clipped control' }
  const f = finding({ severity: 'medium', review_kind: 'visual', disposition: 'confirmed', checks: [check] })
  expect(findingNeedsClosure(f, identity, 'rules')).toBe(true)
  f.disposition = 'closed'; f.checks.push({ ...check, outcome: 'passed' })
  expect(findingNeedsClosure(f, identity, 'rules')).toBe(false)
  expect(findingNeedsClosure(f, { ...identity, source: 'changed' }, 'rules')).toBe(true)
  expect(findingNeedsClosure(f, identity, 'changed-rules')).toBe(true)
})
it('does not promote a single screenshot observation or repeated category into complete visual coverage', () => {
  expect(visualCoverageComplete([{ area: 'content' }])).toBe(false)
  expect(visualCoverageComplete(Array(4).fill({ area: 'layout' }))).toBe(false)
  expect(visualCoverageComplete(['layout','interaction','content','scope'].map(area => ({ area })))).toBe(true)
})
it('does not confirm a finding from a timeout after earlier successful assertions in the same native case', () => {
  const result = (assertion?: object) => ({ status: 'failed', summary: 'failed', core: { host_gui: {
    method: 'node:test', case_results: [{ name: 'save', feature: 'F-001', assertions: 3, status: 'failed' }],
    steps: [{ passed: false, actual: { test: 'save', error: 'TimeoutError waiting for locator', assertion } }],
  } } }) as never
  expect(observedQualityFinding(result(), finding(), 'save')).toBe('unverified')
  expect(observedQualityFinding(result({ expected: 1, actual: 0 }), finding(), 'save')).toBe('failed')
})
