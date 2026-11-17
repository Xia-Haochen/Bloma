import { adoptLeanSuggestions, parseLeanSuggestions } from '../../../main/guide/lean-suggestions'
import { expect, it } from 'vitest'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { projectPlanView, validateProjectPlan } from '../../../main/software/project-plan'
import { prdScopeFingerprint, requirementEvidenceHash } from '../../../main/project/requirement-contract'
import type { PrdBackplane } from '../../../main/model/prd-backplane'
const previous = { project_id:'p', name:'p', positioning:'', requirements:[], acceptance:{}, out_of_scope:[], assumptions:[] } as PrdBackplane
const requirements = Array.from({length:10},(_,i)=>({ description:`能力${i}`, expected:`结果${i}` }))
const ids = requirements.map((_,i)=>`F-${String(i+1).padStart(3,'0')}`)
const plan = {version:1, current:'first', stages:[{id:'first',title:'首阶段',feature_ids:ids.slice(0,3)},{id:'later',title:'后续',feature_ids:ids.slice(3)}]}
function parse(project_plan: unknown = plan, prior = previous) {
  return parseLeanBrief(JSON.stringify({action:'brief',goal:'完整产品',ui:'none',requirements,project_plan}),{projectId:'p',sessionId:'s',source:'全部十项',previous:prior,software:true})
}
it('keeps all ten verification obligations while exposing only three current reading targets',()=>{
  const result=parse()!;if(result.action!=='brief')throw Error('brief')
  const before=JSON.stringify(result.brief)
  expect(projectPlanView(result.brief)).toMatchObject({current_feature_ids:ids.slice(0,3),other_required_feature_ids:ids.slice(3),verification_feature_ids:ids})
  expect(JSON.stringify(result.brief)).toBe(before)
  const next={...result.brief,project_plan:{...result.brief.project_plan!,current:'later'}}
  expect(prdScopeFingerprint(next)).not.toBe(prdScopeFingerprint(result.brief))
  expect(requirementEvidenceHash(next,next.requirements[0])).toBe(requirementEvidenceHash(result.brief,result.brief.requirements[0]))
  const adopted=parseLeanSuggestions([{title:'导出',description:'导出记录',benefit:'备份',expected:'得到文件'}])
  const extended=adoptLeanSuggestions(result.brief,adopted,[adopted[0].id])
  expect(extended.requirements).toHaveLength(11)
  expect(projectPlanView(extended).verification_feature_ids).toHaveLength(11)
  expect(extended.user_confirmed_at).toBeUndefined()
})
it('rejects omissions, duplicates, unknown features and invalid current stage instead of silently reducing scope',()=>{
  for(const bad of [{...plan,current:'missing'},{...plan,stages:plan.stages.slice(0,1)},
    {...plan,stages:[...plan.stages,{id:'duplicate',title:'dup',feature_ids:[ids[0]]}]},
    {...plan,stages:[{id:'x',title:'x',feature_ids:[...ids,'F-999']}]}]) {
    expect(()=>validateProjectPlan(bad,ids)).toThrow()
    expect(parse(bad)).toBeUndefined()
  }
})
it('leaves simple tasks on the same cumulative brief without requiring a plan',()=>{
  const result=parse(null);expect(result).toBeUndefined()
  const simple=parseLeanBrief(JSON.stringify({action:'brief',goal:'小工具',ui:'none',requirements:requirements.slice(0,1)}),{projectId:'p',sessionId:'s',source:'小工具',previous,software:true})!
  if(simple.action!=='brief')throw Error('brief')
  expect(simple.brief.project_plan).toBeUndefined()
  expect(projectPlanView(simple.brief).verification_feature_ids).toEqual(['F-001'])
})
