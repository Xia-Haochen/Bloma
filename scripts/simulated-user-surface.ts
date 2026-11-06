import {chromium,_electron,type Page,type BrowserContext,type ElectronApplication,type ElementHandle} from 'playwright'
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join,basename,extname} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {resolvePreviewFile} from '../main/delivery/preview-file'
import {savePastedImage} from '../main/platform/shell/pasted-images'
import {findProject} from '../main/project/project-service'
import {prepareSoftwareRelease,verifyReleaseSource,activeSoftwareRelease} from '../main/software/release-store'
import {softwareEnvironment} from '../main/software/command-runtime'
import {electronEntry} from '../main/software/electron-entry'
import {isolatedBrowserLaunch} from '../main/software/isolated-launch'
import {startSoftwareProcess,stopSoftwareProcess} from '../main/software/process-manager'
import {runSecurityScan} from '../main/verification/security-scan'
import type {UserTestFile} from './user-test-files'
import type {UserAction,UserView} from './simulated-user'
import {UserInteractionError,validateUserAction} from './user-action'

function describeControl(el:Node){
  const e=el as HTMLElement,input=e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement
  const labels='labels' in e?(e as HTMLInputElement).labels:null
  const labelled=e.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ')
  const label=e.getAttribute('aria-label')||labelled||labels?.[0]?.innerText||e.innerText||e.getAttribute('placeholder')||e.getAttribute('title')||''
  const actions=['click']
  if(e instanceof HTMLInputElement&&e.type==='file')actions.push('upload')
  else if(e instanceof HTMLTextAreaElement||e.isContentEditable||e instanceof HTMLInputElement&&!['button','submit','reset','checkbox','radio','range','color','hidden'].includes(e.type))actions.push('fill')
  if(e instanceof HTMLSelectElement)actions.push('select')
  if(e instanceof HTMLCanvasElement)actions.push('draw')
  return{tag:e.tagName.toLowerCase(),role:e.getAttribute('role')??(e instanceof HTMLInputElement?e.type:undefined),label:label.trim().slice(0,160),actions,
    value:input&&!(e instanceof HTMLInputElement&&e.type==='password')?e.value.slice(0,300):undefined,
    checked:e instanceof HTMLInputElement?e.checked:e.hasAttribute('aria-checked')?e.getAttribute('aria-checked')==='true':undefined,
    disabled:e.matches(':disabled')||e.getAttribute('aria-disabled')==='true',options:e instanceof HTMLSelectElement?[...e.options].map(o=>o.label):undefined}
}

function describeMedia(el:Node){
  const e=el as HTMLMediaElement
  return{kind:e.tagName.toLowerCase(),label:e.getAttribute('aria-label')??e.getAttribute('title')??'',duration:Number.isFinite(e.duration)?e.duration:null,
    currentTime:e.currentTime,paused:e.paused,ended:e.ended,muted:e.muted,volume:e.volume,readyState:e.readyState,error:e.error?.code??null}
}

