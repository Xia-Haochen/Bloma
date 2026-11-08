import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {createProject,updateProject} from '../../../main/project/project-service'
import {recordSessionActivity} from '../../../main/platform/sessions/session-service'
import {appendSessionMessage} from '../../../main/platform/sessions/session-tree'
import {appendDelegationSettle} from '../../../main/agent/delegation/delegation-persistence'
import {registerParentLoopContext,findDelegation,disposeParentDelegationState,settleParentDelegationRuns} from '../../../main/agent/delegation/agent-collaboration'
import {runAgentLoop,createToolState} from '../../../main/agent/loop/agent-loop'
import {runWithProjectRootOverride} from '../../../shared/project-root-override'
import {createEngineeringWorkspaces} from '../../../main/software/engineering-workspace'
import {createEngineeringPartner} from '../../../main/software/engineering-partner'
import {recoverEngineeringMonitor,recordEngineeringMonitor,recentProductionObservations} from '../../../main/software/engineering-monitor-record'
import type {SDKQuery} from '../../../main/orchestration/stages/orchestration-contracts'

let home:string,project:ReturnType<typeof createProject>,child:string,delegation:string,parent:string
const ctx=()=>({projectId:project.project_id,sessionId:parent,requestId:'new-run',signal:AbortSignal.timeout(60000),state:createToolState()})
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'bloma-monitor-recovery-'));vi.stubEnv('PROMA_HOME',home);project=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'});parent='monitor-'+randomUUID();child=randomUUID();delegation=randomUUID();writeFileSync(join(project.root_path,'app.js'),'original');recordSessionActivity(parent,project.project_id)})
afterEach(async()=>{disposeParentDelegationState(parent);await settleParentDelegationRuns(parent);vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
function attach(finished=true){
  recordSessionActivity(child,project.project_id,{parentSessionId:parent,sourceDelegationId:delegation})
  appendSessionMessage(child,{role:'assistant',content:[{type:'text',text:'OLD_MONITOR_OBSERVATION: seed mismatch needs actual execution.'}],timestamp:Date.now()})
  if(finished)appendDelegationSettle(child,'completed',{resultSummary:'prior observation'})
  recordEngineeringMonitor(ctx(),{delegation_id:delegation,child_session_id:child})
}

it('restores the same tool-capable Pi Agent and its native investigation context from disk',async()=>{
  const context=ctx(),first=createEngineeringWorkspaces(project.project_id,project.root_path,parent)
  const lease=first.prepare(child,{role:'research',task:'Observe',readOnly:true,independentWorkspace:true}),own=first.root(child)
  const initial:SDKQuery=async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'NATIVE_PRIOR_OBSERVATION: check the seed before changing tests.'}]}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}}
  await runWithProjectRootOverride(own,()=>runAgentLoop({projectId:project.project_id,sessionId:child,requestId:'prior-run',parentSessionId:parent,
    accountingRole:'research',delegationDepth:1,runtimeScope:'engineering-peer',executionScope:'test',system:'Independent observer',task:'Observe prior execution',tools:first.tools(child),query:initial,env:{},maxTokens:2048,maxTurns:4,signal:context.signal,permissionMode:'allow-all',publish:()=>{}}))
  lease.release();attach()
  const work=createEngineeringWorkspaces(project.project_id,project.root_path,parent)
  const monitor=createEngineeringPartner(true,id=>work.has(id),{recover:recoverEngineeringMonitor,attached:recordEngineeringMonitor,history:recentProductionObservations,facts:()=>({phase:'implement',actual:'seed 100027; expected 777001'})})
  let calls=0;const sessions=new Set<string>()
  const query:SDKQuery=async function*(_prompt,options){
    sessions.add(options.sessionId);const body=JSON.stringify(options.messages)
    expect(body).toContain('NATIVE_PRIOR_OBSERVATION');expect(body).not.toContain('PRIVATE_MAKER_SYSTEM')
    expect(body).not.toContain('最终回复请以一行');expect(body).not.toContain('保留最后约 1/4')
    const content=++calls===1?[
      {type:'text' as const,text:'种子不一致，需要先核对实验输入；我继续做一个局部探针。'},
      {type:'tool_use' as const,id:'note',name:'write_file',input:{path:'notes.md',content:'Seed mismatch, no approval issued.'}},
      {type:'tool_use' as const,id:'probe',name:'run_command',input:{command:['node','-e','console.log("REAL_LOCAL_PROBE")']}},
    ]:[]
    yield{type:'assistant',message:{role:'assistant',content}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  registerParentLoopContext(parent,{query,env:{},maxTokens:2048,maxTurns:6,delegationMaxTurns:6,system:'PRIVATE_MAKER_SYSTEM',permissionMode:'allow-all',temperature:0,publish:()=>{},executionScope:'test',editFormat:'diff',
    prepareDelegation:input=>work.prepare(input.childSessionId,input.args),childWorkspace:id=>work.root(id),childRuntimeScope:()=> 'engineering-peer',childSystemBuilder:(_r,id)=>work.describe(id),childToolsBuilder:(_p,_r,_f,id)=>id?work.tools(id):[],
    onChildCreated:value=>monitor.created(value),childLoopContext:(id,task)=>({system:work.describe(id),task,liveContext:()=>monitor.context(id),beforeComplete:monitor.beforeComplete(id),allowSilentCompletion:true,publicMessageTiming:'response'}),
    onChildTurn:(info,c)=>monitor.observed(c.sessionId,info),onChildMessage:(message,c)=>monitor.receive(c.sessionId,message,()=>work.facts(c.sessionId))})
  monitor.begin(context);await findDelegation(parent,delegation)!.completion;await settleParentDelegationRuns(parent)
  expect(sessions).toEqual(new Set([child]));expect(calls).toBe(2)
  expect(readFileSync(join(own,'notes.md'),'utf8')).toContain('Seed mismatch')
  expect(work.facts(child)).toMatchObject({run_count:1,recent_runs:[{exit_code:0,product_verified:false}]})
  expect(readFileSync(join(project.root_path,'app.js'),'utf8')).toBe('original')
  expect(monitor.take(context)).toContain('种子不一致')
  monitor.suspend()
},60000)

