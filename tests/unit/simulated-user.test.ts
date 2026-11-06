import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,beforeEach,it,expect} from 'vitest'
import {chromium} from 'playwright'
import {UserInteractionError} from '../../scripts/user-action'
import {publicUserCard,userReply,simulateUserSession,decideAsUser} from '../../scripts/simulated-user'
import {UserPage,SimulatedUserSurface} from '../../scripts/simulated-user-surface'
import {loadUserTestFiles} from '../../scripts/user-test-files'
import {assertSimulatedContinuation,observationHash,claimSimulatedRun} from '../../scripts/observation-control'
import {continuationBoundary} from '../../scripts/observation-continuation.mjs'
import {createProject} from '../../main/project/project-service'
import type {AgentEvent} from '../../shared/types'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'
let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'simulated-user-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const card=(kind='lean_scope')=>({event_id:'e',session_id:'s',created_at:'now',type:'user_decision_required',payload:{kind,title:'确认内容',summary:'保存姓名',scope:{private_source:'secret'},questions:[{id:'host-only-id',label:'按这份做'}]}} as AgentEvent)
it('projects only public text and choices, binds visual feedback and refuses invented choices',()=>{
  expect(JSON.stringify(publicUserCard(card()))).not.toMatch(/secret|host-only-id/)
  expect(userReply({action:'reply',choice:0,text:'按这份做'},card(),undefined)).toEqual({text:'按这份做',selected:'host-only-id'})
  const free=card();free.payload.questions=[];expect(userReply({action:'reply',choice:0,text:'具体意见'},free,undefined).selected).toBeUndefined()
  expect(()=>userReply({action:'reply',choice:3,text:'做'},card(),undefined)).toThrow('选项')
  expect(()=>userReply({action:'reply',choice:0,text:'样式可以'},card('ux_confirm'),undefined)).toThrow('观察')
  expect(()=>userReply({action:'reply',text:'保存没反应',observation:'old'},undefined,{id:'new',kind:'app',text:'',controls:[]})).toThrow('观察')
})
it('uses a separate tool-free model request with only public observations',async()=>{
  const query:SDKQuery=async function*(prompt,options){
    expect(options.maxTokens).toBe(262144);expect(prompt).not.toContain('\"id\":\"v\"');expect(options.tools).toBeUndefined();expect(options.images).toEqual([{imageId:'image',media_type:'image/png'}])
    expect(options.accounting?.role).toBe('simulated-user');expect(prompt).not.toContain('imageId');expect(options.history?.[0].role).toBe('system')
    yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'{action:"stop",observation:"old-frame",text:"还没看到程序，无法评价"}'}]}}
  }
  const result=await decideAsUser(query,{env:{},maxTokens:262144,sessionId:'user',signal:new AbortController().signal,accounting:{projectId:'p',role:'simulated-user'}},{goal:'保存',view:{id:'v',kind:'app',text:'公开界面',controls:[],image:[{imageId:'image',media_type:'image/png'}]},history:[]})
  expect(result.action).toBe('stop');expect(result.observation).toBe('v')
})
it('lets the user confirm, try the UI and report observed problems without exposing repair hooks',async()=>{
  let turns=0,clicks=0,decisions=0;const replies:string[]=[],rows:unknown[]=[]
  const result=await simulateUserSession({goal:'保存',signal:new AbortController().signal,
    turn:async reply=>{turns++;if(reply)replies.push(reply.text);return turns===1?{card:card()}:turns===3?{failed:'producer stopped'}:{}},
    view:async c=>c?undefined:{id:'view-'+clicks,kind:'app',text:clicks?'仍没有显示姓名':'保存',controls:[]},
    decide:async state=>++decisions===1?{action:'reply',choice:0,text:'按这份做'}:decisions===2?{action:'click',observation:state.view!.id,ref:0}:{action:'reply',observation:state.view!.id,text:'我点了保存，但没有看到保存的姓名。'},
    act:async()=>{clicks++},record:row=>rows.push(row)})
  expect(result.status).toBe('product_stopped');expect(clicks).toBe(1);expect(replies).toEqual(['按这份做','我点了保存，但没有看到保存的姓名。']);expect(rows.filter((row:any)=>row.type==='action_completed')).toHaveLength(3)
})
it('rejects a made-up successful trial and stops at a bounded number of actions',async()=>{
  const deps={goal:'保存',signal:new AbortController().signal,turn:async()=>({}),view:async()=>({id:'v',kind:'app' as const,text:'',controls:[]}),act:async()=>{},record:()=>{}}
  expect((await simulateUserSession({...deps,decide:async()=>({action:'finish',observation:'v',text:'都好了'})}))).toMatchObject({status:'user_recovery_exhausted',steps:3})
  expect((await simulateUserSession({...deps,maxSteps:2,decide:async()=>({action:'wait',observation:'v',milliseconds:1})})).status).toBe('user_step_limit')
})
it('returns a UI timeout to user observation without leaking engine errors or forcing the click',async()=>{
  let turns=0,decisions=0;const rows:unknown[]=[]
  const result=await simulateUserSession({goal:'保存',signal:new AbortController().signal,
    turn:async reply=>{turns++;return reply?{failed:'producer stopped'}:{card:card('ux_confirm')}},
    view:async()=>({id:'v',kind:'preview',text:'保存',controls:[]}),
    decide:async state=>{if(++decisions===1)return{action:'click',observation:'v',ref:0};expect(JSON.stringify(state.history)).not.toContain('private-engine-path');expect(JSON.stringify(state.history)).toContain('没有成功');return{action:'reply',observation:'v',text:'按钮被遮挡了，请调整布局。'}},
    act:async()=>{throw new UserInteractionError('surface','刚才的操作没有成功确认，请重新观察。','unknown',{cause:new Error('private-engine-path')})},record:row=>rows.push(row)})
  expect(result.status).toBe('product_stopped');expect(turns).toBe(2);expect(rows.some(row=>(row as any).type==='interaction_failed')).toBe(true)
})
it('operates actual visible controls and canvas, captures evidence and rejects stale or arbitrary actions',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage();await page.setContent('<label>Name<input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output><canvas width="200" height="100"></canvas><script>const secret="NOT_PUBLIC";document.querySelector("canvas").onpointerup=()=>document.querySelector("output").textContent="drawn"</script>')
    const surface=new UserPage(page,'app',join(home,'evidence'),'sim-user'),view=await surface.snapshot()
    expect(view.text).not.toContain('NOT_PUBLIC');expect(view.image).toHaveLength(1)
    await surface.act({action:'fill',observation:view.id,ref:view.controls.find(c=>c.tag==='input')!.ref,value:'Alice'})
    const afterFill=await surface.snapshot();await surface.act({action:'click',observation:afterFill.id,ref:afterFill.controls.find(c=>c.tag==='button')!.ref})
    const next=await surface.snapshot();expect(next.text).toContain('Alice')
    await expect(surface.act({action:'click',observation:view.id,ref:0})).rejects.toThrow('STALE')
    await surface.act({action:'draw',observation:next.id,ref:next.controls.find(c=>c.tag==='canvas')!.ref,points:[{x:.1,y:.1},{x:.8,y:.8,delay:10}]})
    expect((await surface.snapshot()).text).toContain('drawn')
  }finally{await browser.close()}
})
it('reopens the real browser app with the same isolated user data without changing its source',async()=>{
  const project=createProject({request_id:'p',mode:'quick'},{workflowVersion:'software-v1'}),root=project.root_path
  writeFileSync(join(root,'index.html'),'<label>Name<input></label><button onclick="fetch(\'/save?name=\'+encodeURIComponent(document.querySelector(\'input\').value)).then(r=>r.text()).then(t=>document.querySelector(\'output\').textContent=t)">Save</button><button onclick="fetch(\'/load\').then(r=>r.text()).then(t=>document.querySelector(\'output\').textContent=t)">Load</button><output></output>')
  const server=`const fs=require('node:fs'),p=require('node:path'),file=p.join(process.env.APP_DATA_DIR,'name.txt');require('node:http').createServer((q,s)=>{const u=new URL(q.url,'http://local');if(u.pathname==='/save'){fs.writeFileSync(file,u.searchParams.get('name'));s.end('saved')}else if(u.pathname==='/load')s.end(fs.existsSync(file)?fs.readFileSync(file):'empty');else{s.setHeader('content-type','text/html');s.end(fs.readFileSync('index.html'))}}).listen(Number(process.env.PORT||process.argv[2]),'127.0.0.1')`
  writeFileSync(join(root,'server.cjs'),server);writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs','7777'],url:'http://127.0.0.1:7777'}))
  const surface=new SimulatedUserSurface(project.project_id,join(home,'user-trial'),'sim-user')
  try{
    await surface.openApp();let view=(await surface.snapshot())!
    await surface.act({action:'fill',observation:view.id,ref:view.controls.find(c=>c.tag==='input')!.ref,value:'Alice'})
    view=(await surface.snapshot())!;await surface.act({action:'click',observation:view.id,ref:view.controls.find(c=>c.label==='Save')!.ref})
    await expect.poll(async()=> (await surface.snapshot())!.text).toContain('saved')
    await surface.openApp(true);view=(await surface.snapshot())!
    await surface.act({action:'click',observation:view.id,ref:view.controls.find(c=>c.label==='Load')!.ref})
    await expect.poll(async()=>(await surface.snapshot())!.text).toContain('Alice')
    expect(readFileSync(join(root,'server.cjs'),'utf8')).toBe(server)
    await surface.assertFeedbackSource()
    writeFileSync(join(root,'server.cjs'),server+'\n// changed candidate')
    try{await expect(surface.assertFeedbackSource()).rejects.toThrow('RELEASE_WORKING_SOURCE_CHANGED')}
    finally{writeFileSync(join(root,'server.cjs'),server)}
  }finally{await surface.close()}
},60000)
it('adopts the old boundary without resetting its budget or report, and rejects tampering',()=>{
  mkdirSync(join(home,'task'));const manifest=JSON.stringify({thinking:'low',tasks:{task:{goal:'保存'}}}),policy='{"cap":10}',report='{"status":"awaiting_user"}',project='{"project_id":"p"}'
  for(const [path,bytes] of [['manifest.json',manifest],['monetary-policy.json',policy],['task/run-old.json',report],['task/project.json',project],['monetary-policy.json.state.json','{"spent":0.128699}']])writeFileSync(join(home,path),bytes)
  writeFileSync(join(home,'user-runtime.json'),JSON.stringify({digest:'new',migration:{authorization:'模拟用户',manifest_sha256:observationHash(manifest),policy_sha256:observationHash(policy),project_sha256:observationHash(project),report:'task/run-old.json',report_sha256:observationHash(report)}}))
  expect(assertSimulatedContinuation(home,'low','new').status).toBe('awaiting_user')
  expect(readFileSync(join(home,'monetary-policy.json.state.json'),'utf8')).toBe('{"spent":0.128699}')
  writeFileSync(join(home,'user-run-claimed.json'),'claimed')
  expect(()=>assertSimulatedContinuation(home,'low','new')).toThrow('BOUNDARY_REQUIRED')
  rmSync(join(home,'user-run-claimed.json'))
  writeFileSync(join(home,'monetary-policy.json'),'changed');expect(()=>assertSimulatedContinuation(home,'low','new')).toThrow('IDENTITY_CHANGED')
})
it('uploads only frozen test files through the UI and records actual downloads',async()=>{
  writeFileSync(join(home,'clip.webm'),'synthetic fixture');writeFileSync(join(home,'user-files.json'),JSON.stringify([{id:'clip',name:'clip.webm',description:'测试片段',path:'clip.webm',sha256:observationHash('synthetic fixture')}]))
  const files=loadUserTestFiles(home),browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage()
    await page.route('http://127.0.0.1:12345/**',route=>route.request().url().endsWith('/download')?route.fulfill({body:'exported',headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename=result.webm'}}):route.fulfill({contentType:'text/html',body:'<input type="file" onchange="document.querySelector(\'output\').textContent=this.files[0].name"><output></output><a href="/download">Export</a>'}))
    await page.goto('http://127.0.0.1:12345/')
    const surface=new UserPage(page,'app',join(home,'observations'),'sim-user',files),view=await surface.snapshot()
    expect(JSON.stringify(view.files)).not.toContain(home)
    await expect(surface.act({action:'upload',observation:view.id,ref:0,files:['arbitrary-file']})).rejects.toThrow('可用文件')
    const uploadView=await surface.snapshot();await surface.act({action:'upload',observation:uploadView.id,ref:0,files:['clip']})
    expect((await surface.snapshot()).text).toContain('clip.webm')
    const current=await surface.snapshot();await surface.act({action:'click',observation:current.id,ref:current.controls.find(c=>c.label==='Export')!.ref})
    await expect.poll(async()=>(await surface.snapshot()).downloads?.[0]?.status,{timeout:10000}).toBe('saved')
    writeFileSync(join(home,'clip.webm'),'changed');expect(()=>loadUserTestFiles(home)).toThrow('CHANGED_OR_OUTSIDE')
  }finally{await browser.close()}
})

it('resumes a finished published-product trial by frozen identity, not an error allowlist',()=>{
  mkdirSync(join(home,'task'));mkdirSync(join(home,'home'))
  const project={project_id:'p',status:'completed',current_stage:'completed',desktop_phase:'delivered',software_release_id:'release'}
  const report={project_id:'p',session_id:'s',status:'failed',error:'an entirely new interaction failure',finished_at:new Date().toISOString()}
  const files:Record<string,string>={'manifest.json':JSON.stringify({thinking:'low',tasks:{task:{}}}),'monetary-policy.json':'policy','task/project.json':'identity','task/user-run-old.json':JSON.stringify(report),'monetary-policy.json.state.json':JSON.stringify({entries:[{status:'reported',charged_micro_rmb:123}]}),'home/projects.json':JSON.stringify({projects:[project]})}
  for(const [name,value] of Object.entries(files))writeFileSync(join(home,name),value)
  const boundary=continuationBoundary(home,report),previous=process.env.BLOMA_OBSERVATION_RETEST
  process.env.BLOMA_OBSERVATION_RETEST='interaction-v2'
  try{
    writeFileSync(join(home,'user-runtime-interaction-v2.json'),JSON.stringify({digest:'runtime',migration:{authorization:'继续用户验收',attempt:'-interaction-v2',boundary,manifest_sha256:observationHash(files['manifest.json']),policy_sha256:observationHash(files['monetary-policy.json']),project_sha256:observationHash(files['task/project.json']),report:'task/user-run-old.json',report_sha256:observationHash(files['task/user-run-old.json'])}}))
    expect(assertSimulatedContinuation(home,'low','runtime').software_release_id).toBe('release')
    writeFileSync(join(home,'monetary-policy.json.state.json'),JSON.stringify({entries:[{status:'reported',charged_micro_rmb:124}]}))
    expect(()=>assertSimulatedContinuation(home,'low','runtime')).toThrow('BOUNDARY_CHANGED')
    writeFileSync(join(home,'monetary-policy.json.state.json'),files['monetary-policy.json.state.json'])
    project.software_release_id='changed';writeFileSync(join(home,'home/projects.json'),JSON.stringify({projects:[project]}))
    expect(()=>assertSimulatedContinuation(home,'low','runtime')).toThrow('BOUNDARY_CHANGED')
    expect(()=>continuationBoundary(home,{...report,status:'running'})).toThrow('FINISHED')
    writeFileSync(join(home,'monetary-policy.json.state.json'),JSON.stringify({entries:[{status:'reserved'}]}))
    expect(()=>continuationBoundary(home,report)).toThrow('UNSETTLED')
  }finally{if(previous===undefined)delete process.env.BLOMA_OBSERVATION_RETEST;else process.env.BLOMA_OBSERVATION_RETEST=previous}
})

it('holds one execution owner across attempt names and retains consumed claims',()=>{
  const previous=process.env.BLOMA_OBSERVATION_RETEST
  try{
    process.env.BLOMA_OBSERVATION_RETEST='one';const release=claimSimulatedRun(home,{})
    process.env.BLOMA_OBSERVATION_RETEST='two';expect(()=>claimSimulatedRun(home,{})).toThrow()
    release();const second=claimSimulatedRun(home,{});second()
    expect(()=>claimSimulatedRun(home,{})).toThrow();expect(existsSync(join(home,'user-active.json'))).toBe(false)
    expect(existsSync(join(home,'user-run-claimed-one.json'))).toBe(true)
  }finally{if(previous===undefined)delete process.env.BLOMA_OBSERVATION_RETEST;else process.env.BLOMA_OBSERVATION_RETEST=previous}
})
