import {mkdtempSync,readFileSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {createProject} from '../../main/project/project-service'
import {recordSessionActivity} from '../../main/platform/sessions/session-service'
import {appendSessionMessage} from '../../main/platform/sessions/session-tree'
import {createToolState} from '../../main/agent/loop/agent-loop'
import {registerParentLoopContext,findDelegation,disposeParentDelegationState,settleParentDelegationRuns,getDelegationSummary} from '../../main/agent/delegation/agent-collaboration'
import {buildDelegationTools} from '../../main/agent/delegation/delegation-tools'
import {createEngineeringPartner} from '../../main/software/engineering-partner'
import {createEngineeringWorkspaces,engineeringSourceVersion} from '../../main/software/engineering-workspace'
import {recordEngineeringMonitor} from '../../main/software/engineering-monitor-record'
import {executeSoftwareCommand} from '../../main/software/command-runtime'
import {qualityLedgerPath} from '../../main/software/quality-ledger'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'

let home:string,project:ReturnType<typeof createProject>,parent:string
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'bloma-engineering-contribution-'));vi.stubEnv('PROMA_HOME',home)
 project=createProject({request_id:'fixture',mode:'quick'},{workflowVersion:'software-v1'});parent='long-'+randomUUID()
 recordSessionActivity(parent,project.project_id)
 appendSessionMessage(parent,{role:'assistant',content:[{type:'thinking',text:'MAKER_PRIVATE_REASONING'}],timestamp:Date.now()})
})
afterEach(async()=>{
 disposeParentDelegationState(parent);await settleParentDelegationRuns(parent);vi.unstubAllEnvs()
 rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})
})

