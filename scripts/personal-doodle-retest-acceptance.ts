import {_electron,expect,type ElectronApplication,type Page} from '@playwright/test'
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {findProject} from '../main/project/project-service'
import {readLongtermState} from '../main/software/longterm-state'
import {prepareSoftwareRelease,readSoftwareCandidate,verifyReleaseSource,runtimeInventory} from '../main/software/release-store'
import {prepareDataUpdate} from '../main/software/data-update'
import {softwareEnvironment} from '../main/software/command-runtime'
import {electronEntry} from '../main/software/electron-entry'
import {isolateNativeTestWindows} from '../main/software/native-window-isolation'

/** Independent adapter for the second generated UI. Business oracles stay the
 * same; no generated acceptance helpers or simulated sound engine are used. */
export async function inspectRetestDoodle(projectId:string,folder:string,muteSelector?:string,baselineSnapshot?:string){
  mkdirSync(folder,{recursive:true});const prefix=join(folder,'actual-'+randomUUID())
  const state=readLongtermState(projectId),milestone=state?.milestones.find(m=>m.id===state.current_id)
  const currentRoot=findProject(projectId).root_path,pending=milestone?.status==='awaiting_confirmation'&&milestone.candidate_id?await readSoftwareCandidate(projectId,milestone.candidate_id):undefined
  const release=pending&&pending.source.digest===(await runtimeInventory(currentRoot)).digest?pending:await prepareSoftwareRelease(projectId,currentRoot)
  const report:any={status:'running',candidate:release.id,source:release.source.digest,scope:'real Electron, digital Web Audio, actual persistent app data, restart; no physical-speaker claim',checks:[],page_errors:[]}
  let app:ElectronApplication|undefined,page!:Page,dataDir=''
  const start=async(override?:string)=>{
    const transaction=override?undefined:await prepareDataUpdate(projectId,release.root,createHash('sha256').update(release.source.digest).digest('hex'),undefined,release.id);dataDir=override??transaction!.dataDir
    const entry=electronEntry(release.root,release.launch.command)
    app=await _electron.launch({...entry,args:[...entry.args,'--mute-audio',`--user-data-dir=${override?prefix+'-fault-profile':join(folder,'profile')}`],cwd:release.root,env:softwareEnvironment(projectId,dataDir,release.root),timeout:30000})
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
    page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.page_errors.push(e.message));await expect(page.locator('#doodle-canvas')).toBeVisible();report.input_isolation=await isolateNativeTestWindows(app.process().pid!);await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('#doodle-canvas')).toBeVisible();transaction?.commit()
  }
  const data=()=>JSON.parse(readFileSync(join(dataDir,'doodle-synth.json'),'utf8'))
  const resetAudio=()=>page.evaluate(()=>{const a=(window as any).__independentDoodleAudio;a.events=[];a.samples=0;a.sum=0;a.peak=0})
  const draw=async(color:string,offset:number,delay:number)=>{
    await page.locator(`.brush[data-color="${color}"]`).click();await page.locator('#doodle-canvas').scrollIntoViewIfNeeded()
    const box=await page.locator('#doodle-canvas').boundingBox();if(!box)throw Error('CANVAS_MISSING')
    await page.evaluate(()=>{const w=window as any;w.__independentPointerEvents=[];if(!w.__independentPointerHook){w.__independentPointerHook=true;for(const type of ['pointerdown','pointerup','pointercancel'])document.addEventListener(type,e=>w.__independentPointerEvents.push({type,target:(e.target as Element)?.id,x:(e as PointerEvent).clientX,y:(e as PointerEvent).clientY}),true)}})
    await page.mouse.move(box.x+60,box.y+60+offset);await page.mouse.down()
    for(let i=1;i<=4;i++){if(delay)await page.waitForTimeout(delay);await page.mouse.move(box.x+60+i*15,box.y+60+offset+(i%2)*5)}
    await page.mouse.up()
    report.last_draw={color,box,events:await page.evaluate(()=>(window as any).__independentPointerEvents),strokes:await page.locator('#stroke-list li').count()}
    ;(report.draws??=[]).push(report.last_draw)
  }
  const map=async(bpms:string[],first:string,second:string)=>{
    const state=data(),v=state.mappingVersions.find((v:any)=>v.id===state.currentVersionId)
    if(v.tempoBands.every((b:any,i:number)=>String(b.bpm)===bpms[i])&&v.colorMap['#6d8268']===first&&v.colorMap['#c58a5b']===second)return
    for(const [i,id] of ['slow','mid','fast'].entries())await page.locator('#bpm-'+id).selectOption(bpms[i])
    await page.locator('#timbre-6d8268').selectOption(first);await page.locator('#timbre-c58a5b').selectOption(second)
    const response=page.waitForResponse(r=>r.url().endsWith('/api/mapping')&&r.request().method()==='POST');await page.locator('#save-mapping').click();const saved=await response;expect(saved.ok()).toBe(true);const payload=await saved.json();await expect(page.locator('body')).toContainText('当前版本 '+payload.state.currentVersionId)
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
    await map(['60','80','100'],'sine','sine');const oldVersion=data().mappingVersions.at(-1)
    if(muteSelector){const control=page.locator(muteSelector);await control.check();await expect(control).toBeChecked();await resetAudio()}
    await page.locator('#new-doodle').click();await draw('#6d8268',0,350);await draw('#c58a5b',80,0);await expect(page.locator('#stroke-list li')).toHaveCount(2)
    if(muteSelector){await page.waitForTimeout(400);const silent=await page.evaluate(()=>{const a=(window as any).__independentDoodleAudio;return{events:a.events.length,peak:a.peak}});expect(silent.peak).toBeLessThan(.00001);expect(silent.events).toBe(0);report.muted_drawing=silent;await page.locator(muteSelector).uncheck()}
    const save=page.waitForResponse(r=>r.url().endsWith('/api/artworks')&&r.request().method()==='POST');await page.locator('#save-artwork').click();expect((await save).ok()).toBe(true)
    const saved=data(),art=saved.artworks.at(-1);expect(art.strokes).toHaveLength(2);expect(art.mappingVersionId).toBe(oldVersion.id)
    const old=await play(art.id,'own');expect(new Set(old.events.map((e:any)=>e.type))).toEqual(new Set(['sine']))
    await map(['160','180','200'],'square','sawtooth');const fresh=await play(art.id,'current')
    expect(new Set(fresh.events.map((e:any)=>e.type))).toEqual(new Set(['square','sawtooth']))
    const span=(a:any)=>Math.max(...a.events.map((e:any)=>e.stop))-Math.min(...a.events.map((e:any)=>e.start))
    expect(span(old)).toBeGreaterThan(span(fresh)*1.5)
    expect(data().artworks.find((a:any)=>a.id===art.id)).toEqual(art);expect(data().mappingVersions.find((v:any)=>v.id===oldVersion.id)).toEqual(oldVersion)
    for(const record of prior.artworks)expect(data().artworks.find((a:any)=>a.id===record.id)).toEqual(record)
    const again=await play(art.id,'own');expect(again.events.map((e:any)=>e.type)).toEqual(old.events.map((e:any)=>e.type))
    report.audio={old,current:fresh,old_again:again};report.artwork=art;report.checks.push('实际鼠标绘制、保存；同一画作旧/新规则的真实PCM非零且节奏/音色不同；原画与历史规则不变')
    report.wide_viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));await page.screenshot({path:prefix+'-wide.png',fullPage:true});await app!.close();app=undefined
    await start();expect(data().artworks.find((a:any)=>a.id===art.id)).toEqual(art);const reopened=await play(art.id,'own');expect(reopened.events.map((e:any)=>e.type)).toEqual(old.events.map((e:any)=>e.type))
    await app!.browserWindow(page).then(w=>w.evaluate(win=>win.setSize(920,800)));report.narrow_viewport={requested:{width:920,height:800},actual:await page.evaluate(()=>({width:innerWidth,height:innerHeight}))};await page.screenshot({path:prefix+'-reopened.png',fullPage:true})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(report.page_errors).toEqual([])
    report.checks.push('关闭整个Electron和后端，重开后持久记录与旧规则回放保留；窄窗口无横向溢出')
    await map(['60','120','200'],'sine','sine');await page.locator('#new-doodle').click();await page.locator('.brush[data-color="#6d8268"]').click();await page.locator('#doodle-canvas').scrollIntoViewIfNeeded()
    const box=(await page.locator('#doodle-canvas').boundingBox())!;await page.mouse.move(box.x+50,box.y+50);await page.mouse.down()
    for(let i=1;i<=8;i++){if(i<=4)await page.waitForTimeout(350);await page.mouse.move(box.x+50+i*25,box.y+50+(i%2)*5)}await page.mouse.up()
    await expect(page.locator('#stroke-list li')).toHaveCount(1)
    const mixedSave=page.waitForResponse(r=>r.url().endsWith('/api/artworks')&&r.request().method()==='POST');await page.locator('#save-artwork').click();await mixedSave
    const mixed=data().artworks.at(-1),points=mixed.strokes[0].points
    const speeds=points.slice(1).map((p:any,i:number)=>Math.hypot(p.x-points[i].x,p.y-points[i].y)/Math.max(1,p.t-points[i].t)*1000)
    expect(Math.max(...speeds)/Math.min(...speeds)).toBeGreaterThan(3)
    const sound=await play(mixed.id,'own'),starts=[...new Set<number>(sound.events.map((e:any)=>e.start))].sort((a,b)=>a-b),intervals=starts.slice(1).map((t,i)=>t-starts[i])
    report.within_stroke={artwork:mixed,input_speeds:speeds,audio:sound,intervals,expected:'AC-005：同一笔的慢快段落应有可听节奏疏密变化'}
    expect(intervals.length).toBeGreaterThan(1);expect(Math.max(...intervals)/Math.min(...intervals)).toBeGreaterThan(1.5)
    report.checks.push('AC-005：同一笔慢速到快速的变化对应不同的实际音符间隔')
    const normal=data(),normalDir=dataDir;report.data_snapshot=prefix+'-data.json';writeFileSync(report.data_snapshot,JSON.stringify(normal,null,2))
    await app!.close();app=undefined
    const corrupt=structuredClone(normal),target=corrupt.artworks.find((a:any)=>a.mappingVersionId!==corrupt.currentVersionId)
    expect(target).toBeTruthy();corrupt.mappingVersions=corrupt.mappingVersions.filter((v:any)=>v.id!==target.mappingVersionId)
    const faultData=prefix+'-missing-rule-data';mkdirSync(faultData);writeFileSync(join(faultData,'doodle-synth.json'),JSON.stringify(corrupt,null,2))
    await start(faultData);await resetAudio()
    const row=page.locator(`.art-item[data-artwork-id="${target.id}"]`),own=row.locator('.ap-rule-select option[value="own"]')
    if(!await own.isDisabled()){await row.locator('.ap-rule-select').selectOption('own');if(!await row.locator('.ap-play').isDisabled())await row.locator('.ap-play').click()}
    await page.waitForTimeout(200)
    const unavailable=(await row.innerText())+' '+(await page.locator('#art-play-status').innerText())
    expect(unavailable).toMatch(/不可用|无法|缺失|不存在|不能/)
    expect(await page.evaluate(()=>(window as any).__independentDoodleAudio.events.length)).toBe(0)
    const alternative=await play(target.id,'current');expect(data().artworks.find((a:any)=>a.id===target.id)).toMatchObject(target)
    expect(JSON.parse(readFileSync(join(normalDir,'doodle-synth.json'),'utf8'))).toEqual(normal)
    report.missing_rule={requested:target.mappingVersionId,unavailable,alternative_audio:alternative,normal_data_unchanged:true}
    report.checks.push('AC-018：缺失旧规则明确不可用且不静默发声，手动选择当前规则可播放；原画引用及正常数据保留')
    // Exercise independently reported failure branches on disposable data only.
    // Collect every result so one failed oracle cannot hide the other findings.
    report.failure_branches=[]
    const fault=async(name:string,run:()=>Promise<unknown>)=>{try{report.failure_branches.push({name,status:'passed',evidence:await run()})}catch(error){report.failure_branches.push({name,status:'failed',error:String(error)})}}
    await fault('AC-006 音频不可用的提示不会被成功状态覆盖',async()=>{
      await page.reload();await expect(page.locator('#doodle-canvas')).toBeVisible()
      await page.evaluate(()=>{(window as any).AudioContext=undefined;(window as any).webkitAudioContext=undefined})
      const row=page.locator(`.art-item[data-artwork-id="${target.id}"]`);await row.locator('.ap-rule-select').selectOption('current');await row.locator('.ap-play').click();await page.waitForTimeout(1400)
      const text=await page.locator('#art-play-status').innerText();expect(text).toMatch(/不可用|无法|失败|不能/);return{text}
    })
    await app!.close();app=undefined
    const badTimbre=structuredClone(normal),badArt=badTimbre.artworks.find((a:any)=>a.strokes.length),badVersion=badTimbre.mappingVersions.find((v:any)=>v.id===badArt.mappingVersionId)
    badVersion.colorMap[badArt.strokes[0].color]='removed-test-timbre'
    const timbreData=prefix+'-missing-timbre-data';mkdirSync(timbreData);writeFileSync(join(timbreData,'doodle-synth.json'),JSON.stringify(badTimbre))
    await start(timbreData)
    await fault('AC-009 缺失音色不会静默替换成其它音色',async()=>{
      const row=page.locator(`.art-item[data-artwork-id="${badArt.id}"]`);await resetAudio();await row.locator('.ap-rule-select').selectOption('own');if(!await row.locator('.ap-play').isDisabled())await row.locator('.ap-play').click();await page.waitForTimeout(250)
      const text=(await row.innerText())+' '+await page.locator('#art-play-status').innerText(),events=await page.evaluate(()=>(window as any).__independentDoodleAudio.events)
      report.missing_timbre={text,events,requested:'removed-test-timbre'};expect(text).toMatch(/音色.*(不可用|缺失|不存在|无法)|不可用.*音色/);expect(events).toHaveLength(0);return report.missing_timbre
    })
    await fault('映射保存期间的编辑不会被响应无声覆盖',async()=>{
      const slow=page.locator('#bpm-slow'),fast=page.locator('#bpm-fast'),submitted=await slow.inputValue()==='80'?'100':'80',edited=await fast.inputValue()==='160'?'180':'160'
      await slow.selectOption(submitted)
      let release!:()=>void,seen!:()=>void;const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r)
      await page.route('**/api/mapping',async route=>{if(route.request().method()!=='POST')return route.continue();seen();await hold;await route.continue()})
      try{const response=page.waitForResponse(r=>r.url().endsWith('/api/mapping')&&r.request().method()==='POST');await page.locator('#save-mapping').click();await started;const editable=await fast.isEnabled();if(editable)await fast.selectOption(edited)
        release();const saved=await response;expect(saved.ok()).toBe(true);const payload=await saved.json();await expect(page.locator('body')).toContainText('当前版本 '+payload.state.currentVersionId);await expect(fast).toBeEnabled()
        expect(data().mappingVersions.find((v:any)=>v.id===payload.state.currentVersionId).tempoBands.find((b:any)=>b.key==='slow').bpm).toBe(Number(submitted));if(editable)await expect(fast).toHaveValue(edited)
        return{edited_while_pending:editable,submitted_slow:submitted,current_version:payload.state.currentVersionId}
      }finally{release();await page.unroute('**/api/mapping')}
    })
    await fault('保存请求期间新增笔画不会无声丢失',async()=>{
      await page.locator('#new-doodle').click();await draw('#6d8268',0,0);await expect(page.locator('#stroke-list li')).toHaveCount(1)
      let release!:()=>void,seen!:()=>void;const hold=new Promise<void>(r=>release=r),started=new Promise<void>(r=>seen=r),posts:any[]=[]
      await page.route('**/api/artworks',async route=>{if(route.request().method()!=='POST')return route.continue();posts.push(route.request().postDataJSON());seen();await hold;await route.continue()})
      try{const response=page.waitForResponse(r=>r.url().endsWith('/api/artworks')&&r.request().method()==='POST');await page.locator('#save-artwork').click();await started;if(await page.locator('.brush[data-color="#c58a5b"]').isEnabled())await draw('#c58a5b',80,0)
        const during=await page.locator('#stroke-list li').count();if(await page.locator('#save-artwork').isEnabled()){await page.locator('#save-artwork').click();await page.waitForTimeout(100)}release();expect((await response).ok()).toBe(true);await page.waitForTimeout(400)
        const remaining=await page.locator('#stroke-list li').count(),stored=data().artworks.at(-1).strokes.length
        report.save_race={during,remaining,stored,posts};expect(stored+remaining).toBeGreaterThanOrEqual(during)
        if(posts.length>1)expect(posts[1].strokes.some((s:any)=>JSON.stringify(s)===JSON.stringify(posts[0].strokes[0])),'保存中的同一笔不应被第二请求重复保存').toBe(false)
        return report.save_race
      }finally{release();await page.unroute('**/api/artworks')}
    })
    await fault('加载失败后绘制不会造成未处理页面异常',async()=>{
      const before=report.page_errors.length;await page.route('**/api/state',route=>route.fulfill({status:500,contentType:'application/json',body:'{"error":"independent injected load failure"}'}));await page.reload();await expect(page.locator('#doodle-canvas')).toBeVisible();const box=(await page.locator('#doodle-canvas').boundingBox())!;await page.mouse.move(box.x+40,box.y+40);await page.mouse.down();await page.mouse.move(box.x+80,box.y+60,{steps:3});await page.mouse.up();await page.waitForTimeout(200)
      const errors=report.page_errors.slice(before);expect(errors).toEqual([]);return{errors}
    })
    await app!.close();app=undefined
    const damagedDir=prefix+'-damaged-data',damaged='{"artworks":[{"id":"preserve-original"}],"broken":';mkdirSync(damagedDir);writeFileSync(join(damagedDir,'doodle-synth.json'),damaged)
    await start(damagedDir)
    await fault('损坏数据不被静默初始化覆盖',async()=>{
      await page.waitForTimeout(300)
      if(await page.locator('.brush[data-color="#6d8268"]').isEnabled()){await draw('#6d8268',0,0);if(await page.locator('#save-artwork').isEnabled()){const response=page.waitForResponse(r=>r.url().endsWith('/api/artworks')&&r.request().method()==='POST');await page.locator('#save-artwork').click();await response;await page.waitForTimeout(200)}}
      const preserved=readdirSync(damagedDir,{withFileTypes:true}).filter(f=>f.isFile()).some(f=>readFileSync(join(damagedDir,f.name),'utf8')===damaged),text=await page.locator('body').innerText()
      report.damaged_data={preserved,text};expect(preserved).toBe(true);expect(text).toMatch(/失败|损坏|恢复|无法|不可用/);return report.damaged_data
    })
    expect(JSON.parse(readFileSync(join(normalDir,'doodle-synth.json'),'utf8'))).toEqual(normal)
    expect(report.failure_branches.filter((r:any)=>r.status==='failed'),JSON.stringify(report.failure_branches)).toEqual([])
    await verifyReleaseSource(release);report.status='passed'
  }catch(error){report.status='failed';report.error=String(error);report.error_stack=error instanceof Error?error.stack:undefined;if(page)await page.screenshot({path:prefix+'-failure.png',fullPage:true}).catch(()=>{})}
  finally{await app?.close().catch(()=>{});report.finished_at=new Date().toISOString();writeFileSync(prefix+'.json',JSON.stringify(report,null,2))}
  return{status:report.status,report:prefix+'.json',error:report.error,checks:report.checks,data_snapshot:report.data_snapshot}
}
