import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../main/project/project-service'
import { activeSoftwareRelease, prepareSoftwareRelease, verifyReleaseSource } from '../main/software/release-store'
import { prepareDataUpdate } from '../main/software/data-update'
import { softwareEnvironment } from '../main/software/command-runtime'
import { electronEntry } from '../main/software/electron-entry'

/** Independent UI actions plus a tap on the real Web Audio destination. No app
 * exports, generated test helpers or replacement audio implementation are used. */
export async function inspectDoodle(projectId: string, folder: string) {
  mkdirSync(folder,{recursive:true})
  const project=findProject(projectId),published=await activeSoftwareRelease(projectId)
  const release=published??await prepareSoftwareRelease(projectId,project.root_path)
  if(release.launch.ui!=='electron')throw Error('INDEPENDENT_EXPECTED_DESKTOP')
  const artworkName='独立验收双色曲-'+randomUUID().slice(0,6)
  const prefix=join(folder,'doodle-'+randomUUID()),report:any={version:1,status:'running',release:release.id,
    delivery:published?'published':'unreleased_candidate',scope:'real Electron UI, digital audio, persistent user-data path; no physical speaker claim',checks:[],page_errors:[]}
  let app:ElectronApplication|undefined,page!:Page,dataDir=''
  const start=async()=>{
    const transaction=await prepareDataUpdate(projectId,release.root,createHash('sha256').update(release.source.digest).digest('hex'),undefined,release.id)
    dataDir=transaction.dataDir
    const entry=electronEntry(release.root,release.launch.command)
    app=await _electron.launch({...entry,args:[...entry.args,`--user-data-dir=${join(folder,'profile')}`],cwd:release.root,env:softwareEnvironment(projectId,dataDir,release.root),timeout:30000})
    await app.context().addInitScript(()=>{
      const groups:any[]=[];(window as any).__independentAudio=groups
      const taps=new WeakMap<AudioContext,{tap:ScriptProcessorNode}>(),proto=AudioNode.prototype as any,connect=proto.connect
      const Original=window.AudioContext
      class Observed extends Original {
        constructor(options?:AudioContextOptions){
          super(options)
          const group:any={events:[],samples:0,sum:0,peak:0};groups.push(group)
          const tap=this.createScriptProcessor(1024,1,1),mute=this.createGain();mute.gain.value=0
          connect.call(tap,mute);connect.call(mute,this.destination);taps.set(this,{tap})
          tap.onaudioprocess=e=>{const input=e.inputBuffer.getChannelData(0);for(const sample of input){group.samples++;group.sum+=sample*sample;group.peak=Math.max(group.peak,Math.abs(sample))}}
          const create=this.createOscillator.bind(this)
          this.createOscillator=()=>{const node=create(),start=node.start.bind(node),stop=node.stop.bind(node);let event:any
            node.start=(when=0)=>{event={type:node.type,frequency:node.frequency.value,start:when};group.events.push(event);start(when)}
            node.stop=(when=0)=>{if(event)event.stop=when;stop(when)};return node}
        }
      }
      proto.connect=function(...args:any[]){const tap=taps.get(this.context)?.tap;if(tap&&args[0]===this.context.destination)connect.call(this,tap);return connect.apply(this,args)}
      window.AudioContext=Observed
    })
    page=await app.firstWindow({timeout:20000});page.on('pageerror',e=>report.page_errors.push(e.message));page.setDefaultTimeout(10000)
    await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('#doodle-canvas')).toBeVisible()
    transaction.commit()
  }
  const data=()=>JSON.parse(readFileSync(join(dataDir,'studio-data.json'),'utf8'))
  const paint=async(color:number,offset:number)=>{
    await page.locator('#palette button').nth(color).click()
    const box=await page.locator('#doodle-canvas').boundingBox();if(!box)throw Error('CANVAS_MISSING')
    await page.mouse.move(box.x+60+offset,box.y+100);await page.mouse.down()
    for(let n=1;n<=5;n++){await page.waitForTimeout(50);await page.mouse.move(box.x+60+offset+n*15,box.y+100+n*6)}
    await page.mouse.up()
  }
  const map=async(rhythm:string,waves:string[])=>{
    await page.locator('#tab-rule').click()
    for(let i=0;i<3;i++)await page.locator('#speed-rows select').nth(i).selectOption({label:rhythm})
    for(let i=0;i<waves.length;i++)await page.locator('#color-rows select').nth(i).selectOption({label:waves[i]})
    const response=page.waitForResponse(r=>r.url().endsWith('/api/rules')&&r.request().method()==='POST')
    await page.locator('#save-rules').click();expect((await response).ok()).toBe(true)
    await page.locator('#tab-paint').click()
  }
  const play=async(ruleId:string)=>{
    await page.locator(`#rule-options label[data-id="${ruleId}"]`).click()
    const before=await page.evaluate(()=>(window as any).__independentAudio.length)
    await page.locator('#play-btn').click();await expect(page.locator('#stop-btn')).toBeVisible()
    await expect(page.locator('#stop-btn')).toBeHidden({timeout:25000})
    const result=await page.evaluate(index=>{const g=(window as any).__independentAudio[index];return g&&{...g,rms:Math.sqrt(g.sum/Math.max(g.samples,1))}},before)
    expect(result?.events.length).toBeGreaterThan(0);expect(result.samples).toBeGreaterThan(1024);expect(result.peak).toBeGreaterThan(.0001);expect(result.rms).toBeGreaterThan(.00001)
    return result
  }
  try{
    await start();report.data_dir=dataDir
    await expect(page.locator('#rule-options input:checked')).toHaveCount(1)
    report.default_rule = { expected: data().rules.at(-1).id, actual: await page.locator('#rule-options input:checked').inputValue() }
    expect(report.default_rule.actual).toBe(report.default_rule.expected)
    await page.locator('#new-artwork-btn').click();await paint(0,0);await paint(1,180)
    await page.locator('#artwork-name').fill(artworkName)
    const response=page.waitForResponse(r=>r.url().endsWith('/api/artworks')&&r.request().method()==='POST')
    await page.locator('#save-btn').click();expect((await response).ok()).toBe(true)
    await map('四分音符',['正弦波','正弦波','正弦波','正弦波'])
    const baseline=data(),oldRule=baseline.rules.at(-1),originalArt=baseline.artworks.find((a:any)=>a.name===artworkName)
    expect(originalArt.strokes).toHaveLength(2);expect(new Set(originalArt.strokes.map((s:any)=>s.color)).size).toBe(2)
    const slow=await play(oldRule.id)
    await map('十六分音符',['方波','锯齿波','三角波','正弦波'])
    const changed=data(),newRule=changed.rules.at(-1),fast=await play(newRule.id)
    const span=(g:any)=>Math.max(...g.events.map((e:any)=>e.stop))-Math.min(...g.events.map((e:any)=>e.start))
    expect(span(slow)).toBeGreaterThan(span(fast)*1.5)
    expect(new Set(slow.events.map((e:any)=>e.type))).toEqual(new Set(['sine']))
    expect(new Set(fast.events.map((e:any)=>e.type))).toEqual(new Set(['square','sawtooth']))
    expect(data().rules.find((r:any)=>r.id===oldRule.id)).toEqual(oldRule)
    expect(data().artworks.find((a:any)=>a.id===originalArt.id).strokes).toEqual(originalArt.strokes)
    const oldAgain=await play(oldRule.id);expect(oldAgain.events.map((e:any)=>e.type)).toEqual(slow.events.map((e:any)=>e.type))
    report.audio={slow,fast,old_again:oldAgain};report.checks.push('真实鼠标绘制不同颜色；播放产生非零PCM，UI映射改变节奏与实际振荡器音色，旧规则回放恢复原音色且不改画作/规则')
    await page.screenshot({path:prefix+'-playing-view.png',fullPage:true})
    await page.locator('#play-btn').click();await expect(page.locator('#stop-btn')).toBeVisible();await page.locator('#stop-btn').click();await expect(page.locator('#stop-btn')).toBeHidden()
    await app!.close();app=undefined
    await start();await page.locator('#art-list button').filter({hasText:artworkName}).click()
    expect(data().rules.find((r:any)=>r.id===oldRule.id)).toEqual(oldRule)
    expect(data().artworks.find((a:any)=>a.id===originalArt.id).strokes).toEqual(originalArt.strokes)
    const reopened=await play(oldRule.id);expect(reopened.events.map((e:any)=>e.type)).toEqual(slow.events.map((e:any)=>e.type))
    report.checks.push('停止播放后关闭整个Electron及后端，再启动保留绘画、历史版本并真实回放')
    await app!.browserWindow(page).then(w=>w.evaluate(win=>win.setSize(920,800)))
    await page.locator('#tab-rule').click();await page.screenshot({path:prefix+'-reopened-narrow.png',fullPage:true})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
    expect(report.page_errors).toEqual([]);await verifyReleaseSource(release);report.status='passed'
  }catch(error){report.status='failed';report.error=String(error);if(page!)await page.screenshot({path:prefix+'-failure.png',fullPage:true}).catch(()=>{})}
  finally{await app?.close().catch(()=>{});report.finished_at=new Date().toISOString();writeFileSync(prefix+'.json',JSON.stringify(report,null,2))}
  return{status:report.status,report:prefix+'.json',checks:report.checks,error:report.error}
}
