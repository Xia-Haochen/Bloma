import { expect, it } from 'vitest'
import { findingNeedsClosure, qualityCloseout, qualityWorkQueue, observedQualityFinding } from '../../../main/software/quality-closeout'
import { visualCoverageComplete } from '../../../main/software/visual-review-checklist'
import type { Identity, Ledger, QualityFinding } from '../../../main/software/quality-ledger'
import replay from '../../fixtures/quality-convergence-replay-20261104.json'

const identity: Identity = { source: 'source', target: 'target', environment: 'env' }
const finding = (changes: Partial<QualityFinding> = {}): QualityFinding => ({ id: 'f', review: 'r', identity,
  requirement: 'F-001', expected_source: 'confirmed', category: 'data', severity: 'high', location: 'form',
  trigger: 'save', evidence: 'record', reproduction: 'save/reopen', unknowns: '', disposition: 'suspected', checks: [], ...changes })
const ledger = (findings: QualityFinding[]): Ledger => ({ version: 1, reviews: [], findings })
it('replays real decision fields: historical important doubts remain work after the final source edit',()=>{
  const rows=replay.findings.map(f=>({expected_source:'omitted in projection',category:'projection',location:'omitted',trigger:'omitted',evidence:'omitted',reproduction:'omitted',unknowns:'',...f})) as QualityFinding[]
  const result=qualityCloseout(ledger(rows),replay.current_identity,{code:'code_review',message:'QUALITY_REVIEW_REQUIRED'},'current-rules')
  const required=rows.filter(f=>f.disposition==='suspected'&&(f.severity==='high'||f.severity==='critical'||f.review_kind==='visual'&&f.severity==='medium'))
  expect(required.length).toBeGreaterThan(0)
  expect(result.required_investigation).toEqual(required.map(f=>f.id))
  expect(result.next_tool).toBe('start_visual_review')
  expect(rows.every(f=>f.checks.length===0)).toBe(true)
})
it('carries important suspicions across edits and gives current evidence priority over repeated review',()=>{
  const f=finding(),changed={...identity,source:'edited'}
  const facts=ledger([f,...Array.from({length:100},(_,i)=>finding({id:'idea'+i,disposition:'suggestion',evidence:'historical prose'.repeat(100)}))])
  const queue=qualityWorkQueue(facts,changed,{code:'code_review',message:'QUALITY_REVIEW_REQUIRED'},'rules')
  expect(queue).not.toHaveProperty('closeout')
  expect(queue.problems).toEqual([expect.objectContaining({id:'f',expected:f.expected_source,trigger:f.trigger,observation:f.evidence,missing:f.reproduction})]);expect(queue.history.findings).toBe(101)
  expect(JSON.stringify(queue).length).toBeLessThan(JSON.stringify(facts).length/10)
  expect(qualityCloseout(facts,{...changed,target:'different goal'},undefined,'rules').required_investigation).toEqual(['f']) // callers filter retired requirements, not arbitrary identity changes
})
it('orders real defects before repeated reviews and defers enhancements without deleting evidence', () => {
  const rows = [finding(), finding({ id: 'idea', disposition: 'suggestion' }), finding({ id: 'dispute', disposition: 'disputed' })]
  const facts = ledger(rows), before = JSON.stringify(facts)
  expect(qualityCloseout(facts, identity, {code:'code_review',message:'QUALITY_REVIEW_REQUIRED'}, 'rules')).toMatchObject({
    next_tool: 'start_quality_review', investigate: ['f'], deferred: ['idea', 'dispute'], verification: 'not_issued' })
  expect(JSON.stringify(facts)).toBe(before)
  expect(qualityCloseout(ledger(rows.slice(1)), identity, undefined, 'rules').next_tool).toBe('verify_app')
})
it('keeps medium visual defects blocking until a passing check matches current source and frozen rules', () => {
  const check = { at: '', identity, case_name: 'layout', rules: 'rules', grounded:true, outcome: 'failed' as const, observation: 'clipped control' }
  const f = finding({ severity: 'medium', review_kind: 'visual', disposition: 'confirmed', checks: [check] })
  expect(findingNeedsClosure(f, identity, 'rules')).toBe(true)
  f.disposition = 'closed'; f.checks.push({ ...check, outcome: 'passed' })
  expect(findingNeedsClosure(f, identity, 'rules')).toBe(false)
  expect(findingNeedsClosure(f, { ...identity, source: 'changed' }, 'rules')).toBe(true)
  expect(findingNeedsClosure(f, identity, 'changed-rules')).toBe(true)
})
it('never ignores an actually reproduced agreed-case failure merely because the reviewer rated it low',()=>{
  const f=finding({severity:'low',review_kind:'code',disposition:'confirmed',checks:[{at:'',identity,case_name:'saved-data',rules:'rules',grounded:true,outcome:'failed',observation:'actual mismatch'}]})
  expect(findingNeedsClosure(f,identity,'rules')).toBe(true)
  expect(qualityCloseout(ledger([f]),identity,undefined,'rules').must_fix).toEqual(['f'])
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
it('recognizes an explicit first failed assertion without requiring a previously successful assertion',()=>{
  const result=(assertion?:object)=>({status:'failed',summary:'failed',core:{host_gui:{method:'node:test',case_results:[{name:'first',feature:'F-001',assertions:0,status:'failed'}],steps:[{passed:false,actual:{test:'first',assertion}}]}}}) as never
  expect(observedQualityFinding(result({expected:true,actual:false}),finding(),'first')).toBe('failed')
  expect(observedQualityFinding(result(),finding(),'first')).toBe('unverified')
})

it('routes by typed qualification rather than message text and applies approved corrections before retesting',()=>{
 expect(qualityCloseout(ledger([]),identity,{code:'code_review',message:'任意可读说明'},'rules').next_tool).toBe('start_quality_review')
 const f=finding({disposition:'confirmed',checks:[{at:'',identity,case_name:'case',rules:'rules',grounded:true,outcome:'failed',observation:'failure'}]})
 expect(qualityCloseout(ledger([f]),identity,{code:'apply_correction',message:'先应用批准的纠正'},'rules').next_tool).toBe('apply_test_correction')
})

it('schedules independent review for new host observations but not the same observation again',()=>{
 const facts=ledger([finding()]);facts.reviews.push({id:'review',kind:'code',identity,status:'complete',at:'',observation:{digest:'observed',ui:{},steps:[],logs:[]}})
 const block={code:'investigation' as const,message:'需要具体观察'}
 expect(qualityCloseout(facts,identity,block,'rules',undefined,'observed').next_tool).toBe('inspect_app')
 expect(qualityCloseout(facts,identity,block,'rules',undefined,'new-observation').next_tool).toBe('start_quality_review')
 expect(facts.findings[0].disposition).toBe('suspected')
})

it('a later interrupted review prevents an older completion from directing the maker back into inspection',()=>{
 const facts=ledger([finding()]);facts.reviews.push({id:'old',kind:'code',identity,status:'complete',at:''},{id:'stopped',kind:'code',identity,status:'interrupted',at:''})
 expect(qualityCloseout(facts,identity,{code:'investigation',message:'仍需审阅'},'rules').next_tool).toBe('start_quality_review')
})

it('never treats legacy prose as runtime evidence and exposes the missing case obligation',()=>{
 const f=finding({reviewed:{identity,review:'r',evidence:'code changed'}})
 const facts=ledger([f]);facts.reviews.push({id:'r',kind:'code',purpose:'binding',identity,status:'complete',at:''})
 const queue=qualityWorkQueue(facts,identity,{code:'investigation',message:'missing runtime'},'rules')
 expect(queue.problems[0].investigation).toMatchObject({finding_id:'f',binding:null,missing:'independently_confirmed_case',steps:f.reproduction})
 expect(qualityCloseout(facts,identity,undefined,'rules').required_investigation).toEqual(['f'])
})
it('keeps partial reviews out of candidate qualification and schedules an accepted binding for execution',()=>{
 const f=finding({retest:{identity,review:'binding',case_name:'target',rules:'rules',evidence:'independently checked trigger'}})
 const facts=ledger([f]);facts.reviews.push({id:'binding',kind:'code',purpose:'binding',identity,status:'complete',at:''})
 expect(qualityCloseout(facts,identity,{code:'investigation',message:'execute'},'rules')).toMatchObject({next_tool:'verify_app',required_investigation:['f']})
 expect(qualityWorkQueue(facts,identity,undefined,'rules').problems[0].investigation.binding).toEqual({case_name:'target',rules:'rules'})
})