it('rejects live or foreign research ownership and does not recover across a changed operation',()=>{
  attach(false);expect(()=>recoverEngineeringMonitor(ctx())).toThrow('RECOVERY_UNAVAILABLE')
  appendDelegationSettle(child,'completed',{resultSummary:'ended'})
  expect(recoverEngineeringMonitor({...ctx(),sessionId:'other-parent'})).toBeUndefined()
  const other=createProject({request_id:'other',mode:'quick'},{workflowVersion:'software-v1'})
  recordEngineeringMonitor({...ctx(),projectId:other.project_id},{delegation_id:delegation,child_session_id:child})
  expect(()=>recoverEngineeringMonitor({...ctx(),projectId:other.project_id})).toThrow('RECOVERY_UNAVAILABLE')
  expect(recoverEngineeringMonitor(ctx())?.child_session_id).toBe(child)
  const retained=findDelegation(parent,delegation)!;retained.status='running'
  expect(()=>recoverEngineeringMonitor(ctx())).toThrow('ALREADY_RUNNING');retained.status='completed'
  updateProject(project.project_id,{lean_operation_id:'new-operation'})
  expect(recoverEngineeringMonitor(ctx())).toBeUndefined()
})

it('recovers only public producer statements and tool evidence, excluding private/system/other-agent material',()=>{
  appendSessionMessage(parent,{role:'system',content:[{type:'text',text:'PRIVATE_SYSTEM'}],timestamp:1})
  appendSessionMessage(parent,{role:'user',content:[{type:'text',text:'PRIVATE_USER_HISTORY'}],timestamp:2})
  appendSessionMessage(parent,{role:'assistant',content:[{type:'thinking',text:'PRIVATE_REASONING'},{type:'text',text:'PUBLIC_PLAN: compare actual seed'},{type:'tool_use',id:'probe',name:'inspect_app',input:{seed:777001}}],timestamp:3})
  appendSessionMessage(parent,{role:'user',origin:'system',content:[{type:'tool_result',tool_use_id:'probe',content:'actual seed=100027; api_key=PRIVATE_KEY'}],timestamp:4})
  appendSessionMessage(parent,{role:'user',origin:'user',content:[{type:'text',text:'【用户中途补充】PUBLIC_BOUNDARY: preserve existing data'}],timestamp:5})
  const view=JSON.stringify(recentProductionObservations(ctx()))
  expect(view).toContain('PUBLIC_PLAN');expect(view).toContain('PUBLIC_BOUNDARY');expect(view).toContain('100027');expect(view).not.toContain('PRIVATE_')
})
