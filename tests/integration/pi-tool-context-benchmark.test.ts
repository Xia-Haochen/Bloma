import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { createToolState, runAgentLoop } from '../../main/agent/loop/agent-loop'
import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query'
import { createProductionBudget } from '../../main/desktop/production-budget'
import { productionAgentTools } from '../../main/desktop/production-tool-assembly'
import { buildSoftwareAgentTools, SOFTWARE_ENGINEERING_INSTRUCTIONS } from '../../main/software/agent-tools'
import { createSoftwareCollaborationPolicy } from '../../main/software/collaboration-policy'

it('measures actual wire schemas/on-demand context and denies revoked tools on real Pi resume',async()=>{
 const previous=process.env.PROMA_HOME,home=mkdtempSync(join(tmpdir(),'bloma-tool-context-'));process.env.PROMA_HOME=home
 const bodies: any[]=[],rawBytes:number[]=[],frame=(v:unknown)=>`data: ${JSON.stringify(v)}\n\n`
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);bodies.push(JSON.parse(bytes.toString('utf8')));rawBytes.push(bytes.length)
  const index=bodies.length-1,useTool=index===1||index===4,name=index===1?'read_production_context':'run_command',args=index===1?{topic:'execution'}:{command:[process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(join(home,'revoked.txt'))},'bad')`]}
  res.writeHead(200,{'content-type':'text/event-stream'})
  res.write(frame({type:'message_start',message:{id:`context-${index}`,role:'assistant',usage:{input_tokens:10}}}))
  res.write(frame({type:'content_block_start',index:0,content_block:useTool?{type:'tool_use',id:`call-${index}`,name,input:{}}:{type:'text',text:''}}))
  res.write(frame({type:'content_block_delta',index:0,delta:useTool?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:'Controlled context measurement; no delivery certificate.'}}))
  res.write(frame({type:'content_block_stop',index:0}));res.write(frame({type:'message_delta',delta:{stop_reason:useTool?'tool_use':'end_turn'},usage:{output_tokens:5}}));res.end(frame({type:'message_stop'}))
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port')
 try {
  const project=createProject({request_id:'context-benchmark',mode:'quick'},{workflowVersion:'software-v1'}),sessionId='context-on-demand',policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,sessionId)
  const tools=productionAgentTools(buildSoftwareAgentTools(project.project_id,'parent',policy),[]),readonly=buildSoftwareAgentTools(project.project_id,'research',policy),context=tools.find(t=>t.name==='read_production_context')!
  const topicNames=['documents','multimodal','vision','http-integration','execution','launch','delivery','acceptance-counterexamples'],ctx={projectId:project.project_id,sessionId,requestId:'context',signal:AbortSignal.timeout(60000),state:createToolState()}
  const prefetched:string[]=[]
  for(const topic of topicNames){const outcome=await context.execute({topic},ctx);expect(outcome.isError,outcome.output).not.toBe(true);prefetched.push(`${topic}: ${outcome.output}`)}
  const budget=createProductionBudget(project.project_id,'context-benchmark','desktop-implement');let actions=0
  const common={runtimeScope:'desktop-implement' as const,projectId:project.project_id,sessionId,requestId:'context',system:SOFTWARE_ENGINEERING_INSTRUCTIONS,task:'Inspect existing command lifecycle guidance; do not build or change a product.',tools,query:budget.wrap(anthropicMessagesQueryViaProviders),env:{PATH:process.env.PATH??process.env.Path??'',ANTHROPIC_AUTH_TOKEN:'local-context-test-key',ANTHROPIC_MODEL:'local-context-test-model',ANTHROPIC_BASE_URL:`http://127.0.0.1:${address.port}`,ANTHROPIC_PROVIDER_TYPE:'anthropic-compatible'},providerType:'anthropic-compatible',maxTokens:1000,maxTurns:4,permissionMode:'allow-all' as const,signal:AbortSignal.timeout(60000),publish:()=>{},onToolObservation:(event:{phase:string})=>{if(event.phase==='started')actions++}}
  expect((await runAgentLoop({...common,sessionId:'context-prefetch-baseline',system:SOFTWARE_ENGINEERING_INSTRUCTIONS+'\n\n'+prefetched.join('\n\n')})).status).toBe('completed')
  expect((await runAgentLoop(common)).status).toBe('completed');expect(actions).toBe(1)
  expect((await runAgentLoop({...common,task:'Continue from the durable context already read. Do not repeat tools.'})).status).toBe('completed');expect(actions).toBe(1)
  expect((await runAgentLoop({...common,task:'Write and command tools have been revoked; do not reuse their old permissions.',tools:readonly})).status).toBe('completed')
  expect(existsSync(join(home,'revoked.txt'))).toBe(false);expect(actions).toBe(1);expect(bodies).toHaveLength(6)
  const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v??null))
  const rows=bodies.map((body,index)=>({index,request_bytes:rawBytes[index],schema_bytes:size(body.tools),schema_hash:digest(body.tools),system_bytes:size(body.system),message_bytes:size(body.messages),tool_names:body.tools.map((tool:any)=>tool.name)}))
  expect(new Set(rows.slice(0,4).map(r=>r.schema_hash)).size).toBe(1)
  expect(rows[1].system_bytes).toBeLessThan(rows[0].system_bytes)
  expect(rows[3].tool_names).toEqual(rows[1].tool_names)
  for(const row of rows.slice(4)){expect(row.tool_names).not.toContain('run_command');expect(row.tool_names).not.toContain('write_file');expect(row.tool_names).not.toContain('edit_file')}
  for(const row of rows){expect(row.tool_names.some((name:string)=>name.startsWith('mcp__')||['codemode','tool_search','execute_code'].includes(name))).toBe(false)}
  const report={schema_version:1,kind:'controlled_local_http_wire_not_provider_cost',scope:'real software-agent parent production assembly excluding per-product quality/scope/check tools; current policy vs eager prefetch counterfactual, not historical production regression',rows,prefetch_topics:topicNames,first_request_bytes_saved:rows[0].request_bytes-rows[1].request_bytes,on_demand_initial_total_bytes:rows[1].request_bytes+rows[2].request_bytes,eager_initial_total_bytes:rows[0].request_bytes,tool_executions:actions,requests:budget.snapshot().requests,limitations:['Bodies are actual Pi → budgeted provider HTTP/SSE requests to a local controlled endpoint. Supplied usage is synthetic, not measured billing/token savings or model success rate.','Same schemas repeat over the wire; a stable hash/order is cache eligibility evidence only, not a provider cache-hit guarantee.','On-demand guidance can add one tool round and repeat schema overhead; report total bytes as well as first-packet savings. No dynamic schema/REPL was enabled.','Resume and revocation are real SDK session tests. They are not cross-role confidential-context isolation, host-crash recovery or an automatic compaction success claim.']}
  if(process.env.TOOL_CONTEXT_REPORT){if(!isAbsolute(process.env.TOOL_CONTEXT_REPORT))throw Error('ABSOLUTE_REPORT_PATH_REQUIRED');writeFileSync(process.env.TOOL_CONTEXT_REPORT,JSON.stringify(report,null,2))}
  expect(report.requests).toBe(6)
 } finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
},90000)
