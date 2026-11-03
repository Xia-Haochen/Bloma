import { launchSoftwareTrial, closeSoftwareTrial } from '../../../main/software/trial'
import { latestCheckedStageCandidate } from '../../../main/software/project-stages'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { projectStageView, verifyProjectStage } from '../../../main/software/project-stages'
import { registerNativeGuiTests } from '../../../main/software/native-gui-registration'
import { guiSuitePath } from '../../../main/desktop/gui-acceptance'
let home:string,old:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-stages-'));process.env.PROMA_HOME=home;project=createProject({request_id:'c',mode:'longterm'},{workflowVersion:'software-v1'})})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})},30000)
const first=`await test('F-001 器材保存',async()=>{if(phase==='initial'){await page.locator('#add').click()}await expect(page.locator('#name-a')).toHaveText('A');await expect(page.locator('#name-b')).toHaveText('B')});`
const second=`await test('F-002 维修借还关联',async()=>{if(phase==='initial'){await page.locator('#repair').click();await expect(page.locator('#state-a')).toHaveText('maintenance');await page.locator('#borrow').click()}await expect(page.locator('#state-a')).toHaveText('maintenance');await expect(page.locator('#state-b')).toHaveText('available')});`
it('runs real cumulative GUI journeys, detects cross-module corruption and preserves earlier frozen cases at final registration',async()=>{
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'器材管理',ui:'required',delivery:'browser',requirements:[{description:'保存器材',expected:'两件器材重开保留'},{description:'维修和借还',expected:'维修器材不能借出且不影响另一件，重开保留'}],project_plan:{version:1,current:'store',stages:[{id:'store',title:'登记',feature_ids:['F-001']},{id:'flow',title:'借还维修',feature_ids:['F-002']}]}}),{projectId:project.project_id,sessionId:'s',source:'器材管理',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip'
  syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const brief=markPrdUserConfirmed(project.project_id)!,scope=prdScopeFingerprint(brief)
  updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  const root=project.root_path
  writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs',String(port)],url:`http://127.0.0.1:${port}`}))
  writeFileSync(join(root,'domain.cjs'),`exports.borrow=(item)=>{if(item.state!=='maintenance')item.state='borrowed'}`)
  writeFileSync(join(root,'server.cjs'),`const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),domain=require('./domain.cjs');const file=path.join(process.env.APP_DATA_DIR,'items.json');let items=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};http.createServer((q,s)=>{if(q.url.startsWith('/action/')){const action=q.url.split('/').pop();if(action==='add'){items.a??={name:'A',state:'available'};items.b??={name:'B',state:'available'}}if(action==='repair')items.a.state='maintenance';if(action==='borrow')domain.borrow(items.a);fs.writeFileSync(file,JSON.stringify(items));s.end(JSON.stringify(items))}else if(q.url==='/items'){s.end(JSON.stringify(items))}else{s.setHeader('content-type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'))}}).listen(Number(process.argv[2]),'127.0.0.1')`)
  writeFileSync(join(root,'index.html'),`<!doctype html><button id="add">登记</button><button id="repair">维修A</button><button id="borrow">借出A</button><div id="list"></div><script>function render(items){document.querySelector('#list').replaceChildren();for(const [id,v]of Object.entries(items)){for(const key of ['name','state']){const el=document.createElement('p');el.id=key+'-'+id;el.textContent=v[key];document.querySelector('#list').append(el)}}}for(const action of ['add','repair','borrow'])document.getElementById(action).onclick=async()=>render(await(await fetch('/action/'+action)).json());fetch('/items').then(r=>r.json()).then(render)</script>`)
  const script=(body:string)=>writeFileSync(join(root,'acceptance.mjs'),`export default async({test,page,expect,phase})=>{${body}}`)
  script(first)
  expect((await verifyProjectStage(project.project_id,'store','acceptance.mjs',new AbortController().signal,true)).status).toBe('passed')
  expect(existsSync(guiSuitePath(project.project_id))).toBe(false)
  expect(projectStageView(project.project_id).next_stage).toBe('flow')
  script(first+second)
  writeFileSync(join(root,'domain.cjs'),`exports.borrow=(item)=>{item.state='borrowed'}`)
  expect((await verifyProjectStage(project.project_id,'flow','acceptance.mjs',new AbortController().signal,true)).status).toBe('failed')
  const preserved=latestCheckedStageCandidate(project.project_id)
  const trial=await launchSoftwareTrial(project.project_id)
  expect(trial.started).toBe(true);expect(trial.trial?.release_id).toBe(preserved);expect(trial.trial?.qualification).toBe('stage_checked_test_data')
  await closeSoftwareTrial(project.project_id,trial.trial!.release_id)
  writeFileSync(join(root,'domain.cjs'),`exports.borrow=(item)=>{if(item.state!=='maintenance')item.state='borrowed'}`)
  expect((await verifyProjectStage(project.project_id,'flow','acceptance.mjs',new AbortController().signal,true)).status).toBe('passed')
  expect(projectStageView(project.project_id).next_stage).toBeNull()
  expect(registerNativeGuiTests(project.project_id,'acceptance.mjs',true).covers).toEqual(['F-001','F-002'])
  script(first+second.replace("toHaveText('maintenance')","toHaveText('borrowed')"))
  await expect(verifyProjectStage(project.project_id,'flow','acceptance.mjs',new AbortController().signal,true)).rejects.toThrow('RETAINED_BEHAVIOR')
},180000)
