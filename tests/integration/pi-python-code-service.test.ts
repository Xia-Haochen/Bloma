import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { runAgentLoop, createToolState } from '../../main/agent/loop/agent-loop'
import { buildRepositoryContextTool } from '../../main/software/repository-context'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'
it('actual Pi routes Python semantics through the fixed owned backend without new model permissions',async()=>{
 const executable=process.env.TEST_PYTHON_SEMANTICS_EXECUTABLE,site=process.env.TEST_PYTHON_SEMANTICS_SITE
 if(!executable||!site)throw Error('Private TEST_PYTHON_SEMANTICS_EXECUTABLE and TEST_PYTHON_SEMANTICS_SITE are required')
 const keys=['PROMA_HOME','BLOMA_PYTHON_SEMANTICS_EXECUTABLE','BLOMA_PYTHON_SEMANTICS_SITE'] as const,prior=Object.fromEntries(keys.map(k=>[k,process.env[k]])),home=mkdtempSync(join(tmpdir(),'bloma-pi-python-'))
 try {
  process.env.PROMA_HOME=home;process.env.BLOMA_PYTHON_SEMANTICS_EXECUTABLE=executable;process.env.BLOMA_PYTHON_SEMANTICS_SITE=site
  const project=createProject({request_id:'python',mode:'quick'},{workflowVersion:'software-v1'}),root=project.root_path
  writeFileSync(join(root,'value.py'),'def amount(x):\n    return x+1\n');writeFileSync(join(root,'use.py'),'from value import amount\nresult=amount(4)\n')
  const tool=buildRepositoryContextTool(project.project_id),requests=[{mode:'definition',path:'use.py',line:2,column:10},{mode:'references',path:'value.py',line:1,column:8},{mode:'diagnostics',path:'use.py'},{mode:'symbol',path:'use.py',query:'result'},{mode:'capabilities'}]
  expect(JSON.stringify(tool.input_schema)).not.toMatch(/executable|python_site|script|dependencyRoots/)
  let round=0
  const query:SDKQuery=async function*(_task,options){
   const messages=JSON.stringify(options.messages)
   if(round===1){expect(messages).toContain('jedi');expect(messages).toContain('value.py')}
   if(round===2)expect(messages).toContain('writeAccess')
   if(round===4)expect(messages).toContain('result')
   if(round===5){expect(messages).toContain('syntax-only');expect(messages).toContain('fixed-one-request-stdio-not-LSP')}
   if(round<requests.length)yield {type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:`python-${round}`,name:tool.name,input:requests[round]}]}} as SDKMessage
   else yield {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Controlled Python semantics, not acceptance.'}]}} as SDKMessage
   round++;yield {type:'result',stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:10}}
  }
  const result=await runAgentLoop({runtimeScope:'desktop-implement',projectId:project.project_id,sessionId:'python',requestId:'python',system:'Offline Python semantic contract',task:'Query the Python project',tools:[tool],query,env:{},maxTokens:1000,maxTurns:7,permissionMode:'allow-all',signal:AbortSignal.timeout(60000),publish:()=>{}})
  expect(result.status).toBe('completed');expect(round).toBe(6);expect(result.toolCalls.map(call=>call.status)).toEqual(['ok','ok','ok','ok','ok'])
  const ctx={projectId:'foreign',sessionId:'python',requestId:'python',signal:AbortSignal.timeout(1000),state:createToolState()}
  expect(await tool.execute({mode:'symbol',path:'value.py'},ctx)).toMatchObject({isError:true,output:expect.stringContaining('REPOSITORY_PROJECT_MISMATCH')})
 } finally {for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k]}rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
},60000)
