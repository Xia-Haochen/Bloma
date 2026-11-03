import { expect, it } from 'vitest'
import { bindAcceptance, requirementEvidenceHash } from '../../../main/project/requirement-contract'
import { parseIndependentCases, assessIndependentCases } from '../../../main/software/independent-semantics'
import type { PrdBackplane } from '../../../main/model/prd-backplane'

const brief=bindAcceptance({project_id:'p',name:'器材',positioning:'借还维修',requirements:[
  {id:'F-001',description:'借用器材',priority:'P0'}, {id:'F-002',description:'维修约束',priority:'P0'}],
  acceptance:{'F-001':'点击借用显示处理结果','F-002':'维修期间显示不可借用'},constraints:[],out_of_scope:[],assumptions:[]} as PrdBackplane)
const contract=()=>({cases:[{id:'borrow',feature:'F-001',basis:{requirement_hash:requirementEvidenceHash(brief,brief.requirements[0]),expected_source:brief.acceptance['F-001']},
  related:[{feature:'F-002',requirement_hash:requirementEvidenceHash(brief,brief.requirements[1]),expected_source:brief.acceptance['F-002']}],coverage:['normal'],
  steps:[{kind:'click',control:'borrow'},{kind:'expect',control:'result',equals:'不可借用',oracle:{kind:'literal',quote:'不可借用'}}]}]})
it('grounds a cross-feature oracle but never counts a context reference as coverage',()=>{
  const parsed=parseIndependentCases(JSON.stringify(contract()),['F-001','F-002'])
  const result=assessIndependentCases(brief,parsed)
  expect(result.cases[0].status).toBe('grounded')
  expect(result.coverage.find(c=>c.feature==='F-002'&&c.category==='normal')?.status).toBe('missing')
  expect(result.ready).toBe(false)
})
it('disputes stale linked rules and refuses foreign feature references',()=>{
  const changed=contract();changed.cases[0].related[0].requirement_hash='stale'
  expect(assessIndependentCases(brief,parseIndependentCases(JSON.stringify(changed),['F-001','F-002'])).cases[0].status).toBe('disputed')
  expect(()=>parseIndependentCases(JSON.stringify(contract()),['F-001'])).toThrow('RELATED_INVALID')
})
