import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { beginProjectAssignment, projectTaskView } from '../../../main/software/task-assignment'
let home: string, old: string | undefined, project: ReturnType<typeof createProject>, budget: ReturnType<typeof leanBudget>
beforeEach(()=>{
  old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'project-assignment-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'保存',ui:'none',requirements:[{description:'保存记录',expected:'重开保留'}]}),
    {projectId:project.project_id,sessionId:'s',source:'保存',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture')
  syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
  budget=leanBudget(project.project_id,'desktop-implement')
})
afterEach(()=>{try{budget.finishRuntime()}catch{};if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5})})
it('requires the existing lease and refuses duplicate ownership or stale completion after a new attempt',()=>{
  expect(()=>beginProjectAssignment(project.project_id,'s','a')).toThrow('LEASE_REQUIRED')
  budget.startRuntime();const a=beginProjectAssignment(project.project_id,'s','a')
  expect(()=>beginProjectAssignment(project.project_id,'other','b')).toThrow('ALREADY_ACTIVE')
  a.checkpoint('interrupted',{error:'host interrupted'});budget.finishRuntime()
  budget.startRuntime();const b=beginProjectAssignment(project.project_id,'s','b')
  expect(b.task_id).toBe(a.task_id)
  expect(()=>a.checkpoint('verified')).toThrow('STALE')
  b.checkpoint('cancelled')
  expect(()=>b.checkpoint('running')).toThrow('ENDED')
  const view=projectTaskView(project.project_id)
  expect(view.tasks[0].assignment_count).toBe(2)
  expect(view.tasks[0].assignments.map(x=>x.status)).toEqual(['interrupted','cancelled'])
  expect(budget.snapshot().requests).toBe(0)
})
it('does not turn a model completion or a changed source into verified work',()=>{
  budget.startRuntime();const a=beginProjectAssignment(project.project_id,'s','a')
  expect(()=>a.checkpoint('verified')).toThrow('EVIDENCE_REQUIRED')
  const source=projectTaskView(project.project_id).tasks[0].assignments[0].source
  writeFileSync(join(project.root_path,'changed.js'),'new source')
  expect(()=>a.checkpoint('verified',{candidateId:'old',source,check:{path:'missing',sha256:'bad'}})).toThrow('EVIDENCE_REQUIRED')
  expect(projectTaskView(project.project_id).tasks[0].assignments[0].status).toBe('running')
})
