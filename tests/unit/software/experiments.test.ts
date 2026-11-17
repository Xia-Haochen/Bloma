import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {registerParentLoopContext,startDelegation,findDelegation,disposeParentDelegationState,settleParentDelegationRuns} from '../../../main/agent/delegation/agent-collaboration'
import {createProductionBudget} from '../../../main/desktop/production-budget'
let home:string,old:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-experiment-'));process.env.PROMA_HOME=home;project=createProject({request_id:'new',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(async()=>{disposeParentDelegationState('parent');await settleParentDelegationRuns('parent');if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const ctx=(sessionId='parent')=>({projectId:project.project_id,sessionId,requestId:'r',signal:new AbortController().signal,state:createToolState()})
it('runs an independent failed probe, repairs it, seals evidence and lets the parent integrate the actual artifact',async()=>{
  const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,'parent')
  writeFileSync(join(project.root_path,'input.json'),'[2,3]')
  const lease=policy.prepare({parent:ctx(),args:{task:'能否求和',experiment:{criterion:'结果5',inputs:['input.json']}},childSessionId:'child',delegationId:'d'})
  const childContext=ctx('child'),tools=buildSoftwareAgentTools(project.project_id,'implement',policy,undefined,undefined,undefined,'child'),call=(name:string,args:any)=>tools.find(t=>t.name===name)!.execute(args,childContext)
  expect(tools.some(t=>['verify_app','delegate_agent','prepare_software_capability'].includes(t.name))).toBe(false)
  await call('write_file',{path:'probe.cjs',content:"const fs=require('node:fs'); const xs=JSON.parse(fs.readFileSync('input.json')); fs.writeFileSync('answer.txt',String(xs[0]-xs[1])); if(xs[0]-xs[1]!==5)process.exit(1)"})
  expect((await call('run_command',{command:['node','probe.cjs']})).isError).toBe(true)
  await call('read_file',{path:'probe.cjs'})
  await call('write_file',{path:'probe.cjs',content:"const fs=require('node:fs'); const xs=JSON.parse(fs.readFileSync('input.json')); fs.writeFileSync('answer.txt',String(xs[0]+xs[1])); if(xs[0]+xs[1]!==5)process.exit(1)"})
  const repaired=await call('run_command',{command:['node','probe.cjs']});expect(repaired.isError,repaired.output).toBe(false)
  await call('record_experiment_result',{method:'实际运行Node探针',finding:'2+3=5',verdict:'supports',artifacts:['probe.cjs','answer.txt']})
  expect(existsSync(join(project.root_path,'answer.txt'))).toBe(false)
  const sealed=JSON.parse((await policy.experiments.parentTool.execute({session_id:'child'},ctx())).output)
  await call('write_file',{path:'note.txt',content:'new observation'})
  expect(JSON.parse((await policy.experiments.parentTool.execute({session_id:'child'},ctx())).output).result).toBeUndefined()
  expect(existsSync(join(home,'software-experiments',project.project_id,'child',sealed.result.artifacts[0].stored))).toBe(true)
  await call('record_experiment_result',{method:'Node probe plus review',finding:'2+3=5',verdict:'supports',artifacts:['probe.cjs','answer.txt']})
  expect(lease.completionNote?.()).toContain('agent_claim');lease.release()
  const parent=buildSoftwareAgentTools(project.project_id,'parent',policy)
  const read=JSON.parse((await parent.find(t=>t.name==='read_experiment')!.execute({session_id:'child',artifact:'probe.cjs'},ctx())).output)
  await parent.find(t=>t.name==='write_file')!.execute({path:'integrated.cjs',content:read.text},ctx())
  expect((await parent.find(t=>t.name==='run_command')!.execute({command:['node','integrated.cjs']},ctx())).isError).toBe(false)
  expect(readFileSync(join(project.root_path,'answer.txt'),'utf8')).toBe('5')
  await expect(call('write_file',{path:'late.txt',content:'late'})).rejects.toThrow('NOT_ACTIVE')
},30000)
it('keeps reviews read-only and refuses escapes and unsupported evidence claims',async()=>{
  const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,'parent')
  expect(()=>policy.prepare({parent:ctx(),args:{task:'x',role:'review',experiment:{criterion:'x'}},childSessionId:'c',delegationId:'d'})).toThrow('CONTRACT_INVALID')
  const lease=policy.prepare({parent:ctx(),args:{task:'x',experiment:{criterion:'x'}},childSessionId:'c',delegationId:'d'})
  const tools=policy.experiments.tools('c')
  await expect(tools.find(t=>t.name==='record_experiment_result')!.execute({method:'guess',finding:'pass',verdict:'supports',artifacts:[]},ctx('c'))).rejects.toThrow('EXECUTION_REQUIRED')
  expect((await tools.find(t=>t.name==='write_file')!.execute({path:'../escape.js',content:'bad'},ctx('c'))).isError).toBe(true)
  lease.release()
})
it('retains unfinished artifacts for parent review without inventing an experiment verdict',async()=>{
  const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,'parent'),lease=policy.prepare({parent:ctx(),args:{task:'unfinished',experiment:{criterion:'not yet checked'}},childSessionId:'c',delegationId:'d'})
  await policy.experiments.tools('c').find(t=>t.name==='write_file')!.execute({path:'partial.py',content:'print(5)'},ctx('c'))
  expect(lease.completionNote?.()).toContain('unverified');lease.release()
  const report=JSON.parse((await policy.experiments.parentTool.execute({session_id:'c'},ctx())).output)
  expect(report.result).toBeUndefined();expect(report.unfinished.artifacts[0].path).toBe('partial.py')
  expect(JSON.parse((await policy.experiments.parentTool.execute({session_id:'c',artifact:'partial.py'},ctx())).output).text).toBe('print(5)')
})
it('cancels an in-flight experiment when its delegation lease ends',async()=>{
  const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,'parent'),lease=policy.prepare({parent:ctx(),args:{task:'cancel probe',experiment:{criterion:'must stop'}},childSessionId:'c',delegationId:'d'})
  const tools=policy.experiments.tools('c'),child=ctx('c')
  const pending=tools.find(t=>t.name==='run_command')!.execute({command:['node','-e',"setTimeout(()=>require('node:fs').writeFileSync('late.txt','bad'),3000)"],timeout_ms:5000},child)
  await new Promise(done=>setTimeout(done,150));lease.release()
  expect((await pending).isError).toBe(true)
  const result=JSON.parse((await policy.experiments.parentTool.execute({session_id:'c'},ctx())).output)
  expect(result.runs[0].error).toBeTruthy();expect(result.product_verified).toBe(false)
})
it('a real delegated loop executes the experiment and returns evidence under the shared budget',async()=>{
  const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,'parent'),budget=createProductionBudget(project.project_id,'op','desktop-implement',{requests:4,phaseRequests:4,output:8192,perResponse:1024})
  const actions=[{name:'write_file',input:{path:'probe.cjs',content:"require('node:fs').writeFileSync('answer.txt','5')"}},{name:'run_command',input:{command:['node','probe.cjs']}},{name:'record_experiment_result',input:{method:'Node probe',finding:'produced 5',verdict:'supports',artifacts:['answer.txt']}}];let step=0
  const query=budget.wrap(async function*(){const action=actions[step++];yield{type:'assistant' as const,message:{role:'assistant' as const,content:action?[{type:'tool_use' as const,id:'t'+step,...action}]:[{type:'text' as const,text:'实验已完成，请读取证据'}]}};yield{type:'result' as const,subtype:'success',usage:{output_tokens:10}}})
  registerParentLoopContext('parent',{query,env:{},maxTokens:1024,maxTurns:8,delegationMaxTurns:8,permissionMode:'allow-all',temperature:.1,system:'test',editFormat:'diff',publish:()=>{},prepareDelegation:policy.prepare,childToolsBuilder:(id,role,_format,child)=>buildSoftwareAgentTools(id,role,policy,undefined,undefined,undefined,child)})
  const delegated=startDelegation(ctx(),{task:'Create a checked output',role:'custom',experiment:{criterion:'answer.txt contains 5'}})
  await findDelegation('parent',delegated.delegation_id)!.completion;await settleParentDelegationRuns('parent')
  const result=findDelegation('parent',delegated.delegation_id)!
  expect(result.resultSummary).toContain('agent_claim');expect(budget.snapshot().requests).toBe(4)
  expect(existsSync(join(project.root_path,'answer.txt'))).toBe(false)
  const evidence=JSON.parse((await policy.experiments.parentTool.execute({session_id:delegated.child_session_id,artifact:'answer.txt'},ctx())).output)
  expect(evidence.text).toBe('5')
},60000)
