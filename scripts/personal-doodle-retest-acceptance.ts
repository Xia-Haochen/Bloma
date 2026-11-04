import {_electron,expect,type ElectronApplication,type Page} from '@playwright/test'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {findProject} from '../main/project/project-service'
import {readLongtermState} from '../main/software/longterm-state'
import {prepareSoftwareRelease,readSoftwareCandidate,verifyReleaseSource} from '../main/software/release-store'
import {prepareDataUpdate} from '../main/software/data-update'
import {softwareEnvironment} from '../main/software/command-runtime'
import {electronEntry} from '../main/software/electron-entry'

/** Independent adapter for the second generated UI. Business oracles stay the
 * same; no generated acceptance helpers or simulated sound engine are used. */
export async function inspectRetestDoodle(projectId:string,folder:string,muteSelector?:string,baselineSnapshot?:string){
  mkdirSync(folder,{recursive:true});const prefix=join(folder,'actual-'+randomUUID())
  const state=readLongtermState(projectId),milestone=state?.milestones.find(m=>m.id===state.current_id)
  const release=milestone?.status==='awaiting_confirmation'&&milestone.candidate_id?await readSoftwareCandidate(projectId,milestone.candidate_id):await prepareSoftwareRelease(projectId,findProject(projectId).root_path)
  const report:any={status:'running',candidate:release.id,source:release.source.digest,scope:'real Electron, digital Web Audio, actual persistent app data, restart; no physical-speaker claim',checks:[],page_errors:[]}
  let app:ElectronApplication|undefined,page!:Page,dataDir=''
  const start=async()=>{
    const transaction=await prepareDataUpdate(projectId,release.root,createHash('sha256').update(release.source.digest).digest('hex'),undefined,release.id);dataDir=transaction.dataDir
    const entry=electronEntry(release.root,release.launch.command)
    app=await _electron.launch({...entry,args:[...entry.args,'--mute-audio',`--user-data-dir=${join(folder,'profile')}`],cwd:release.root,env:softwareEnvironment(projectId,dataDir,release.root),timeout:30000})
    await app.context().addInitScript(()=>{
      const audit:any={events:[],samples:0,sum:0,peak:0,contexts:[]};(window as any).__independentDoodleAudio=audit
      const taps=new WeakMap<AudioContext,ScriptProcessorNode>(),proto=AudioNode.prototype as any,connect=proto.connect,Original=window.AudioContext
      class Observed extends Original{
        constructor(options?:AudioContextOptions){super(options);audit.contexts.push(this);const tap=this.createScriptProcessor(1024,1,1),mute=this.createGain();mute.gain.value=0;connect.call(tap,mute);connect.call(mute,this.destination);taps.set(this,tap)
          tap.onaudioprocess=e=>{for(const v of e.inputBuffer.getChannelData(0)){audit.samples++;audit.sum+=v*v;audit.peak=Math.max(audit.peak,Math.abs(v))}}
          const create=this.createOscillator.bind(this);this.createOscillator=()=>{const node=create(),start=node.start.bind(node),stop=node.stop.bind(node);let event:any
            node.start=(when=0)=>{event={type:node.type,start:when,frequency:node.frequency.value};audit.events.push(event);start(when)};node.stop=(when=0)=>{if(event)event.stop=when;stop(when)};return node}
        }
      }
      proto.connect=function(...args:any[]){const tap=taps.get(this.context);if(tap&&args[0]===this.context.destination)connect.call(this,tap);return connect.apply(this,args)}
      window.AudioContext=Observed
    })
    page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.page_errors.push(e.message));await page.reload();await expect(page.locator('#doodle-canvas')).toBeVisible();transaction.commit()
  }
  const data=()=>JSON.parse(readFileSync(join(dataDir,'doodle-synth.json'),'utf8'))
  const resetAudio=()=>page.evaluate(()=>{const a=(window as any).__independentDoodleAudio;a.events=[];a.samples=0;a.sum=0;a.peak=0})
  const draw=async(color:string,offset:number,delay:number)=>{
    await page.locator(`.brush[data-color="${color}"]`).click();await page.locator('#doodle-canvas').scrollIntoViewIfNeeded()
    const box=await page.locator('#doodle-canvas').boundingBox();if(!box)throw Error('CANVAS_MISSING')
    await page.mouse.move(box.x+60,box.y+60+offset);await page.mouse.down()
    for(let i=1;i<=4;i++){if(delay)await page.waitForTimeout(delay);await page.mouse.move(box.x+60+i*15,box.y+60+offset+(i%2)*5)}
    await page.mouse.up()
  }
  const map=async(bpm:string,first:string,second:string)=>{
    for(const id of ['slow','mid','fast'])await page.locator('#bpm-'+id).selectOption(bpm)
    await page.locator('#timbre-6d8268').selectOption(first);await page.locator('#timbre-c58a5b').selectOption(second)
    const response=page.waitForResponse(r=>r.url().endsWith('/api/mapping')&&r.request().method()==='POST');await page.locator('#save-mapping').click();expect((await response).ok()).toBe(true)
  }
  const play=async(id:string,mode:string)=>{
    const row=page.locator(`.art-item[data-artwork-id="${id}"]`);await row.locator('.ap-rule-select').selectOption(mode);await resetAudio();await row.locator('.ap-play').click()
    await page.waitForTimeout(200)
    const wait=await page.evaluate(()=>{const a=(window as any).__independentDoodleAudio;return Math.max(0,...a.events.map((e:any)=>e.stop))-Math.max(0,...a.contexts.map((c:AudioContext)=>c.currentTime))})
    expect(wait).toBeLessThan(15);await page.waitForTimeout(Math.max(100,(wait+.2)*1000))
    const audio=await page.evaluate(()=>{const a=(window as any).__independentDoodleAudio;return{events:a.events,samples:a.samples,peak:a.peak,rms:Math.sqrt(a.sum/Math.max(a.samples,1))}})
    expect(audio.events.length).toBeGreaterThan(0);expect(audio.samples).toBeGreaterThan(1024);expect(audio.peak).toBeGreaterThan(.0001);expect(audio.rms).toBeGreaterThan(.00001);return audio
  }
  try{
    await start();report.data_dir=dataDir;const prior=data();report.prior_artworks=prior.artworks.length
    if(baselineSnapshot){const baseline=JSON.parse(readFileSync(baselineSnapshot,'utf8'));for(const art of baseline.artworks)expect(prior.artworks.find((a:any)=>a.id===art.id)).toMatchObject(art);for(const version of baseline.mappingVersions)expect(prior.mappingVersions.find((v:any)=>v.id===version.id)).toMatchObject(version);expect(prior.currentVersionId).toBe(baseline.currentVersionId);report.checks.push('增量版本启动前后对照基线快照：旧画、笔画、原版本引用和历史映射均保留')}
    await map('60','sine','sine');const oldVersion=data().mappingVersions.at(-1)
    if(muteSelector){const control=page.locator(muteSelector);await control.check();await expect(control).toBeChecked();await resetAudio()}
    await page.locator('#new-doodle').click();await draw('#6d8268',0,350);await draw('#c58a5b',80,0);await expect(page.locator('#stroke-list li')).toHaveCount(2)
    if(muteSelector){await page.waitForTimeout(400);const silent=await page.evaluate(()=>{const a=(window as any).__independentDoodleAudio;return{events:a.events.length,peak:a.peak}});expect(silent.peak).toBeLessThan(.00001);expect(silent.events).toBe(0);report.muted_drawing=silent;await page.locator(muteSelector).uncheck()}
    const save=page.waitForResponse(r=>r.url().endsWith('/api/artworks')&&r.request().method()==='POST');await page.locator('#save-artwork').click();expect((await save).ok()).toBe(true)
    const saved=data(),art=saved.artworks.at(-1);expect(art.strokes).toHaveLength(2);expect(art.mappingVersionId).toBe(oldVersion.id)
    const old=await play(art.id,'own');expect(new Set(old.events.map((e:any)=>e.type))).toEqual(new Set(['sine']))
    await map('200','square','sawtooth');const fresh=await play(art.id,'current')
    expect(new Set(fresh.events.map((e:any)=>e.type))).toEqual(new Set(['square','sawtooth']))
    const span=(a:any)=>Math.max(...a.events.map((e:any)=>e.stop))-Math.min(...a.events.map((e:any)=>e.start))
    expect(span(old)).toBeGreaterThan(span(fresh)*2)
    expect(data().artworks.find((a:any)=>a.id===art.id)).toEqual(art);expect(data().mappingVersions.find((v:any)=>v.id===oldVersion.id)).toEqual(oldVersion)
    for(const record of prior.artworks)expect(data().artworks.find((a:any)=>a.id===record.id)).toEqual(record)
    const again=await play(art.id,'own');expect(again.events.map((e:any)=>e.type)).toEqual(old.events.map((e:any)=>e.type))
    report.audio={old,current:fresh,old_again:again};report.artwork=art;report.checks.push('实际鼠标绘制、保存；同一画作旧/新规则的真实PCM非零且节奏/音色不同；原画与历史规则不变')
    await page.screenshot({path:prefix+'-wide.png',fullPage:true});await app!.close();app=undefined
    await start();expect(data().artworks.find((a:any)=>a.id===art.id)).toEqual(art);const reopened=await play(art.id,'own');expect(reopened.events.map((e:any)=>e.type)).toEqual(old.events.map((e:any)=>e.type))
    await app!.browserWindow(page).then(w=>w.evaluate(win=>win.setSize(920,800)));await page.screenshot({path:prefix+'-reopened.png',fullPage:true})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(report.page_errors).toEqual([])
    await verifyReleaseSource(release);report.checks.push('关闭整个Electron和后端，重开后持久记录与旧规则回放保留；窄窗口无横向溢出');report.status='passed';report.data_snapshot=prefix+'-data.json';writeFileSync(report.data_snapshot,JSON.stringify(data(),null,2))
  }catch(error){report.status='failed';report.error=String(error);if(page)await page.screenshot({path:prefix+'-failure.png',fullPage:true}).catch(()=>{})}
  finally{await app?.close().catch(()=>{});report.finished_at=new Date().toISOString();writeFileSync(prefix+'.json',JSON.stringify(report,null,2))}
  return{status:report.status,report:prefix+'.json',error:report.error,checks:report.checks,data_snapshot:report.data_snapshot}
}