function interactionFailure(error:unknown,effect:'none'|'unknown'):never{
  if(error instanceof UserInteractionError)throw error
  if(error instanceof Error&&(error.name==='TimeoutError'||/not attached|not connected|not visible|not enabled|not editable|not an? (?:input|select)|Target .*closed|Execution context was destroyed|Frame was detached/i.test(error.message)))
    throw new UserInteractionError('surface','刚才的界面操作没有成功确认。请查看新画面再决定下一步；不要假装成功，也不要盲目重复提交。',effect,{cause:error})
  throw error
}
/** Public UI only: no selector, eval, file, request or shell tool is exposed. */
export class UserPage {
  private controls:ElementHandle[]=[]
  private observation=''
  private descriptors:UserView['controls']=[]
  private chooser?:ElementHandle
  private downloads:NonNullable<UserView['downloads']>=[]
  constructor(readonly page:Page,readonly kind:'preview'|'app',readonly folder:string,readonly session:string,readonly files:UserTestFile[]=[]){
    page.on('filechooser',chooser=>{this.chooser=chooser.element()})
    page.on('download',download=>{
      const row={id:randomUUID(),name:basename(download.suggestedFilename()),status:'saving'};this.downloads.push(row)
      const directory=join(folder,'downloads');mkdirSync(directory,{recursive:true})
      void download.saveAs(join(directory,row.id+'-'+row.name)).then(()=>{row.status='saved'},()=>{row.status='failed'}).finally(()=>writeFileSync(join(directory,row.id+'.json'),JSON.stringify(row)))
    })
  }
  async snapshot():Promise<UserView>{
    this.observation=''
    for(const control of this.controls)await control.dispose();this.controls=[];this.descriptors=[]
    const controls:UserView['controls']=[]
    for(const element of await this.page.locator('button,input,textarea,select,canvas,a,summary,[contenteditable="true"],[role="button"],[role="checkbox"],[role="switch"],[role="radio"],[role="tab"],[role="menuitem"],[role="option"],[role="textbox"],[role="combobox"],[role="link"]').elementHandles()){
      if(!await element.isVisible()&&!await element.evaluate(el=>el instanceof HTMLInputElement&&[...el.labels??[]].some(l=>!!(l.offsetWidth||l.offsetHeight||l.getClientRects().length)))||this.controls.length>=100){await element.dispose();continue}
      const item=await element.evaluate(describeControl)
      controls.push({ref:this.controls.length,...item});this.controls.push(element)
    }
    if(this.chooser){controls.push({ref:this.controls.length,...await this.chooser.evaluate(describeControl)});this.controls.push(this.chooser);this.chooser=undefined}
    this.descriptors=controls;this.observation=randomUUID();mkdirSync(this.folder,{recursive:true})
    // Temporal media observations are sampled by the host, not invented by the model.
    const media:NonNullable<UserView['media']>=[],handles=await this.page.locator('video,audio').elementHandles()
    const initial:ReturnType<typeof describeMedia>[]=[]
    const visible:ElementHandle[]=[]
    try{
      for(const handle of handles)if(await handle.isVisible()){visible.push(handle);initial.push(await handle.evaluate(describeMedia))}
      const images:NonNullable<UserView['image']>=[]
      const first=await this.page.screenshot({fullPage:false})
      const active=initial.some(m=>!m.paused&&!m.ended&&m.readyState>=2)
      let bytes=first
      if(active){
        writeFileSync(join(this.folder,this.observation+'-start.png'),first)
        images.push(savePastedImage(this.session,first.toString('base64'),'png'))
        const at=Date.now();await this.page.waitForTimeout(1000)
        for(let i=0;i<visible.length;i++){const after=await visible[i].evaluate(describeMedia);media.push({...after,progress:{from:initial[i].currentTime,to:after.currentTime,elapsed_ms:Date.now()-at}})}
        bytes=await this.page.screenshot({fullPage:false})
      }else media.push(...initial)
      writeFileSync(join(this.folder,this.observation+'.png'),bytes);images.push(savePastedImage(this.session,bytes.toString('base64'),'png'))
      const view:UserView={id:this.observation,kind:this.kind,text:(await this.page.locator('body').innerText()).slice(0,16000),controls,media,
        files:(this.kind==='app'?this.files:[]).map(({id,name,description})=>({id,name,description})),downloads:this.downloads.map(row=>({...row})),image:images,
        audio:{status:'not_measured',limit:'媒体时间/音量状态不证明扬声器实际声音；没有音频测量，不得声称听到声音'}}
      const state={kind:view.kind,text:view.text,controls:view.controls,downloads:view.downloads,media:media.map(m=>({...m,currentTime:Math.floor(m.currentTime),progress:m.progress?{from:Math.floor(m.progress.from),to:Math.floor(m.progress.to)}:undefined})),visual:media.length?undefined:createHash('sha256').update(bytes).digest('hex')}
      view.stateKey=createHash('sha256').update(JSON.stringify(state)).digest('hex')
      writeFileSync(join(this.folder,this.observation+'.json'),JSON.stringify(view));return view
    }finally{for(const handle of handles)await handle.dispose()}
  }
  assertObservation(action:UserAction){
    if(action.observation!==this.observation)throw new UserInteractionError('action','SIMULATED_USER_STALE_OBSERVATION: 画面已变化，请重新观察。')
  }
  async act(action:UserAction){
    validateUserAction(action);this.assertObservation(action)
    let dispatched=false
    try{
      if(action.action==='wait'){await this.page.waitForTimeout(action.milliseconds!);return}
      const element=this.controls[action.ref!],descriptor=this.descriptors[action.ref!]
      if(!element||!descriptor)throw new UserInteractionError('action','当前画面没有这个控件，请选择新画面中的编号。')
      if(!descriptor.actions?.includes(action.action))throw new UserInteractionError('action','该控件不支持这个操作，请按画面中列出的操作使用。')
      const identity=await element.evaluate(describeControl)
      if(identity.tag!==descriptor.tag||identity.role!==descriptor.role||identity.label!==descriptor.label)throw new UserInteractionError('action','控件含义已变化，请重新观察再选择。')
      const current=await element.evaluate(el=>({connected:el.isConnected,disabled:(el as Element).matches(':disabled')||(el as Element).getAttribute('aria-disabled')==='true'}))
      if(!current.connected||current.disabled)throw new UserInteractionError('action','控件已消失或不可用，请查看新画面。')
      if(action.action==='upload'){
        const paths=action.files!.map(id=>{
          const file=this.files.find(f=>f.id===id)
          if(!file)throw new UserInteractionError('action','请选择当前可用文件列表中的文件。')
          if(createHash('sha256').update(readFileSync(file.path)).digest('hex')!==file.sha256)throw Error('USER_TEST_FILE_CHANGED_OR_OUTSIDE')
          return file.path
        })
        dispatched=true;await element.setInputFiles(paths,{timeout:5000})
      }else if(action.action==='click'){
        // Native labelled controls are activated through their visible label, with normal hit testing.
        const handle=await element.evaluateHandle(el=>el instanceof HTMLInputElement&&['radio','checkbox','file'].includes(el.type)?[...el.labels??[]].find(l=>!!(l.offsetWidth||l.offsetHeight||l.getClientRects().length))??el:el)
        try{dispatched=true;await handle.asElement()!.click({timeout:5000})}finally{await handle.dispose()}
      }else if(action.action==='fill'||action.action==='select'){
        dispatched=true
        if(action.action==='fill')await element.fill(action.value!,{timeout:5000});else await element.selectOption({label:action.value!},{timeout:5000})
      }else if(action.action==='draw'){
        const box=await element.boundingBox(),points=action.points!
        if(!box)throw new UserInteractionError('action','画布不在当前可见画面中。')
        dispatched=true;await this.page.mouse.move(box.x+points[0].x*box.width,box.y+points[0].y*box.height);await this.page.mouse.down()
        try{for(const p of points.slice(1)){if(p.delay)await this.page.waitForTimeout(p.delay);await this.page.mouse.move(box.x+p.x*box.width,box.y+p.y*box.height)}}finally{await this.page.mouse.up()}
      }
    }catch(error){interactionFailure(error,dispatched?'unknown':'none')}
    finally{this.observation=''}
  }
}

