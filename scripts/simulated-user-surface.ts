import {chromium,_electron,type Page,type BrowserContext,type ElectronApplication,type ElementHandle} from 'playwright'
import {existsSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join,basename} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {savePastedImage} from '../main/platform/shell/pasted-images'
import {findProject} from '../main/project/project-service'
import {prepareSoftwareRelease,verifyReleaseSource} from '../main/software/release-store'
import {softwareEnvironment} from '../main/software/command-runtime'
import {electronEntry} from '../main/software/electron-entry'
import {isolatedBrowserLaunch} from '../main/software/isolated-launch'
import {startSoftwareProcess,stopSoftwareProcess} from '../main/software/process-manager'
import {runSecurityScan} from '../main/verification/security-scan'
import type {UserTestFile} from './user-test-files'
import type {UserAction,UserView} from './simulated-user'

/** Public UI only: no selector, eval, file, request or shell tool is exposed. */
export class UserPage {
  private controls:ElementHandle[]=[]
  private observation=''
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
    for(const control of this.controls)await control.dispose();this.controls=[]
    const controls:UserView['controls']=[]
    for(const element of await this.page.locator('button,input,textarea,select,canvas,a,[role="button"],[role="checkbox"],[role="switch"]').elementHandles()){
      if(!await element.isVisible()||this.controls.length>=100){await element.dispose();continue}
      const item=await element.evaluate(el=>{
        const e=el as HTMLElement,input=e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement
        return{tag:e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')??(e instanceof HTMLInputElement?e.labels?.[0]?.innerText:null)??e.innerText??'').trim().slice(0,160),
          value:input&&!(e instanceof HTMLInputElement&&e.type==='password')?e.value.slice(0,300):undefined,
          checked:e instanceof HTMLInputElement?e.checked:e.hasAttribute('aria-checked')?e.getAttribute('aria-checked')==='true':undefined,
          disabled:input||e instanceof HTMLButtonElement?e.disabled:undefined,options:e instanceof HTMLSelectElement?[...e.options].map(o=>o.label):undefined}
      })
      controls.push({ref:this.controls.length,...item});this.controls.push(element)
    }
    if(this.chooser){controls.push({ref:this.controls.length,label:'文件选择对话框',tag:'input'});this.controls.push(this.chooser);this.chooser=undefined}
    this.observation=randomUUID();mkdirSync(this.folder,{recursive:true})
    const bytes=await this.page.screenshot({fullPage:false});writeFileSync(join(this.folder,this.observation+'.png'),bytes)
    const view:UserView={id:this.observation,kind:this.kind,text:(await this.page.locator('body').innerText()).slice(0,16000),controls,
      files:this.files.map(({id,name,description})=>({id,name,description})),downloads:this.downloads.map(row=>({...row})),image:[savePastedImage(this.session,bytes.toString('base64'),'png')],audio:{status:'not_measured',limit:'截图和DOM不能证明实际音频，请勿声称已听到声音'}}
    writeFileSync(join(this.folder,this.observation+'.json'),JSON.stringify(view));return view
  }
  async act(action:UserAction){
    if(action.observation!==this.observation)throw Error('SIMULATED_USER_STALE_OBSERVATION')
    if(action.action==='wait'){
      if(!Number.isInteger(action.milliseconds)||action.milliseconds!<0||action.milliseconds!>3000)throw Error('SIMULATED_USER_WAIT_INVALID')
      await this.page.waitForTimeout(action.milliseconds!);return
    }
    const element=Number.isInteger(action.ref)?this.controls[action.ref!]:undefined
    if(!element||action.action!=='upload'&&!await element.isVisible())throw Error('SIMULATED_USER_CONTROL_MISSING')
    if(action.action==='upload'){
      if(!action.files?.length||action.files.length>this.files.length)throw Error('USER_TEST_FILES_INVALID')
      const paths=action.files.map(id=>{const file=this.files.find(f=>f.id===id);if(!file||createHash('sha256').update(readFileSync(file.path)).digest('hex')!==file.sha256)throw Error('USER_TEST_FILE_CHANGED_OR_OUTSIDE');return file.path})
      await element.setInputFiles(paths,{timeout:5000})
    }else if(action.action==='click')await element.click({timeout:5000})
    else if(action.action==='fill'||action.action==='select'){
      if(typeof action.value!=='string'||action.value.length>2000)throw Error('SIMULATED_USER_VALUE_INVALID')
      if(action.action==='fill')await element.fill(action.value,{timeout:5000});else await element.selectOption({label:action.value},{timeout:5000})
    }else if(action.action==='draw'){
      const points=action.points,box=await element.boundingBox()
      if(await element.evaluate(el=>(el as Element).tagName)!=='CANVAS'||!box||!points||points.length<2||points.length>50
        ||points.some(p=>![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||p.delay!==undefined&&(!Number.isInteger(p.delay)||p.delay<0||p.delay>500)))throw Error('SIMULATED_USER_DRAW_INVALID')
      await this.page.mouse.move(box.x+points[0].x*box.width,box.y+points[0].y*box.height);await this.page.mouse.down()
      try{for(const p of points.slice(1)){if(p.delay)await this.page.waitForTimeout(p.delay);await this.page.mouse.move(box.x+p.x*box.width,box.y+p.y*box.height)}}finally{await this.page.mouse.up()}
    }else throw Error('SIMULATED_USER_UI_ACTION_REFUSED')
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
    if(this.preview===url&&this.surface)return
    const target=new URL(url)
    if(!['http:','https:'].includes(target.protocol)||!['localhost','127.0.0.1','[::1]'].includes(target.hostname))throw Error('SIMULATED_USER_PREVIEW_NOT_LOCAL')
    await this.close();this.release=undefined;this.preview=url
    this.browser=await chromium.launchPersistentContext(join(this.folder,'preview-profile'),{headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
    const page=this.browser.pages()[0]??await this.browser.newPage();await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000})
    this.surface=new UserPage(page,'preview',join(this.folder,'observations'),this.session,this.files)
  }
  async openApp(restart=false){
    if(this.surface?.kind==='app'&&!restart)return
    await this.close();this.preview=undefined
    if(!restart||!this.release)this.release=await prepareSoftwareRelease(this.projectId,findProject(this.projectId).root_path)
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
    const view=await this.surface?.snapshot()
    if(view)writeFileSync(join(this.folder,'observations',view.id+'.json'),JSON.stringify({...view,host:{candidate:this.release?.id,source:this.release?.source.digest,preview:this.preview}}))
    return view
  }
  async assertFeedbackSource(){
    if(this.surface?.kind!=='app'||!this.release)throw Error('SIMULATED_USER_APP_REQUIRED')
    await verifyReleaseSource(this.release)
  }
  async act(action:UserAction){
    if(action.action==='reopen'){
      if(this.surface?.kind!=='app')throw Error('SIMULATED_USER_REOPEN_REQUIRES_APP')
      await this.openApp(true)
    }else if(this.surface)await this.surface.act(action)
    else throw Error('SIMULATED_USER_VIEW_REQUIRED')
  }
}
