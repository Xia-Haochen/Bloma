import { _electron, expect, type ElectronApplication, type Route } from '@playwright/test'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { findProject } from '../main/project/project-service'
import { prepareSoftwareRelease, verifyReleaseSource } from '../main/software/release-store'
import { softwareDataDirectory } from '../main/software/data-update'
import { softwareEnvironment } from '../main/software/command-runtime'
import { electronEntry } from '../main/software/electron-entry'

/** Fault injection uses copies of the synthetic acceptance data, not user data.
 * Delays actual responses; never fabricates product response bodies. */
export async function inspectDoodleFaults(projectId:string,folder:string){
  const id=randomUUID(),root=join(folder,'faults-'+id);mkdirSync(root,{recursive:true})
  const release=await prepareSoftwareRelease(projectId,findProject(projectId).root_path)
  const original=readFileSync(join(softwareDataDirectory(projectId),'studio-data.json'))
  const seed=JSON.parse(original.toString()),dataDir=join(root,'data');mkdirSync(dataDir)
  writeFileSync(join(dataDir,'studio-data.json'),original)
  const report:any={status:'running',source:release.source.digest,scope:'isolated copy, real Electron UI response races and real backend corrupt-file rejection',checks:[]}
  let app:ElectronApplication|undefined
  try{
    expect(seed.artworks.length).toBeGreaterThanOrEqual(2)
    const entry=electronEntry(release.root,release.launch.command)
    app=await _electron.launch({...entry,args:[...entry.args,`--user-data-dir=${join(root,'profile')}`],cwd:release.root,env:softwareEnvironment(projectId,dataDir,release.root),timeout:30000})
    const page=await app.firstWindow();page.setDefaultTimeout(10000)
    const read=()=>JSON.parse(readFileSync(join(dataDir,'studio-data.json'),'utf8'))
    const [a,b]=seed.artworks
    await page.locator('#art-list button').filter({hasText:a.name}).click();await expect(page.locator('#artwork-name')).toHaveValue(a.name)
    let releaseResponse!:()=>void,arrived!:()=>void
    const hold=new Promise<void>(done=>{releaseResponse=done}),reached=new Promise<void>(done=>{arrived=done})
    const handler=async(route:Route)=>{if(route.request().method()!=='PUT'){await route.continue();return}const response=await route.fetch();arrived();await hold;await route.fulfill({response})}
    await page.route('**/api/artworks/*',handler)
    try{
      await page.locator('#save-btn').click();await Promise.race([reached,new Promise((_,reject)=>setTimeout(()=>reject(Error('SAVE_NOT_OBSERVED')),10000))])
      const editable=await page.locator('#artwork-name').isEnabled(),name=a.name+'-编辑后'
      if(editable)await page.locator('#artwork-name').fill(name)
      releaseResponse();await expect(page.locator('#save-btn')).toBeEnabled()
      if(editable){await expect(page.locator('#artwork-name')).toHaveValue(name);await expect(page.locator('#save-state')).toContainText('未保存');expect(read().artworks.find((x:any)=>x.id===a.id).name).toBe(a.name)}
      report.checks.push('保存响应延迟时，后续标题编辑保持未保存状态（或编辑被明确禁用），不会误标已保存')
    }finally{releaseResponse();await page.unroute('**/api/artworks/*',handler)}
    const save=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/api/artworks/'));await page.locator('#save-btn').click();await save
    const current=read().artworks.find((x:any)=>x.id===a.id),beforeB=read().artworks.find((x:any)=>x.id===b.id)
    let releaseSecond!:()=>void,reachedSecond!:()=>void
    const waitSecond=new Promise<void>(done=>{releaseSecond=done}),secondArrived=new Promise<void>(done=>{reachedSecond=done})
    const second=async(route:Route)=>{if(route.request().method()!=='PUT'){await route.continue();return}const response=await route.fetch();reachedSecond();await waitSecond;await route.fulfill({response})}
    await page.route('**/api/artworks/*',second)
    try{
      await page.locator('#save-btn').click();await Promise.race([secondArrived,new Promise((_,reject)=>setTimeout(()=>reject(Error('SAVE_NOT_OBSERVED')),10000))])
      await page.locator('#art-list button').filter({hasText:b.name}).click();await expect(page.locator('#artwork-name')).toHaveValue(b.name)
      releaseSecond();await expect(page.locator('#save-btn')).toBeEnabled();await expect(page.locator('#artwork-name')).toHaveValue(b.name)
      expect(read().artworks.find((x:any)=>x.id===a.id).strokes).toEqual(current.strokes)
      expect(read().artworks.find((x:any)=>x.id===b.id)).toEqual(beforeB)
      report.checks.push('A保存响应晚于切换到B时，不把A的身份或内容写回当前B')
    }finally{releaseSecond();await page.unroute('**/api/artworks/*',second)}
    await page.screenshot({path:join(root,'race.png'),fullPage:true});await app.close();app=undefined
    const require=createRequire(import.meta.url),modulePath=join(release.root,'server.js')
    const invalidRule = structuredClone(seed); invalidRule.rules[0].noteSpeed.slow = 'unrecognized-note'
    for(const [name,bytes]of [['invalid-json',Buffer.from('{broken')],['invalid-record',Buffer.from(JSON.stringify({...seed,artworks:[{...seed.artworks[0],strokes:'broken'},...seed.artworks.slice(1)]}))],['invalid-rule-enum',Buffer.from(JSON.stringify(invalidRule))]] as const){
      const dir=join(root,name);mkdirSync(dir);const file=join(dir,'studio-data.json');writeFileSync(file,bytes)
      delete require.cache[require.resolve(modulePath)]
      const {server,port}=await require(modulePath).startServer({port:0,dataDir:dir,quiet:true})
      try{
        const response=await fetch(`http://127.0.0.1:${port}/api/state`),body=await response.json()
        // Partial readable data may open explicitly read-only; HTTP 200 alone is
        // neither success nor failure. Require the warning and blocked writes.
        if(response.status===200)expect(body.loadWarning).toMatch(/只读/)
        else{expect(response.status).toBe(503);expect(body.loadFailed).toBe(true)}
        expect((await fetch(`http://127.0.0.1:${port}/api/rules`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(409)
        expect(readFileSync(file).equals(bytes)).toBe(true)
      }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
      if(name==='invalid-rule-enum'){
        app=await _electron.launch({...entry,args:[...entry.args,`--user-data-dir=${join(root,'fault-profile')}`],cwd:release.root,env:softwareEnvironment(projectId,dir,release.root),timeout:30000})
        const faultPage=await app.firstWindow();faultPage.setDefaultTimeout(10000)
        await expect(faultPage.getByText('只读保护',{exact:true})).toBeVisible()
        await expect(faultPage.locator('#save-btn')).toBeDisabled()
        await faultPage.screenshot({path:join(root,'read-only.png'),fullPage:true})
        const layout=await faultPage.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,
          canvas:document.querySelector('#doodle-canvas')?.getBoundingClientRect().toJSON()}))
        report.read_only_layout=layout
        expect(layout.width).toBeLessThanOrEqual(layout.viewport+1)
        expect(layout.canvas?.right).toBeLessThanOrEqual(layout.viewport+1)
        await app.close();app=undefined;expect(readFileSync(file).equals(bytes)).toBe(true)
      }
      report.checks.push(name+': 明确报错或只读提示、拒绝写入，损坏原始字节保持不变')
    }
    expect(readFileSync(join(softwareDataDirectory(projectId),'studio-data.json')).equals(original)).toBe(true)
    await verifyReleaseSource(release);report.status='passed'
  }catch(error){report.status='failed';report.error=String(error)}
  finally{await app?.close().catch(()=>{});writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2))}
  return{status:report.status,checks:report.checks,error:report.error,report:join(root,'report.json')}
}
