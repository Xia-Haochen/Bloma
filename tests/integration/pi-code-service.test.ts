import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { runAgentLoop, createToolState } from '../../main/agent/loop/agent-loop'
import { buildRepositoryContextTool } from '../../main/software/repository-context'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'
let home: string | undefined
const previous = process.env.PROMA_HOME
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME=previous; if(home)rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100}) })
it('actual Pi routes all semantic schemas through the production worker and keeps missing Python capability explicit',async()=>{
 home=mkdtempSync(join(tmpdir(),'bloma-pi-semantic-'));process.env.PROMA_HOME=home
 const project=createProject({request_id:'semantic',mode:'quick'},{workflowVersion:'software-v1'}),root=project.root_path
 writeFileSync(join(root,'value.ts'),'export const amount = 42\n')
 writeFileSync(join(root,'use.ts'),'import { amount } from "./value"; export const result = amount\n')
 writeFileSync(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',types:[]},files:['use.ts','value.ts']}))
 const tool=buildRepositoryContextTool(project.project_id)
 let round=0
 const requests=[{mode:'definition',path:'use.ts',line:1,column:57},{mode:'references',path:'value.ts',line:1,column:14,include_declaration:false},{mode:'diagnostics',path:'use.ts'},{mode:'symbol',path:'use.ts',query:'result'},{mode:'capabilities'}]
 const query:SDKQuery=async function*(_task,options){
  const messages=JSON.stringify(options.messages)
  if(round===1)expect(messages).toContain('value.ts')
  if(round===2)expect(messages).toContain('use.ts')
  if(round===4)expect(messages).toContain('result')
  if(round<requests.length)yield {type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:`semantic-${round}`,name:tool.name,input:requests[round]}]}} as SDKMessage
  else yield {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Controlled semantic contract completed; no product acceptance was issued.'}]}} as SDKMessage
  round++;yield {type:'result',stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:10}}
 }
 const result=await runAgentLoop({runtimeScope:'desktop-implement',projectId:project.project_id,sessionId:'semantic',requestId:'semantic',system:'Offline semantic tool contract',task:'query definitions and references',tools:[tool],query,env:{},maxTokens:1000,maxTurns:7,permissionMode:'allow-all',signal:AbortSignal.timeout(60000),publish:()=>{}})
 expect(result.status).toBe('completed');expect(round).toBe(6);expect(result.toolCalls.map(call=>call.status)).toEqual(['ok','ok','ok','ok','ok'])
 const context={projectId:project.project_id,sessionId:'semantic',requestId:'semantic',signal:new AbortController().signal,state:createToolState()}
 const missing=await tool.execute({mode:'definition',path:'example.py',line:1,column:1},context)
 expect(missing.isError).toBe(true);expect(missing.output).toContain('PYTHON_BACKEND_UNAVAILABLE')
 const foreign=await tool.execute({mode:'symbol',path:'use.ts'},{...context,projectId:'foreign'})
 expect(foreign.isError).toBe(true);expect(foreign.output).toContain('REPOSITORY_PROJECT_MISMATCH')
},90000)