export class SimulatedUserSurface {
  private browser?:BrowserContext
  private app?:ElectronApplication
  private service?:string
  private surface?:UserPage
  private release?:Awaited<ReturnType<typeof prepareSoftwareRelease>>
  private preview?:string
  constructor(private projectId:string,private folder:string,private session:string,private files:UserTestFile[]=[]){}
  async close(){
    const app=this.app,browser=this.browser,service=this.service
    this.app=undefined;this.browser=undefined;this.service=undefined;this.surface=undefined
    // Let the UI close/flush before its backend; still clean up if UI close fails.
    const closed=await Promise.allSettled([app?.close(),browser?.close()])
    if(service)await stopSoftwareProcess(this.projectId,service,this.session)
    const failed=closed.find(row=>row.status==='rejected');if(failed?.status==='rejected')throw failed.reason
    if(this.release)await verifyReleaseSource(this.release)
  }
  async openPreview(url:string){
    if(this.preview===url&&this.surface&&!this.surface.page.isClosed())return
    const target=new URL(url)
    const native=target.protocol==='bloma-file:'
    if(native){if(resolvePreviewFile(url,this.projectId).status!==200)throw Error('SIMULATED_USER_PREVIEW_DENIED')}
    else if(!['http:','https:'].includes(target.protocol)||!['localhost','127.0.0.1','[::1]'].includes(target.hostname))throw Error('SIMULATED_USER_PREVIEW_NOT_LOCAL')
    await this.close();this.release=undefined;this.preview=url
    this.browser=await chromium.launchPersistentContext(join(this.folder,'preview-profile'),{headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
    const page=this.browser.pages()[0]??await this.browser.newPage()
    let address=url
    if(native){
      const prefix='/'+randomUUID()+'/'
      await this.browser.route('http://127.0.0.1/**',async route=>{
        const request=new URL(route.request().url())
        if(route.request().method()!=='GET')return route.fulfill({status:403,body:'Forbidden'})
        const relative=request.pathname.startsWith(prefix)?request.pathname.slice(prefix.length):request.pathname.replace(/^\/+/,'')
        const file=resolvePreviewFile(`bloma-file://${this.projectId}/${relative}${request.search}`,this.projectId)
        if(file.status!==200)return route.fulfill({status:file.status,body:'Preview unavailable'})
        const types:Record<string,string>={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2'}
        await route.fulfill({status:200,contentType:types[extname(file.path!).toLowerCase()]??'application/octet-stream',body:readFileSync(file.path!)})
      })
      address='http://127.0.0.1'+prefix+target.pathname.replace(/^\/+/,'')+target.search
    }
    await page.goto(address,{waitUntil:'domcontentloaded',timeout:15000})
    this.surface=new UserPage(page,'preview',join(this.folder,'observations'),this.session,this.files)
  }
  async openApp(restart=false){
    try{await this.openAppUnchecked(restart)}catch(error){interactionFailure(error,'none')}
  }
  private async openAppUnchecked(restart=false){
    if(this.surface?.kind==='app'&&!restart&&!this.surface.page.isClosed())return
    await this.close();this.preview=undefined
    if(!restart||!this.release){
      const project=findProject(this.projectId)
      if(project.status==='completed'&&project.desktop_phase==='delivered'){
        this.release=await activeSoftwareRelease(this.projectId)??undefined
        if(!this.release)throw Error('SIMULATED_USER_RELEASE_MISSING')
      }else this.release=await prepareSoftwareRelease(this.projectId,project.root_path)
    }
    const release=this.release
    if(!runSecurityScan({project_id:this.projectId,root_path:release.root,profile:'local-software'}).passed)throw Error('SIMULATED_USER_LAUNCH_BLOCKED')
    const data=join(this.folder,'data');mkdirSync(data,{recursive:true});let page:Page
    if(release.launch.ui==='electron'){
      const entry=electronEntry(release.root,release.launch.command)
      this.app=await _electron.launch({...entry,args:[...entry.args,'--mute-audio',`--user-data-dir=${join(this.folder,'profile')}`],cwd:release.root,env:softwareEnvironment(this.projectId,data,release.root),timeout:20000});page=await this.app.firstWindow()
    }else if(release.launch.ui==='browser'){
      const launch=await isolatedBrowserLaunch(release.launch)
      const service=await startSoftwareProcess({projectId:this.projectId,root:release.root,sessionId:this.session,command:launch.command,url:launch.url,dataDir:data,purpose:'trial',readyMs:10000});this.service=service.id
      if(!service.ready||!launch.url)throw Error('SIMULATED_USER_APP_NOT_READY')
      this.browser=await chromium.launchPersistentContext(join(this.folder,'profile'),{headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
      page=this.browser.pages()[0]??await this.browser.newPage();await page.goto(launch.url,{waitUntil:'domcontentloaded',timeout:15000})
    }else throw Error('SIMULATED_USER_UI_UNSUPPORTED')
    this.surface=new UserPage(page,'app',join(this.folder,'observations'),this.session,this.files)
  }
  async snapshot(){
    let view:UserView|undefined
    try{view=await this.surface?.snapshot()}catch(error){interactionFailure(error,'none')}
    if(view)writeFileSync(join(this.folder,'observations',view.id+'.json'),JSON.stringify({...view,host:{candidate:this.release?.id,source:this.release?.source.digest,preview:this.preview}}))
    return view
  }
  async assertFeedbackSource(){
    if(this.surface?.kind!=='app'||!this.release)throw Error('SIMULATED_USER_APP_REQUIRED')
    await verifyReleaseSource(this.release)
  }
  async act(action:UserAction){
    validateUserAction(action)
    if(action.action==='reopen'){
      this.surface?.assertObservation(action)
      if(this.surface?.kind!=='app')throw Error('SIMULATED_USER_REOPEN_REQUIRES_APP')
      try{await this.openApp(true)}catch(error){interactionFailure(error,'unknown')}
    }else if(this.surface)await this.surface.act(action)
    else throw Error('SIMULATED_USER_VIEW_REQUIRED')
  }
}
