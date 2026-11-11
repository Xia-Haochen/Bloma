import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {expect,it,vi} from 'vitest'
import {buildAgentTools} from '../../main/agent/tools/agent-tools'
import {runAgentLoop} from '../../main/agent/loop/agent-loop'
import {buildSoftwareExecutionTools} from '../../main/software/execution-tools'
import {softwareProcess,stopSoftwareSession} from '../../main/software/process-manager'
import {createProject} from '../../main/project/project-service'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'

it('measures real Pi cross-file repair and archived early diagnostics with shared-round compatibility and batched journeys',async()=>{
 const home=mkdtempSync(join(tmpdir(),'bloma-pi-journey-'));vi.stubEnv('PROMA_HOME',home)
 const reports:any[]=[],sessions:Array<{project:string;session:string}>=[]
 try {
  for(const mode of ['compatibility','batched','batched','compatibility'] as const){
   const project=createProject({request_id:'controlled-journey',mode:'quick'},{workflowVersion:'software-v1'}),root=project.root_path,session='journey-'+randomUUID()
   sessions.push({project:project.project_id,session});mkdirSync(join(root,'src'));mkdirSync(join(root,'test'))
   const before={parse:'exports.toNumber=input=>input\n',format:'exports.format=total=>"USD "+total\n'}
   writeFileSync(join(root,'src/parse.cjs'),before.parse);writeFileSync(join(root,'src/format.cjs'),before.format)
   writeFileSync(join(root,'src/app.cjs'),'const {toNumber}=require("./parse.cjs"),{format}=require("./format.cjs");exports.render=(a,b)=>format(toNumber(a)+toNumber(b))')
   const fixed='const assert=require("node:assert/strict"),{render}=require("../src/app.cjs");assert.equal(render("7","5"),"USD 12.00");assert.equal(render("1.5","2.25"),"USD 3.75")'
   writeFileSync(join(root,'test/fixed.cjs'),fixed)
   // Build-like real streaming process, not a webpack/npm performance claim.
   // Completion is gated by real stdin EOF, not a guessed wall-clock delay.
   writeFileSync(join(root,'build.cjs'),`const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.APP_DATA_DIR,{recursive:true});fs.appendFileSync(path.join(process.env.APP_DATA_DIR,'starts.txt'),'1');process.stderr.write('EARLY_NOTE api_key=PRIVATE_');setTimeout(()=>process.stderr.write('SECRET\\n'),10);for(let n=0;n<1200;n++)console.log('compile-'+n+' '+('中😀'.repeat(40)));console.log('BUILD_READY');process.stdin.resume();process.stdin.on('end',()=>{try{require('./test/fixed.cjs');console.log('BUILD_DONE: local checks completed')}catch(error){console.error(error);process.exitCode=1}})`)
   const actualTools=[...buildAgentTools({projectId:project.project_id,software:true,realFullstackVariant:true,assertFileWrite:path=>{if(!path.replaceAll('\\','/').startsWith('src/'))throw Error('FIXED_INPUT_READ_ONLY')}}),...buildSoftwareExecutionTools(project.project_id)]
    .filter(tool=>['grep','read_file','edit_file','run_command','read_process','write_process'].includes(tool.name))
   const rows:any[]=[],trace:any[]=[],requests:any[]=[];let processId='',nextSeq=0,ready=false,finished=false,stage=0,searchReads=0,starts=0
   const tools=actualTools.map(tool=>({...tool,execute:async(input:any,ctx:any)=>{
    const started=performance.now(),result=await tool.execute(input,ctx)
    rows.push({name:tool.name,input_bytes:Buffer.byteLength(JSON.stringify(input)),output_bytes:Buffer.byteLength(result.output),execution_ms:performance.now()-started,is_error:result.isError===true})
    expect(result.output).not.toContain('PRIVATE_SECRET')
    if(tool.name==='run_command'){starts++;const value=JSON.parse(result.output);processId=value.process_id;nextSeq=value.next_seq;expect(value.verification).toBe('not_applicable')}
    if(tool.name==='read_process'){
     const value=JSON.parse(result.output);if(input.mode==='log'){expect(result.output).toContain('EARLY_NOTE');expect(result.output).toContain('[REDACTED]');searchReads++}
     else {nextSeq=value.next_seq;ready ||= result.output.includes('BUILD_READY');finished=value.state==='exited';if(finished)expect(value.exit_code,result.output).toBe(0)}
    }
    expect(result.isError,result.output).not.toBe(true);return result
   }}))
   const editParse={path:'src/parse.cjs',old_string:'input=>input',new_string:'input=>Number(input)'},editFormat={path:'src/format.cjs',old_string:'"USD "+total',new_string:'"USD "+total.toFixed(2)'}
   const query:SDKQuery=async function*(_prompt,options){
    requests.push({stage,message_bytes:Buffer.byteLength(JSON.stringify(options.messages))})
    expect(JSON.stringify(options.messages)).not.toContain('PRIVATE_SECRET');expect(JSON.stringify(options.messages)).not.toContain('held-out decimal')
    let actions:Array<{name:string;input:Record<string,unknown>}>=[]
    if(stage===0){actions=[{name:'grep',input:{pattern:'exports\\.(toNumber|format)',glob:'src/**/*.cjs',...(mode==='compatibility'?{files_only:true}:{})}}];stage++}
    else if(stage===1){actions=mode==='compatibility'?[{name:'read_file',input:{path:'src/parse.cjs'}},{name:'read_file',input:{path:'src/format.cjs'}}]:[{name:'read_file',input:{files:[{path:'src/parse.cjs'},{path:'src/format.cjs'}]}}];stage++}
    else if(stage===2){actions=mode==='compatibility'?[{name:'edit_file',input:editParse},{name:'edit_file',input:editFormat}]:[{name:'edit_file',input:{files:[{path:editParse.path,edits:[{old_string:editParse.old_string,new_string:editParse.new_string}]},{path:editFormat.path,edits:[{old_string:editFormat.old_string,new_string:editFormat.new_string}]}]}}];stage++}
    else if(stage===3){actions=[{name:'run_command',input:{command:['node','build.cjs'],yield_ms:0,timeout_ms:20000}}];stage++}
    else if(stage===4&&!ready)actions=[{name:'read_process',input:{process_id:processId,wait_ms:1000,since_seq:nextSeq,...(mode==='compatibility'?{mode:'tail'}:{})}}]
    else if(stage===4){actions=[{name:'write_process',input:{process_id:processId,text:'',close_stdin:true}}];stage++}
    else if(stage===5&&!finished)actions=[{name:'read_process',input:{process_id:processId,wait_ms:10000,since_seq:nextSeq,...(mode==='compatibility'?{mode:'tail'}:{})}}]
    else if(stage===5){actions=[{name:'read_process',input:{process_id:processId,mode:'log',since_seq:0,pattern:'EARLY_NOTE'}}];stage++}
    yield{type:'assistant',message:{role:'assistant',content:actions.length?actions.map((action,n)=>({type:'tool_use' as const,id:`${mode}-${requests.length}-${n}`,...action})):[{type:'text' as const,text:'Local case and diagnostic evidence obtained; no product approval issued.'}]}}
    yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
   }
   const started=performance.now(),result=await runAgentLoop({projectId:project.project_id,sessionId:session,requestId:session,runtimeScope:'desktop-implement',system:'Controlled offline journey; do not edit test/fixed.cjs or build.cjs',task:'Repair numeric conversion and two-decimal USD formatting for string inputs 7 and 5; retrieve the first EARLY_NOTE without rerunning the build.',tools,query,env:{},maxTokens:2048,maxTurns:20,permissionMode:'allow-all',signal:AbortSignal.timeout(90000),publish:()=>{},onToolObservation:event=>trace.push(event)})
   expect(result.status).toBe('completed');expect(starts).toBe(1);expect(searchReads).toBe(1)
   expect(readFileSync(join(root,'test/fixed.cjs'),'utf8')).toBe(fixed)
   expect(readFileSync(join(root,'src/parse.cjs'),'utf8')).toBe('exports.toNumber=input=>Number(input)\n')
   expect(readFileSync(join(root,'src/format.cjs'),'utf8')).toBe('exports.format=total=>"USD "+total.toFixed(2)\n')
   const snapshot=softwareProcess(project.project_id,processId,session);expect(snapshot.data_dir).toBeTruthy()
   expect(readFileSync(join(snapshot.data_dir!,'starts.txt'),'utf8')).toBe('1')
   expect(new Set(trace.filter(row=>row.phase==='completed').map(row=>row.id)).size).toBe(rows.length)
   reports.push({mode,comparison:'compatibility invocations on current runtime, not historical source baseline',fixed_and_held_out_cases:true,process_starts:starts,rounds:requests.length,tool_calls:rows.length,file_calls:rows.filter(row=>['grep','read_file','edit_file'].includes(row.name)).length,input_bytes:rows.reduce((n,row)=>n+row.input_bytes,0),output_bytes:rows.reduce((n,row)=>n+row.output_bytes,0),sdk_message_bytes:requests.reduce((n,row)=>n+row.message_bytes,0),sdk_bytes_scope:'options.messages only, excludes HTTP/system/schema and is not provider billing',total_ms:performance.now()-started,rows,requests})
  }
  expect(reports.map(report=>report.file_calls)).toEqual([5,3,3,5])
  if(process.env.TOOLING_JOURNEY_REPORT)writeFileSync(process.env.TOOLING_JOURNEY_REPORT,JSON.stringify({version:1,scope:'controlled real Pi/tools/Node; provider choices and fixed cases authored, not autonomous model accuracy or supplier cost',reports},null,2))
 }finally{
  for(const session of sessions)await stopSoftwareSession(session.project,session.session)
  vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})
 }
},180000)