it('carries a directed factual question and three actual version-bound probes through one retained Pi partner, then parks without new consultations',async()=>{
 const started=performance.now(),root=project.root_path,expected=JSON.stringify({args:['7','5'],expected:12,authority:'test-authored fixed case; not an independent C verdict'})
 writeFileSync(join(root,'case.json'),expected);writeFileSync(join(root,'calc.cjs'),'module.exports=(a,b)=>a+b')
 const source=()=>engineeringSourceVersion(root),initialSource=source(),context={projectId:project.project_id,sessionId:parent,requestId:'initial',signal:AbortSignal.timeout(120000),state:createToolState()}
 const work=createEngineeringWorkspaces(project.project_id,root,parent),observations:any[]=[],requests:Array<{phase:number;session:string;message_bytes:number}>=[],phases=[0,0,0]
 let phase=0,child='',delegation='',questions=0,answer:Promise<unknown>|undefined,answerError:unknown
 const monitor=createEngineeringPartner(true,id=>work.has(id),{source,attached:recordEngineeringMonitor,facts:()=>({fixed_case:'case.json',verification:'not_issued'})})
 const questionTool=buildDelegationTools('parent').find(tool=>tool.name==='answer_delegation_question')!
 const probe=`const fs=require('node:fs'),context=JSON.parse(fs.readFileSync('context.json','utf8')),input=JSON.parse(fs.readFileSync(context.snapshot+'/case.json','utf8')),calculate=require('./'+context.snapshot+'/calc.cjs'),actual=calculate(...input.args);console.log(JSON.stringify({args:input.args,expected:input.expected,actual,actual_type:typeof actual}));if(actual!==input.expected)process.exitCode=1`
 const text=['BASIS_V1: exact string inputs reproduce concatenation 75, expected numeric 12; convert both operands, never lower the fixed expected result.','BASIS_V2: converting only the first operand still returns string 75; the new source probe refutes completion.','BASIS_V3: the new source probe returns numeric 12; this is a local probe, not product PASS or a release vote.']
 const query:SDKQuery=async function*(_prompt,options){
  const n=++phases[phase],wire=JSON.stringify(options.messages)
  requests.push({phase,session:options.sessionId,message_bytes:Buffer.byteLength(wire)})
  expect(JSON.stringify(options)).not.toContain('MAKER_PRIVATE_SYSTEM');expect(wire).not.toContain('MAKER_PRIVATE_REASONING')
  expect(options.sessionId).toBe(child)
  if(phase>0)expect(wire).toContain('BASIS_V1')
  let content:any[]=[]
  if(phase===0&&n===1)content=[{type:'text',text:'Please provide the exact input types before I interpret the failure.'},{type:'tool_use',id:'question',name:'ask_delegation_question',input:{question:'Are the two actual operands strings or numbers? Give only the observed values and types; do not change the fixed expected result.'}}]
  else if(phase===0&&n===2){expect(wire).toContain('OBSERVED_INPUTS');content=[{type:'tool_use',id:'context',name:'read_file',input:{path:'context.json'}}]}
  else if((phase===0&&n===3)||(phase>0&&n===1))content=[{type:'tool_use',id:`probe-${phase}`,name:'run_command',input:{command:['node','-e',probe],timeout_ms:10000}}]
  else if((phase===0&&n===4)||(phase>0&&n===2)){
   const facts=work.facts(child) as any,last=facts.recent_runs.at(-1)
   expect(last).toMatchObject({input_intact:true,product_verified:false,exit_code:phase===2?0:1})
   expect(JSON.parse(last.stdout)).toMatchObject({actual:phase===2?12:'75',expected:12,actual_type:phase===2?'number':'string'})
   content=[{type:'text',text:text[phase]},{type:'tool_use',id:`note-${phase}`,name:'write_file',input:{path:`notes-${phase}.md`,content:text[phase]}}]
  }
  yield{type:'assistant',message:{role:'assistant',content}}
  // Controlled provider accounting fixture, NOT measured supplier usage/cost.
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 }
 registerParentLoopContext(parent,{query,env:{},maxTokens:2048,maxTurns:8,delegationMaxTurns:8,permissionMode:'allow-all',temperature:0,system:'MAKER_PRIVATE_SYSTEM',editFormat:'diff',executionScope:'test',
  publish:(type,payload)=>{
   observations.push({type,payload})
   if(type==='delegation_question'){
    questions++;queueMicrotask(()=>{answer=questionTool.execute({delegation_id:delegation,answer:'OBSERVED_INPUTS: ["7","5"], both strings, expected numeric 12. Facts only; no extra authority.'},context).catch(error=>{answerError=error})})
   }
  },prepareDelegation:input=>work.prepare(input.childSessionId,input.args),childWorkspace:id=>work.root(id),childRuntimeScope:()=> 'engineering-peer',
  childSystemBuilder:(_role,id)=>work.describe(id),childToolsBuilder:(_p,_r,_f,id)=>id?work.tools(id):[],
  onChildCreated:value=>{child=value.childSessionId;delegation=value.delegationId;monitor.created(value)},
  childLoopContext:(id,task)=>({system:work.describe(id),task,liveContext:()=>monitor.context(id),beforeComplete:monitor.beforeComplete(id),allowSilentCompletion:true,publicMessageTiming:'response'}),
  onChildTurn:(info,value)=>monitor.observed(value.sessionId,info),onChildMessage:(message,value)=>monitor.receive(value.sessionId,message,()=>work.facts(value.sessionId))})
 const settle=async()=>{const record=findDelegation(parent,delegation)!;await record.completion;await settleParentDelegationRuns(parent);expect(record.status,record.error).toBe('completed');expect(record.assignment).toMatchObject({readOnly:true,independentWorkspace:true});expect(getDelegationSummary(record).workspace_facts).toMatchObject({input_intact:true});return record}
 monitor.begin(context);await settle();await answer;expect(answerError).toBeUndefined();expect(questions).toBe(1)
 const own=join(home,'software-engineering-workspaces',project.project_id,readdirSync(join(home,'software-engineering-workspaces',project.project_id))[0])
 const first=JSON.parse(readFileSync(join(own,'context.json'),'utf8')),firstPacket=monitor.latest()!
 expect(firstPacket).toMatchObject({verification:'not_issued',updates:expect.arrayContaining([expect.objectContaining({text:text[0],observed_source:initialSource})])})
 expect(monitor.take(context)).toContain('BASIS_V1');expect(readFileSync(join(root,'calc.cjs'),'utf8')).toBe('module.exports=(a,b)=>a+b')
 const beforeIdle=requests.length
 for(let n=0;n<80;n++)monitor.observeTool({phase:'completed',turn:n+1,id:`read-${n}`,name:'read_file',input:{path:'case.json',offset:n},output:expected,isError:false})
 expect(requests).toHaveLength(beforeIdle)
 const makerCommand=['node','-e',`const c=require('./case.json'),actual=require('./calc.cjs')(...c.args);console.log(JSON.stringify({actual,expected:c.expected}));if(actual!==c.expected)process.exitCode=1`]
 const makerProbe=()=>executeSoftwareCommand({projectId:project.project_id,root,command:makerCommand,timeoutMs:10000,signal:context.signal})
 phase=1;writeFileSync(join(root,'calc.cjs'),'module.exports=(a,b)=>Number(a)+b')
 const failed=await makerProbe();expect(failed.code).toBe(1)
 monitor.observeTool({phase:'completed',turn:90,id:'actual-new-failure',name:'run_command',input:{command:makerCommand},output:JSON.stringify({code:failed.code,stdout:failed.stdout}),isError:true})
 await settle();expect(monitor.take(context)).toContain('BASIS_V2')
 const second=JSON.parse(readFileSync(join(own,'context.json'),'utf8'));expect(second.snapshot).not.toBe(first.snapshot)
 expect(readFileSync(join(own,first.snapshot,'calc.cjs'),'utf8')).toBe('module.exports=(a,b)=>a+b')
 expect(readFileSync(join(own,second.snapshot,'calc.cjs'),'utf8')).toBe('module.exports=(a,b)=>Number(a)+b')
 // The test author, not the partner, integrates the implementation change.
 phase=2;writeFileSync(join(root,'calc.cjs'),'module.exports=(a,b)=>Number(a)+Number(b)')
 const succeeded=await makerProbe();expect(succeeded.code).toBe(0)
 monitor.suspend();monitor.begin({...context,requestId:'actual-production-return'});await settle()
 const final=monitor.latest()!;expect(final.verification).toBe('not_issued');expect(monitor.take(context)).toContain('BASIS_V3')
 expect(new Set(requests.map(row=>row.session))).toEqual(new Set([child]));expect(phases).toEqual([5,3,3])
 expect(readFileSync(join(root,'case.json'),'utf8')).toBe(expected);expect(existsSync(qualityLedgerPath(project.project_id))).toBe(false)
 const runs=readdirSync(join(own,'runs')).map(name=>JSON.parse(readFileSync(join(own,'runs',name),'utf8')))
 expect(runs).toHaveLength(3);expect(new Set(runs.map(row=>row.source_snapshot)).size).toBe(3)
 expect(runs.every(row=>row.input_intact&&row.product_verified===false)).toBe(true)
 for(let n=0;n<3;n++)expect(readFileSync(join(own,`notes-${n}.md`),'utf8')).toBe(text[n])
 const beforeClose=requests.length,closeAt=performance.now();monitor.suspend();await monitor.drain()
 monitor.observeTool({phase:'completed',turn:100,id:'late-closeout',name:'run_command',input:{},output:'late error',isError:true})
 await new Promise(resolve=>setTimeout(resolve,100));expect(requests).toHaveLength(beforeClose)
 const report={version:1,scope:'controlled Pi/real local probes, not autonomous model benefit',unique_sessions:1,directed_questions:questions,actual_probe_runs:runs.length,source_snapshots:3,fixture_expected_unchanged:true,quality_verification:'not_issued',author_integrated_fix:true,
  sdk_request_count:requests.length,sdk_message_bytes:requests.reduce((n,row)=>n+row.message_bytes,0),message_bytes_are:'SDK options.messages only, not HTTP/system/schema/tokens',requests_after_closeout:requests.length-beforeClose,drain_and_idle_ms:performance.now()-closeAt,total_ms:performance.now()-started,supplier_tokens_and_cost:'not_measured',requests}
 if(process.env.ENGINEERING_CONTRIBUTION_REPORT)writeFileSync(process.env.ENGINEERING_CONTRIBUTION_REPORT,JSON.stringify(report,null,2))
},120000)
