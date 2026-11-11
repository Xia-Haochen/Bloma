import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { runAgentLoop, createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildSoftwareInspectTool } from '../../../main/software/inspect-tool'
import { closeDebugSessions } from '../../../main/software/debug-sessions'
import { softwareDiagnosticContext } from '../../../main/software/diagnostic-context'
import { stopSoftwareSession } from '../../../main/software/process-manager'
let home:string,previous:string|undefined,project:ReturnType<typeof createProject>
const electron=resolve('node_modules/electron/dist/electron.exe')
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-save-evidence-'));process.env.PROMA_HOME=home;project=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(async()=>{await closeDebugSessions(project.project_id,'s');await stopSoftwareSession(project.project_id,'s');if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:150})},30000)
const main=(fixed:boolean)=>`const{app,BrowserWindow,ipcMain,screen}=require('electron'),fs=require('fs'),path=require('path'),file=path.join(process.env.APP_DATA_DIR,'notes','note.json');
const report=(phase,trace_id,code)=>console.error('BLOMA_DIAGNOSTIC '+JSON.stringify({kind:'ipc',phase,trace_id,code}));
ipcMain.handle('load',()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).note:'');
ipcMain.handle('save',(_,{note,trace_id})=>{report('request',trace_id);try{${fixed?"fs.mkdirSync(path.dirname(file),{recursive:true});":''}fs.writeFileSync(file,JSON.stringify({note}));report('completed',trace_id);return true}catch(e){report('failed',trace_id,e.code);throw e}});
app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:500,height:300,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});win.setPosition(Math.max(...screen.getAllDisplays().map(d=>d.bounds.x+d.bounds.width))+600,40);win.loadFile('index.html');win.once('ready-to-show',()=>win.showInactive())});app.on('window-all-closed',()=>app.quit())`
const html=`<!doctype html><meta charset="utf-8"><title>Save evidence fixture</title><input id="note"><button id="save">Save</button><output id="status">Ready</output><output id="trace"></output><output id="loaded"></output><script>
window.api.load().then(note=>{document.querySelector('#note').value=note;document.querySelector('#loaded').textContent=note||'empty'});
document.querySelector('#save').onclick=async()=>{const trace_id=crypto.randomUUID();document.querySelector('#trace').textContent=trace_id;const report=(phase,code)=>console.log('BLOMA_DIAGNOSTIC '+JSON.stringify({kind:'ipc',phase,trace_id,code}));report('request');try{await window.api.save({note:document.querySelector('#note').value,trace_id});document.querySelector('#status').textContent='Saved';report('completed')}catch(e){const code=String(e).includes('ENOENT')?'ENOENT':'IPC_ERROR';document.querySelector('#status').textContent='Error:'+code;report('failed',code)}}
</script>`
it.skipIf(process.platform!=='win32'||!existsSync(electron))('joins real renderer/IPC/backend failure and bounded file bytes, fixes the source, then saves and normally reopens actual persisted data',async()=>{
 const root=project.root_path,context:ToolContext={projectId:project.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()},tool=buildSoftwareInspectTool(project.project_id,createSoftwareCollaborationPolicy(project.project_id,root,'s'))
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'save-evidence',main:'main.cjs'}));writeFileSync(join(root,'main.cjs'),main(false));writeFileSync(join(root,'index.html'),html)
 writeFileSync(join(root,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{load:()=>ipcRenderer.invoke('load'),save:value=>ipcRenderer.invoke('save',value)})`)
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'electron',command:[electron,'.'],window_title:'Save evidence fixture'}))
 const result=await tool.execute({steps:[{id:'fill',kind:'fill',selector:'#note',value:'真实保存 Ω'},{id:'save-bad',kind:'click',selector:'#save'},{id:'actual-failure',kind:'expect',selector:'#status',equals:'Error:ENOENT'}]},context)
 expect(result.isError,result.output).not.toBe(true)
 const bad=JSON.parse(result.output),id=bad.debug_session_id
 if(process.env.DEBUG_SAVE_REPORT)writeFileSync(process.env.DEBUG_SAVE_REPORT,JSON.stringify(bad,null,2))
 expect(bad.storage).toMatchObject({complete:true,changed:0,scope:'owned_debug_data',before_source:bad.observed_source,after_source:bad.observed_source})
 expect(existsSync(join(bad.data_dir,'notes','note.json'))).toBe(false)
 const all=JSON.parse((await tool.execute({mode:'read',debug_session_id:id,diagnostics:{limit:80}},context)).output)
 const trace=all.observations.find((r:{kind:string})=>r.kind==='application.ipc.failed')?.trace_id
 expect(trace).toMatch(/^[a-f0-9-]{36}$/)
 const failures=JSON.parse((await tool.execute({mode:'read',debug_session_id:id,diagnostics:{trace_id:trace,source:bad.observed_source,limit:80}},context)).output)
 expect(failures.observations.filter((r:{kind:string})=>r.kind==='application.ipc.failed')).toHaveLength(2)
 expect(failures.observations.some((r:{kind:string,process_id?:string})=>r.kind==='application.ipc.failed'&&r.process_id)).toBe(true)
 expect(failures.observations.every((r:{correlation:string})=>r.correlation==='application-reported')).toBe(true)
 expect(all.observations.some((r:{kind:string,message:string,process_id?:string})=>r.kind==='backend.stderr'&&r.message.includes('ENOENT')&&r.process_id)).toBe(true)
 expect(new Set(all.observations.map((r:{seq:number})=>r.seq)).size).toBe(all.observations.length)
 expect((await tool.execute({diagnostics:{kind:'storage'}},context)).output).toContain('DIAGNOSTIC_READ_ONLY')
 const navigation=softwareDiagnosticContext(project.project_id,'s') as {diagnostic_protocol:{protocol:string};debug:{log_cursor:number;storage:{complete:boolean}}}
 expect(navigation.diagnostic_protocol.protocol).toBe('debug-evidence-v1');expect(navigation.debug.storage.complete).toBe(true);expect(navigation.debug.log_cursor).toBeGreaterThan(0)
 let round=0
 const query:SDKQuery=async function*(_task,options){
  if(round++===0)yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'actual-diagnostic-read',name:'inspect_app',input:{mode:'read',debug_session_id:id,diagnostics:{trace_id:trace,source:bad.observed_source,limit:80}}}]}}
  else{expect(JSON.stringify(options.messages)).toContain('application.ipc.failed');yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'Observed application-reported IPC failures; not acceptance or an automatic root-cause verdict.'}]}}}
  yield{type:'result',stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:10}}
 }
 const pi=await runAgentLoop({runtimeScope:'desktop-implement',projectId:project.project_id,sessionId:'s',requestId:'diagnostic-pi',system:'Offline controlled diagnostic tool contract',task:'Read only the real owned trace',tools:[tool],query,env:{},maxTokens:1000,maxTurns:3,permissionMode:'allow-all',signal:AbortSignal.timeout(15000),publish:()=>{}})
 expect(pi.status).toBe('completed');expect(pi.toolCalls.map(c=>c.status)).toEqual(['ok'])
 const oldCursor=all.log_cursor
 writeFileSync(join(root,'main.cjs'),main(true))
 const fixed=await tool.execute({mode:'reload',debug_session_id:id,steps:[{id:'refill',kind:'fill',selector:'#note',value:'真实保存 Ω'},{id:'save-good',kind:'click',selector:'#save'},{id:'actual-success',kind:'expect',selector:'#status',equals:'Saved'}]},context)
 expect(fixed.isError,fixed.output).not.toBe(true)
 const good=JSON.parse(fixed.output);expect(good.version).toBe(bad.version+1);expect(good.observed_source).not.toBe(bad.observed_source)
 expect(good.storage).toMatchObject({complete:true,changed:1,before_source:bad.observed_source,after_source:good.observed_source})
 expect(JSON.parse(readFileSync(join(good.data_dir,'notes','note.json'),'utf8')).note).toBe('真实保存 Ω')
 const original=JSON.parse((await tool.execute({mode:'read',debug_session_id:id,diagnostics:{source:bad.observed_source,trace_id:trace}},context)).output)
 expect(original.observations.filter((r:{kind:string})=>r.kind==='application.ipc.failed')).toHaveLength(2)
 const after=JSON.parse((await tool.execute({mode:'read',debug_session_id:id,since_seq:oldCursor,diagnostics:{kind:'application.ipc',source:good.observed_source,limit:80}},context)).output)
 expect(after.observations.some((r:{kind:string})=>r.kind==='application.ipc.completed')).toBe(true);expect(after.observations.every((r:{seq:number})=>r.seq>oldCursor)).toBe(true)
 await tool.execute({mode:'close',debug_session_id:id},context)
 const reopened=await tool.execute({mode:'open',steps:[{id:'actual-reopened',kind:'expect',selector:'#loaded',equals:'真实保存 Ω'}]},context)
 expect(reopened.isError,reopened.output).not.toBe(true);expect(JSON.parse(reopened.output).resumed_from).toBe(id)
 expect(JSON.parse(reopened.output).verification_readiness.verification).toBe('not_run')
},60000)
