import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {createProject} from '../../main/project/project-service'
import {createToolState} from '../../main/agent/loop/agent-loop'
import {registerParentLoopContext,startDelegation,continueDelegation,findDelegation,disposeParentDelegationState,settleParentDelegationRuns} from '../../main/agent/delegation/agent-collaboration'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'

let home:string,project:ReturnType<typeof createProject>
const parent='public-message-parent'
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'bloma-peer-message-'));vi.stubEnv('PROMA_HOME',home);project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(async()=>{disposeParentDelegationState(parent);await settleParentDelegationRuns(parent);vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const context=()=>({projectId:project.project_id,sessionId:parent,requestId:'r',signal:AbortSignal.timeout(20000),state:createToolState()})
function register(query:SDKQuery,onChildMessage:(message:any,child:any)=>void,publish=vi.fn()){
  registerParentLoopContext(parent,{query,env:{},maxTokens:2048,maxTurns:4,delegationMaxTurns:4,permissionMode:'allow-all',system:'private maker context',temperature:.1,editFormat:'diff',publish,
    delegationSummaryLimit:80,liveContext:()=>({shared_fact:'runtime'}),childRuntimeScope:()=> 'engineering-peer',childSystemBuilder:()=> 'Investigate one question independently.',
    childToolsBuilder:()=>[{name:'probe',description:'Observe a fact',input_schema:{type:'object',properties:{}},execute:async()=>({output:'private tool detail'})}],onChildMessage})
}
it('delivers bounded public findings before the child finishes without forwarding reasoning or child chat to user chat',async()=>{
  const received:any[]=[],publish=vi.fn();let calls=0
  const query:SDKQuery=async function*(_prompt,options){
    const context=options.messages?.at(-1)?.content
    expect(typeof context==='string'?context:context?.map(block=>block.text??'').join('')).toContain('"remaining_turns":'+(4-calls))
    if(++calls===1){yield{type:'thinking',thinking:'PRIVATE_REASONING_MARKER'};yield{type:'assistant',message:{role:'assistant',content:[
      {type:'text',text:'需要先验证桌面入口，再决定实现路线。'},
      {type:'tool_use',id:'p',name:'probe',input:{}}]}}}
    else{
      expect(received).toHaveLength(1)
      yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'The current question is answered by the observed runtime facts. Further investigation should target a different uncertainty only when new evidence changes the decision.'}]}}
    }
    yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  register(query,(message,child)=>received.push({...message,role:child.role}),publish)
  const run=startDelegation(context(),{task:'Investigate the launch path',role:'research',readOnly:true})
  await findDelegation(parent,run.delegation_id)!.completion
  expect(received[0]).toMatchObject({text:'需要先验证桌面入口，再决定实现路线。',truncated:false,role:'research'})
  expect(received[1].text).toHaveLength(80);expect(received[1].truncated).toBe(true)
  expect(JSON.stringify(received)).not.toMatch(/PRIVATE_REASONING_MARKER|private tool detail|private maker context/)
  expect(publish.mock.calls.some(([type])=>type==='message_delta'||type==='message_completed')).toBe(false)
})
it('does not deliver a failed partial response as a finding',async()=>{
  let calls=0;const received:any[]=[]
  const query:SDKQuery=async function*(){
    if(++calls===1){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'UNFINISHED_FINDING'}]}};throw Error('temporary transport failure')}
    yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Recovered public observation.'}]}}
    yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  register(query,message=>received.push(message))
  const run=startDelegation(context(),{task:'Observe',role:'research',readOnly:true});await findDelegation(parent,run.delegation_id)!.completion
  expect(received).toEqual([])
  continueDelegation(context(),run.delegation_id,'Continue the same investigation')
  await findDelegation(parent,run.delegation_id)!.completion
  expect(JSON.stringify(received)).not.toContain('UNFINISHED_FINDING')
  expect(received.at(-1)?.text).toBe('Recovered public observation.')
})
