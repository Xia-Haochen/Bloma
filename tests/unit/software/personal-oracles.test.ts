import { expect, it } from 'vitest'
import { deriveExpected } from '../../../main/software/independent-oracles'
import { assessIndependentCases, parseIndependentCases } from '../../../main/software/independent-semantics'
import { validateIntentObservations, bindIntentFindings } from '../../../main/software/intent-review'
import { organizedPrd } from '../../support/organized-prd'
import { bindAcceptance, requirementEvidenceHash } from '../../../main/project/requirement-contract'

it('computes closed numeric/set operators without floating point drift or executable expressions', () => {
  expect(deriveExpected('sum_decimal', ['0.1','0.2','-0.05'])).toBe('0.25')
  expect(deriveExpected('sum_decimal', ['-1','1'])).toBe('0')
  expect(deriveExpected('count_inputs', ['A','B'])).toBe('2')
  expect(deriveExpected('sorted_unique', ['B','A','B'])).toBe('A\nB')
  expect(() => deriveExpected('sum_decimal', ['process.exit()'])).toThrow('INVALID')
  expect(() => deriveExpected('sum_decimal', ['1e20'])).toThrow('INVALID')
})
it('grounds derived assertions only in confirmed operations and same-object prior inputs', () => {
  const source = '把输入的小数相加'
  const organized = organizedPrd([{id:'F-001',description:source}], source)
  organized.requirements_model.rules = [{ id:'BR-001',statement:source,source_ids:['S-001'],feature_ids:['F-001'],origin:'user',verification:{operation:'sum_decimal'} }]
  const brief = bindAcceptance({ project_id:'fixture',name:'fixture',positioning:source,requirements:organized.requirements,requirements_model:organized.requirements_model,acceptance:{'F-001':source},out_of_scope:[],assumptions:[] })
  const contract = parseIndependentCases(JSON.stringify({cases:[{id:'sum',feature:'F-001',coverage:['normal'],basis:{expected_source:source,requirement_hash:requirementEvidenceHash(brief,brief.requirements[0])},steps:[
    {kind:'fill',control:'a',value:'0.1',subject:'A'}, {kind:'fill',control:'b',value:'0.2',subject:'A'},
    {kind:'expect',control:'total',equals:'0.3',subject:'A',oracle:{kind:'derived',version:1,rule_id:'BR-001',steps:[0,1]}}]}]}),['F-001'])
  expect(assessIndependentCases(brief,contract).cases[0].status).toBe('grounded')
  const last = contract.cases[0].steps[2]; if(last.kind!=='expect')throw Error('fixture')
  last.equals='0.30000000000000004';expect(assessIndependentCases(brief,contract).cases[0].status).toBe('disputed')
  last.equals='0.3';contract.cases[0].steps[1].subject='B';expect(assessIndependentCases(brief,contract).cases[0].status).toBe('disputed')
})
it('requires each distinctive commitment to receive evidence and limitations, never a generic PASS', () => {
  const experience = {summary:'互动',commitments:[{id:'EXP-001',statement:'轮流辩论',source_ids:['S-001'],feature_ids:['F-001'],scenario_ids:['AC-001'],unacceptable_substitute:'通用聊天框'}]}
  expect(()=>validateIntentObservations([],experience)).toThrow('REQUIRED')
  expect(()=>validateIntentObservations([{commitment_id:'EXP-001',status:'PASS',evidence:'好',limitations:'无'}],experience)).toThrow('INVALID')
  expect(validateIntentObservations([{commitment_id:'EXP-001',status:'unverified',evidence:'只有静态截图',limitations:'未见轮次切换'}],experience)?.[0].status).toBe('unverified')
})
it('binds a core concern only to explicitly cited findings, not every suggestion sharing its feature',()=>{
  const experience={summary:'互动',commitments:[{id:'EXP-001',statement:'轮流辩论',source_ids:['S-001'],feature_ids:['F-001'],scenario_ids:['AC-001'],unacceptable_substitute:'通用聊天框'}]}
  const observation={commitment_id:'EXP-001',status:'concern',evidence:'轮次未切换',limitations:'未运行'}
  const findings=[{id:'unrelated-suggestion',requirement:'F-001'},{id:'actual-concern',requirement:'F-001'},{id:'foreign',requirement:'F-002'}]
  expect(()=>validateIntentObservations([observation],experience)).toThrow('INDICES_REQUIRED')
  const parsed=validateIntentObservations([{...observation,finding_indices:[1]}],experience)
  expect(bindIntentFindings(parsed,experience,findings)?.[0].finding_ids).toEqual(['actual-concern'])
  for(const index of [2,9])expect(()=>bindIntentFindings(validateIntentObservations([{...observation,finding_indices:[index]}],experience),experience,findings)).toThrow('REFERENCE_INVALID')
  expect(()=>validateIntentObservations([{...observation,finding_indices:[1,1]}],experience)).toThrow('INVALID')
  expect(()=>validateIntentObservations([{...observation,finding_indices:[-1]}],experience)).toThrow('INVALID')
})
