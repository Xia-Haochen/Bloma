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

it('uses the confirmed source feature for downstream text and the host probe for speech', () => {
  const task = bindAcceptance({ ...brief, requirements: [
    { id: 'F-001', description: '采集用户语音并转写为文字', priority: 'P0' },
    { id: 'F-002', description: '整理文字', priority: 'P0' },
    { id: 'F-003', description: '把整理结果写入当前输入框', priority: 'P0' },
  ], acceptance: { 'F-001': '语音有对应转写', 'F-002': '输入「嗯，我到了」应显示「我到了」', 'F-003': '输入框收到整理结果' } })
  const cases = task.requirements.map((row, index) => {
    const expected = {
      kind: 'expect', control: 'target', property: 'value', equals: '我到了',
      oracle: { kind: 'literal', feature: 'F-002', quote: '我到了' },
    }
    return { id: row.id, feature: row.id, coverage: ['normal'],
      basis: { requirement_hash: requirementEvidenceHash(task, row), expected_source: task.acceptance[row.id] },
      steps: index === 0 ? [{ kind: 'speech_probe' }] : [{ kind: 'click', control: 'apply' }, expected] }
  })
  const parse = () => parseIndependentCases(JSON.stringify({ cases }), task.requirements.map(row => row.id))
  expect(assessIndependentCases(task, parse()).ready).toBe(true)
  // An altered upstream contract invalidates the downstream assertion even
  // though the destination requirement itself has not changed.
  const amended = bindAcceptance({ ...task, acceptance: { ...task.acceptance, 'F-002': '输出「已经抵达」' } })
  expect(assessIndependentCases(amended, parse()).cases[2].status).toBe('disputed')
  cases[2].steps = [{ kind: 'speech_probe' }]
  expect(assessIndependentCases(task, parse()).cases[2].status).toBe('disputed')
})
