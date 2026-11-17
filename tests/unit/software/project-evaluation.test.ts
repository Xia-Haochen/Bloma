import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { ensureLongtermState, saveLongtermState, recordLongtermDecision } from '../../../main/software/longterm-state'
import { buildProductionContextTool } from '../../../main/desktop/production-context'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { projectEvaluation } from '../../../main/software/project-evaluation'
let home: string, old: string | undefined, project: ReturnType<typeof createProject>
function brief(goal: string) {
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal,ui:'none',requirements:[{description:'保存记录',expected:'重开仍在'}]}),
    {projectId:project.project_id,sessionId:'s',source:goal,previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture')
  syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  markPrdUserConfirmed(project.project_id)
}
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-project-facts-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'longterm'},{workflowVersion:'software-v1'});brief('第一轮')})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5})})
it('replaces a decision with revision protection and preserves its audit history through the public paged view', async()=>{
  const first=recordLongtermDecision(project.project_id,'s','旧方案','既有约定')
  const oldId=first.decisions[0].id
  const next=recordLongtermDecision(project.project_id,'s','新方案','新实现保持原业务',{supersedes:[oldId],expected_revision:first.revision,feature_ids:['F-001']})
  expect(()=>recordLongtermDecision(project.project_id,'s','迟到方案','旧快照',{supersedes:[oldId],expected_revision:first.revision})).toThrow('STALE')
  const tool=buildProductionContextTool(project.project_id),ctx={projectId:project.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  const current=JSON.parse((await tool.execute({topic:'project-state'},ctx)).output)
  expect(current.current_decisions.map((d:{id:string})=>d.id)).toEqual([next.decisions.at(-1)!.id])
  const history=JSON.parse((await tool.execute({topic:'project-state',history:true,limit:1},ctx)).output)
  expect(history.decisions.items[0]).toMatchObject({id:oldId,effective:false})
  expect(history.decisions.next_offset).toBe(1)
})
it('persists a confirmed reading plan through the real document store and public context tool',async()=>{
  const prior=readPrdBackplane(project.project_id)
  const next={...prior,project_plan:{version:1 as const,current:'save',stages:[{id:'save',title:'保存',feature_ids:['F-001']}]}}
  syncDocuments({request_id:'plan',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},next)
  expect(readPrdBackplane(project.project_id).project_plan).toEqual(next.project_plan)
  expect(projectEvaluation(project.project_id).verification_feature_ids).toEqual(['F-001'])
})
it('reads all same-scope decisions, survives reload and does not treat prior delivery as completion of changed scope',async()=>{
  ensureLongtermState(project.project_id,'s')
  for(let i=0;i<15;i++)recordLongtermDecision(project.project_id,'s',`决定${i}`,'依据当前需求')
  expect(projectEvaluation(project.project_id).current_decisions).toHaveLength(15)
  const state=ensureLongtermState(project.project_id,'s');state.milestones[0].status='delivered';saveLongtermState(state)
  expect(projectEvaluation(project.project_id).cumulative_scope_delivered).toBe(true)
  brief('新的整体目标')
  const ctx={projectId:project.project_id,sessionId:'s',requestId:'read',signal:new AbortController().signal,state:createToolState()}
  const tool=buildProductionContextTool(project.project_id)
  const result=await tool.execute({topic:'project-state'},ctx)
  expect(result.isError).not.toBe(true)
  expect(JSON.parse(result.output)).toMatchObject({cumulative_scope_delivered:false,remaining_required_feature_ids:['F-001'],current_decisions:[]})
  expect(JSON.parse(result.output).historical_decision_ids).toHaveLength(15)
  expect((await tool.execute({topic:'project-state'},{...ctx,projectId:'foreign'})).isError).toBe(true)
})
