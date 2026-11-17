import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createProject } from '../../../main/project/project-service'
import { prepareSoftwareRelease, readSoftwareCandidate } from '../../../main/software/release-store'
import { prepareCandidateReproduction, inspectCandidateReproduction, reproductionLaunch, runCandidateReproduction } from '../../../main/software/candidate-reproduction'
import { verificationFingerprint } from '../../../main/desktop/verification-fingerprint'
import type { GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { closeDebugSessions } from '../../../main/software/debug-sessions'
let home:string,oldHome:string|undefined,project:ReturnType<typeof createProject>
const sessions:string[]=[]
beforeEach(()=>{oldHome=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-reproduction-'));process.env.PROMA_HOME=home;project=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(async()=>{for(const session of sessions.splice(0))await closeDebugSessions(project.project_id,session);if(oldHome===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=oldHome;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})},30000)
const html=`<!doctype html><meta charset="utf-8"><input id="note"><button id="save">Save</button><button id="slow">Slow</button><output id="loaded"></output><output id="status">Ready</output><script>fetch('/load').then(r=>r.text()).then(value=>{document.querySelector('#note').value=value;document.querySelector('#loaded').textContent=value});document.querySelector('#save').onclick=async()=>{await fetch('/save',{method:'POST',body:document.querySelector('#note').value});document.querySelector('#status').textContent='Saved'};document.querySelector('#slow').onclick=()=>fetch('/slow')</script>`
const server=`const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),identity=require('identity'),data=process.env.APP_DATA_DIR,file=path.join(data,'outputs','note.txt');fs.mkdirSync(path.dirname(file),{recursive:true});http.createServer((req,res)=>{if(req.url==='/load')return res.end(fs.existsSync(file)?fs.readFileSync(file):JSON.parse(fs.readFileSync(path.join(data,'input','old.json'),'utf8')).value);if(req.url==='/save'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{fs.writeFileSync(file,identity(body));res.end('saved')});return}if(req.url==='/slow'){const p=path.join(data,'outputs','slow-started');fs.appendFileSync(p,'1');return setTimeout(()=>res.end('late'),30000)}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(${JSON.stringify(html)})}).listen(Number(process.argv[2]),'127.0.0.1')`
async function pack(extraArgs:string[]=[],implementation=server){
 const root=project.root_path;mkdirSync(join(root,'node_modules','identity'),{recursive:true});writeFileSync(join(root,'node_modules','identity','index.js'),'module.exports=value=>value')
 writeFileSync(join(root,'server.cjs'),implementation);writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',url:'http://127.0.0.1:48731',command:[process.execPath,join(root,'server.cjs'),'48731',...extraArgs]}))
 const candidate=await prepareSoftwareRelease(project.project_id,root)
 const suite:GuiAcceptanceSuite={version:1,scope_hash:verificationFingerprint(candidate.root)!,covers:['F-001'],fixtures:[{path:'input/old.json',text:JSON.stringify({schema:1,value:'legacy Ω'})}],steps:[
  {id:'legacy',kind:'expect',selector:'#loaded',equals:'legacy Ω'}, {id:'edit',kind:'fill',selector:'#note',value:'saved Ω'}, {id:'save',kind:'click',selector:'#save'}, {id:'saved',kind:'expect',selector:'#status',equals:'Saved'}, {id:'bytes',kind:'expect_file',path:'outputs/note.txt',equals:'saved Ω'}, {id:'restart',kind:'restart'}, {id:'reopened',kind:'expect',selector:'#loaded',equals:'saved Ω'}]}
 const reference=await prepareCandidateReproduction(project.project_id,candidate.id,suite)
 const runtimePaths=Object.fromEntries((candidate.external_files??[]).map(file=>[file.sha256,file.path]))
 return{reference,candidate,suite,runtimePaths}
}
it('transfers real physical dependency bytes, then runs normal save/restart after the original source, candidate and dependency cache are gone',async()=>{
 const {reference,candidate,runtimePaths}=await pack(),registry=readFileSync(join(home,'projects.json'),'utf8')
 const packageRoot=reference.directory;expect(lstatSync(join(packageRoot,'app','node_modules')).isSymbolicLink()).toBe(false)
 expect(readFileSync(join(packageRoot,'app','node_modules','identity','index.js'),'utf8')).toBe('module.exports=value=>value')
 expect(readFileSync(join(packageRoot,'app','LAUNCH.json'),'utf8')).toBe(readFileSync(join(candidate.root,'LAUNCH.json'),'utf8'))
 rmSync(project.root_path,{recursive:true,force:true});rmSync(candidate.root,{recursive:true,force:true});rmSync(join(home,'software-dependency-snapshots'),{recursive:true,force:true})
 const result=await runCandidateReproduction({...reference,executorProjectId:project.project_id,runtimePaths,signal:AbortSignal.timeout(30000)})
 sessions.push(result.execution.session_id)
 expect(result.debug?.steps.map(step=>step.passed)).toEqual([true,true,true,true,true,true,true])
 expect(readFileSync(join(result.debug!.data_dir!,'outputs','note.txt'),'utf8')).toBe('saved Ω')
 expect(JSON.parse(readFileSync(join(packageRoot,'seed','input','old.json'),'utf8'))).toEqual({schema:1,value:'legacy Ω'})
 expect(result.evidence.attachments).toHaveLength(1);expect(result.evidence.attachments[0].sha256).toMatch(/^[a-f0-9]{64}$/)
 expect(result).toMatchObject({verification:'not_applicable',execution:{environment:'directory-isolated',os_reset:'not_attested'},debug:{state:'closed'}})
 expect(result.effective_launch.command[1]).toBe(join(packageRoot,'app','server.cjs'));expect(result.effective_launch.url).not.toBe(result.declared_launch.url)
 const historical=JSON.parse(execFileSync(process.execPath,['scripts/reproduce-candidate.mjs','evidence',project.project_id,result.execution.session_id,result.debug!.id,'0'],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']}))
 expect(historical).toMatchObject({state:'closed',runtime_attached:false,retained_snapshot:true});expect(historical.observations[0].seq).toBe(1)
 expect(readFileSync(join(home,'projects.json'),'utf8')).toBe(registry)
 expect(JSON.parse(readFileSync(join(candidate.root,'..','release.json'),'utf8')).verified).toBeUndefined()
},45000)
it('requires an independent metadata pin and rejects tampering instead of trusting a package claiming PASS',async()=>{
 const {reference}=await pack();await expect(inspectCandidateReproduction({...reference,manifestSha256:'0'.repeat(64)})).rejects.toThrow('REPRODUCTION_MANIFEST_PIN_MISMATCH')
 const path=join(reference.directory,'manifest.json'),text=readFileSync(path,'utf8');writeFileSync(path,text.replace('not_applicable','PASS'))
 await expect(inspectCandidateReproduction(reference)).rejects.toThrow('REPRODUCTION_MANIFEST_PIN_MISMATCH')
})
it('rehashes same-stat bytes and detects even extra .cache files that the host-layout release inventory excludes',async()=>{
 const {reference}=await pack(),path=join(reference.directory,'app','node_modules','identity','index.js'),before=statSync(path),text=readFileSync(path,'utf8')
 writeFileSync(path,text.replace('value=>value','value=>false'));utimesSync(path,before.atime,before.mtime)
 await expect(inspectCandidateReproduction(reference)).rejects.toThrow('REPRODUCTION_BYTES_CHANGED')
 writeFileSync(path,text);mkdirSync(join(reference.directory,'app','.cache'));writeFileSync(join(reference.directory,'app','.cache','extra.js'),'unbound bytes')
 await expect(inspectCandidateReproduction(reference)).rejects.toThrow('REPRODUCTION_BYTES_CHANGED')
})
it('refuses seed corruption and actual imported links without following or deleting their target',async()=>{
 const {reference}=await pack(),seed=join(reference.directory,'seed','input','old.json'),bytes=readFileSync(seed)
 writeFileSync(seed,'corrupt');await expect(inspectCandidateReproduction(reference)).rejects.toThrow('REPRODUCTION_BYTES_CHANGED');writeFileSync(seed,bytes)
 const outside=join(home,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'keep');symlinkSync(outside,join(reference.directory,'app','linked'),process.platform==='win32'?'junction':'dir')
 await expect(inspectCandidateReproduction(reference)).rejects.toThrow('RELEASE_LINK_UNSUPPORTED');expect(readFileSync(join(outside,'keep'),'utf8')).toBe('keep')
})
it('never falls back to the old absolute runtime or starts a wrong mapped executable',async()=>{
 const {reference,runtimePaths}=await pack();await expect(reproductionLaunch(reference,{})).rejects.toThrow('REPRODUCTION_RUNTIME_MAPPING_REQUIRED')
 const fake=join(home,'wrong-runtime.exe');writeFileSync(fake,'not Node');const wrong=Object.fromEntries(Object.keys(runtimePaths).map(key=>[key,fake]))
 await expect(reproductionLaunch(reference,wrong)).rejects.toThrow('REPRODUCTION_RUNTIME_BYTES_CHANGED')
})
it('rejects embedded absolute flag paths instead of silently reusing a producer profile or guessing string rewrites',async()=>{
 const {reference,runtimePaths}=await pack([`--user-data-dir=${join(home,'producer-profile')}`])
 await expect(reproductionLaunch(reference,runtimePaths)).rejects.toThrow('REPRODUCTION_EMBEDDED_ABSOLUTE_PATH_UNSUPPORTED')
})
it('does not copy known credential/profile files or rebind a journey to a different candidate',async()=>{
 const {candidate,suite}=await pack();await expect(prepareCandidateReproduction(project.project_id,candidate.id,{...suite,scope_hash:'0'.repeat(64)})).rejects.toThrow('REPRODUCTION_FIXTURE_SCOPE_MISMATCH')
 const oversized=Array.from({length:4},(_,i)=>({path:`input/${i}.bin`,source:'frozen.bin',sha256:'0'.repeat(64),size:20*1024**2}))
 await expect(prepareCandidateReproduction(project.project_id,candidate.id,{...suite,fixtures:oversized})).rejects.toThrow('REPRODUCTION_SIZE_LIMIT')
 writeFileSync(join(project.root_path,'.env'),'API_KEY=do-not-copy');const unsafe=await prepareSoftwareRelease(project.project_id,project.root_path)
 await expect(prepareCandidateReproduction(project.project_id,unsafe.id,{...suite,scope_hash:verificationFingerprint(unsafe.root)!})).rejects.toThrow('REPRODUCTION_SECRET_REVIEW_REQUIRED')
 for(const id of readdirSync(join(home,'software-reproductions',project.project_id)))expect(readdirSync(join(home,'software-reproductions',project.project_id,id,'seed'))).not.toContain('.env')
 expect((await readSoftwareCandidate(project.project_id,unsafe.id)).verified).toBeUndefined()
})
it('returns the actual startup exit and owned stderr without promoting an unverified package',async()=>{
 const {reference,runtimePaths}=await pack([],"process.stderr.write('deliberate EACCES startup failure');process.exit(27)")
 const result=await runCandidateReproduction({...reference,executorProjectId:project.project_id,runtimePaths,signal:AbortSignal.timeout(15000)});sessions.push(result.execution.session_id)
 expect(result.debug?.error).toBeTruthy();expect(result.debug?.observations.some(row=>row.message.includes('EACCES'))).toBe(true)
 expect(result.debug?.steps??[]).toEqual([]);expect(result.verification).toBe('not_applicable');expect(result.evidence.attachments).toEqual([])
})
it('keeps an actual in-flight input outcome unknown on cancellation and never reruns the journey',async()=>{
 const {candidate,suite,runtimePaths}=await pack(),reference=await prepareCandidateReproduction(project.project_id,candidate.id,{...suite,steps:[{id:'loaded',kind:'expect',selector:'#loaded',equals:'legacy Ω'},{id:'start',kind:'click',selector:'#slow'},{id:'pending',kind:'expect',selector:'#status',equals:'Never',timeout_ms:5000}]})
 const controller=new AbortController(),running=runCandidateReproduction({...reference,executorProjectId:project.project_id,runtimePaths,signal:controller.signal}).then(result=>({result,error:undefined}),error=>({result:undefined,error}))
 let marker:string|undefined
 const until=Date.now()+15000
 while(!marker&&Date.now()<until){
  const base=join(home,'software-debug-data',project.project_id)
  try{for(const key of readdirSync(base)){const path=join(base,key,'data','outputs','slow-started');try{if(readFileSync(path,'utf8')==='1')marker=path}catch{}}}catch{}
  if(!marker)await new Promise(done=>setTimeout(done,30))
 }
 controller.abort()
 const outcome=await running
 expect(marker).toBeTruthy();expect(String(outcome.error)).toContain('REPRODUCTION_EXECUTION_INTERRUPTED');expect(String(outcome.error)).toContain('do not replay')
 const id=String(outcome.error).match(/debug_session_id=([a-f0-9-]{36})/)?.[1];expect(id).toBeTruthy()
 const retained=JSON.parse(readFileSync(join(home,'software-debug-sessions',id+'.json'),'utf8'));sessions.push(retained.sessionId)
 expect(retained.state).toBe('closed');expect(readFileSync(marker!,'utf8')).toBe('1')
 await new Promise(done=>setTimeout(done,150));expect(readFileSync(marker!,'utf8')).toBe('1')
},25000)
it('bounds imported metadata before parsing and never interprets an oversized or malformed document as EOF/PASS',async()=>{
 const {reference}=await pack(),path=join(reference.directory,'manifest.json')
 writeFileSync(path,Buffer.alloc(16*1024*1024+1,32))
 await expect(inspectCandidateReproduction(reference)).rejects.toThrow('REPRODUCTION_METADATA_INVALID')
})
it('uses the real built CLI for a frozen export, pinned inspection and one-shot owned journey, not a separate execution engine',async()=>{
 const {candidate,suite,runtimePaths}=await pack(),suiteFile=join(home,'journey.json'),pathsFile=join(home,'runtime-paths.json');writeFileSync(suiteFile,JSON.stringify(suite));writeFileSync(pathsFile,JSON.stringify(runtimePaths))
 const cli=(args:string[])=>JSON.parse(execFileSync(process.execPath,['scripts/reproduce-candidate.mjs',...args],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']}))
 const exported=cli(['export',project.project_id,candidate.id,suiteFile]),inspected=cli(['inspect',project.project_id,exported.id,exported.manifestSha256])
 expect(inspected.origin.candidate_id).toBe(candidate.id);expect(inspected.verification).toBe('not_applicable')
 const run=cli(['run',project.project_id,exported.id,exported.manifestSha256,project.project_id,pathsFile])
 expect(run.debug.steps.every((step:{passed:boolean})=>step.passed)).toBe(true);expect(run.execution.os_reset).toBe('not_attested');expect(run.verification).toBe('not_applicable')
 expect(readFileSync(join(run.debug.data_dir,'outputs','note.txt'),'utf8')).toBe('saved Ω')
 expect(run.evidence.attachments).toHaveLength(1)
},60000)
const electron=resolve('node_modules/electron/dist/electron.exe')
it.skipIf(process.platform!=='win32'||!existsSync(electron))('uses the original real Electron entry and IPC persistence with separate data/profile, without certifying an OS reset or runtime installation',async()=>{
 const root=project.root_path
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'electron-reproduction',main:'main.cjs'}))
 writeFileSync(join(root,'main.cjs'),`const{app,BrowserWindow,ipcMain,screen}=require('electron'),fs=require('node:fs'),path=require('node:path'),data=process.env.APP_DATA_DIR,file=path.join(data,'outputs','note.txt');ipcMain.handle('load',()=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):JSON.parse(fs.readFileSync(path.join(data,'input','old.json'),'utf8')).value);ipcMain.handle('save',(_,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);return true});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,title:'Electron reproduction',width:400,height:240,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});win.setPosition(Math.max(...screen.getAllDisplays().map(d=>d.bounds.x+d.bounds.width))+600,40);win.loadFile('index.html');win.once('ready-to-show',()=>win.showInactive())});app.on('window-all-closed',()=>app.quit())`)
 writeFileSync(join(root,'preload.cjs'),`const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{load:()=>ipcRenderer.invoke('load'),save:value=>ipcRenderer.invoke('save',value)})`)
 writeFileSync(join(root,'index.html'),`<!doctype html><meta charset="utf-8"><title>Electron reproduction</title><input id="note"><button id="save">Save</button><output id="loaded"></output><output id="status">Ready</output><script>window.api.load().then(value=>{document.querySelector('#note').value=value;document.querySelector('#loaded').textContent=value});document.querySelector('#save').onclick=async()=>{await window.api.save(document.querySelector('#note').value);document.querySelector('#status').textContent='Saved'}</script>`)
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'electron',window_title:'Electron reproduction',command:[electron,'.']}))
 const candidate=await prepareSoftwareRelease(project.project_id,root),suite:GuiAcceptanceSuite={version:1,scope_hash:verificationFingerprint(candidate.root)!,covers:['F-001'],fixtures:[{path:'input/old.json',text:JSON.stringify({schema:1,value:'legacy Ω'})}],steps:[{id:'loaded',kind:'expect',selector:'#loaded',equals:'legacy Ω'},{id:'fill',kind:'fill',selector:'#note',value:'Electron Ω'},{id:'save',kind:'click',selector:'#save'},{id:'saved',kind:'expect',selector:'#status',equals:'Saved'},{id:'bytes',kind:'expect_file',path:'outputs/note.txt',equals:'Electron Ω'},{id:'restart',kind:'restart'},{id:'reopened',kind:'expect',selector:'#loaded',equals:'Electron Ω'}]},reference=await prepareCandidateReproduction(project.project_id,candidate.id,suite)
 const result=await runCandidateReproduction({...reference,executorProjectId:project.project_id,runtimePaths:Object.fromEntries((candidate.external_files??[]).map(file=>[file.sha256,file.path])),signal:AbortSignal.timeout(30000)});sessions.push(result.execution.session_id)
 expect(result.debug?.steps.map(step=>step.passed)).toEqual([true,true,true,true,true,true,true]);expect(readFileSync(join(result.debug!.data_dir!,'outputs','note.txt'),'utf8')).toBe('Electron Ω')
 expect(existsSync(join(result.debug!.data_dir!,'electron-profile'))).toBe(true);expect(result.execution.os_reset).toBe('not_attested');expect(result.verification).toBe('not_applicable');expect(result.evidence.attachments).toHaveLength(1)
},45000)
