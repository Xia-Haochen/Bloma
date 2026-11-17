import {createServer as createPortProbe} from 'node:net'
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {it,expect} from 'vitest'
import {_electron as electron} from 'playwright'

it.skipIf(!process.env.SOFTWARE_CAMPUS_CLOSEOUT_REPLAY)('observes original and current campus journeys in isolated real Electron copies without rewriting original findings',async()=>{
 const trial=process.env.SOFTWARE_CAMPUS_CLOSEOUT_REPLAY!,id='6fbb5c8f-d81f-4103-98cf-9c11cf85c20e'
 const releases=join(trial,'home/software-releases',id),root=mkdtempSync(join(tmpdir(),'bloma-campus-closeout-'))
 const protectedPaths=[join(trial,'monetary-policy.json.state.json'),join(trial,'home/software-quality',id+'.json'),join(trial,'home/software-test-corrections',id,'state.json')]
 const hashes=()=>protectedPaths.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));const before=hashes()
 const evidence:any[]=[]
 // Fast entry exposed a real 30ms focus-steal defect, retained separately.
 const login=async(page:any,user:string)=>{await page.waitForSelector('#login-screen:not([hidden])');await page.waitForTimeout(60);await page.locator('#login-username').fill(user);await page.locator('#login-password').fill('Qinghe@2026');await page.locator('#login-submit').click();await page.waitForSelector('#app:not([hidden])',{timeout:15000});await expect.poll(()=>page.locator('#user-meta').textContent(),{timeout:15000}).toContain(user)}
 for(const [label,candidate] of [['reviewed','1189881a033dd57773911873e58cc4e090243693342b8a375178c7a22cc41c65'],['current','038798d509c8ce0cc4a32dcd826590ba14b9c6141a0563a5f0e9d5113a512f77']]){
  const release=JSON.parse(readFileSync(join(releases,candidate,'release.json'),'utf8'))
  const appRoot=join(root,label,'app'),data=join(root,label,'data'),profile=join(root,label,'profile');mkdirSync(data,{recursive:true})
  cpSync(join(releases,candidate,'app'),appRoot,{recursive:true})
  const executablePath=JSON.parse(readFileSync(join(appRoot,'LAUNCH.json'),'utf8')).command[0]
  const port=await new Promise<number>(resolve=>{const server=createPortProbe();server.listen(0,'127.0.0.1',()=>{const address=server.address() as {port:number};server.close(()=>resolve(address.port))})})
  const environment:NodeJS.ProcessEnv={...process.env,APP_DATA_DIR:data,QINGHE_PORT:String(port)};delete environment.ELECTRON_RUN_AS_NODE
  const launch=()=>electron.launch({executablePath,args:[join(appRoot,'main.cjs'),'--user-data-dir='+profile],cwd:appRoot,env:Object.fromEntries(Object.entries(environment).filter((entry):entry is [string,string]=>entry[1]!==undefined)),timeout:30000})
  let app=await launch();const row:any={label,candidate,source:release.source.digest,scope:'isolated copy; original quality ledger unchanged; login waits 60ms for the documented delayed focus; rapid-input failure retained separately',scenarios:[]};evidence.push(row)
  try{
   expect(await app.evaluate(({app})=>app.getPath('userData'))).toBe(profile)
   const page=await app.firstWindow();await page.waitForSelector('#login-submit');await login(page,'linlan')
   await page.locator('#nav-stats').click();await page.locator('#logout').click();await login(page,'zhouyu')
   const adminHidden=await page.locator('#view-stats').isHidden();row.scenarios.push({name:'same-window-admin-to-member-no-reload',passed:adminHidden})
   await page.screenshot({path:join(root,label,'role-switch.png')})
   await page.locator('#nav-records').click();await expect.poll(()=>page.locator('#record-rows').textContent(),{timeout:15000}).not.toContain('正在读取');const oldRecords=await page.locator('#view-records').textContent()
   await page.locator('#nav-notices').click();await expect.poll(()=>page.locator('#notice-list').textContent(),{timeout:15000}).not.toContain('正在读取');const oldNotices=await page.locator('#view-notices').textContent()
   await page.locator('#logout').click();await login(page,'chenyu')
   const hidden=await page.locator('#view-records').isHidden()&&await page.locator('#view-notices').isHidden()
   const oldPresent=(await page.locator('#view-records').textContent())===oldRecords&&(await page.locator('#view-notices').textContent())===oldNotices
   row.scenarios.push({name:'same-window-member-a-to-b-no-reload',passed:hidden&&!oldPresent,views_hidden:hidden,old_content_retained:oldPresent})
   await page.screenshot({path:join(root,label,'account-switch.png')})
   const secondWindow=app.waitForEvent('window');await page.locator('#new-window').click();const second=await secondWindow
   await second.waitForSelector('#login-submit');await login(second,'zhouyu')
   await page.reload();await second.reload();await expect.poll(()=>page.locator('#user-meta').textContent(),{timeout:15000}).toContain('chenyu');await expect.poll(()=>second.locator('#user-meta').textContent(),{timeout:15000}).toContain('zhouyu')
   row.scenarios.push({name:'normal-second-window-refresh-isolation',passed:true,first_url:page.url(),second_url:second.url()})
   await second.close();await page.locator('#logout').click();await login(page,'linlan');await page.locator('#nav-transfer').click()
   const saved=join(root,label,'members.csv')
   const download=app.evaluate(({session},path)=>new Promise<string>(resolve=>{session.defaultSession.once('will-download',(_event,item)=>{item.setSavePath(path);item.once('done',(_event,result)=>resolve(result))})}),saved)
   await page.locator('#export-type').selectOption('members');await page.locator('#export-submit').click();expect(await download).toBe('completed')
   const bytes=readFileSync(saved);row.scenarios.push({name:'actual-export-file',passed:bytes.length>3&&bytes.subarray(0,3).toString('hex')==='efbbbf',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
   if(label==='current'){
    await page.locator('#nav-members').click();await page.locator('#goto-import').click()
    await page.locator('#import-file').setInputFiles({name:'members.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,登录账号,初始密码\n隔离复验成员,replaymember,Replay@123\n重复,linlan,Replay@123\n')})
    await expect.poll(()=>page.locator('#import-file-name').textContent(),{timeout:15000}).toContain('members.csv')
    await page.locator('#import-submit').click();await expect.poll(()=>page.locator('#import-result').textContent(),{timeout:15000}).toContain('成功 1 行')
    expect(await page.locator('#import-result').textContent()).toContain('登录账号已存在')
    row.scenarios.push({name:'actual-csv-import-with-duplicate-rejection',passed:true})
    await page.locator('#nav-calendar').click();await page.locator('#open-event-form').click()
    const day=new Date().toISOString().slice(0,10),name='隔离末名额复验'
    await page.locator('#event-name').fill(name);await page.locator('#event-place').fill('隔离测试活动室')
    await page.locator('#event-start').fill(day+'T20:00');await page.locator('#event-end').fill(day+'T21:00');await page.locator('#event-capacity').fill('1')
    const created=page.waitForResponse(r=>r.url().endsWith('/api/events')&&r.request().method()==='POST');await page.locator('#event-submit').click();const eventId=(await (await created).json()).event.id
    await page.locator('#logout').click();await login(page,'chenyu')
    const opened=app.waitForEvent('window');await page.locator('#new-window').click();const other=await opened;await other.waitForSelector('#login-submit');await login(other,'zhouyu')
    for(const client of [page,other]){await client.locator('#refresh-calendar').click();await client.locator(`[data-date="${day}"]`).click();await client.locator(`[data-register="${eventId}"]`).waitFor()}
    const responses=[page.waitForResponse(r=>r.url().endsWith(`/api/events/${eventId}/register`)),other.waitForResponse(r=>r.url().endsWith(`/api/events/${eventId}/register`))]
    await Promise.all([page.locator(`[data-register="${eventId}"]`).click(),other.locator(`[data-register="${eventId}"]`).click()])
    const statuses=await Promise.all(responses.map(async p=>(await p).status()));expect([...statuses].sort()).toEqual([200,409])
    const winner=statuses[0]===200?page:other
    await winner.locator(`[data-cancel="${eventId}"]`).click();await winner.locator('#confirm-cancel').click()
    expect(await winner.locator(`[data-cancel="${eventId}"]`).isVisible()).toBe(true)
    await winner.locator(`[data-cancel="${eventId}"]`).click();await winner.locator('#confirm-ok').click()
    for(const client of [page,other]){await client.locator('#refresh-calendar').click();await expect.poll(()=>client.locator(`[data-event-card="${eventId}"]`).textContent(),{timeout:15000}).toContain('剩余 1 个名额')}
    row.scenarios.push({name:'two-real-windows-last-place-race-cancel-and-refresh',passed:true,statuses})
    await other.close();await page.locator('#logout').click();await login(page,'linlan');await page.locator('#nav-transfer').click()
    const cancelled=app.evaluate(({session})=>new Promise<string>(resolve=>{session.defaultSession.once('will-download',(_event,item)=>{item.once('done',(_event,result)=>resolve(result));item.cancel()})}))
    await page.locator('#export-type').selectOption('members');await page.locator('#export-submit').click();expect(await cancelled).toBe('cancelled')
    row.scenarios.push({name:'injected-download-cancellation',execution:'cancelled',product_message:await page.locator('#toast').textContent(),verification:'not_a_successful_save'})
    await page.screenshot({path:join(root,label,'download-cancelled.png')})
   }
   await app.close();app=await launch();const reopened=await app.firstWindow();await expect.poll(()=>reopened.locator('#user-meta').textContent(),{timeout:15000}).toContain('linlan');row.scenarios.push({name:'full-stop-reopen-persisted-account',passed:true})
  }catch(error){row.error=String(error);const failed=app.windows()[0];if(failed){row.ui=await failed.locator('body').innerText().catch(()=>null);await failed.screenshot({path:join(root,label,'failure.png')}).catch(()=>{})}throw error}finally{await app.close().catch(()=>{});writeFileSync(join(root,'evidence.json'),JSON.stringify(evidence,null,2))}
 }
 expect(evidence[0].scenarios.find((s:any)=>s.name==='same-window-admin-to-member-no-reload').passed).toBe(false)
 expect(evidence[1].scenarios.find((s:any)=>s.name==='same-window-admin-to-member-no-reload').passed).toBe(true)
 expect(hashes()).toEqual(before)
 const archive=join(process.cwd(),'run-artifacts','campus-closeout-'+Date.now());cpSync(root,archive,{recursive:true})
 console.info(JSON.stringify({evidence:join(archive,'evidence.json'),original_hashes_unchanged:true,paid_requests:0,product_delivered:false}))
},180000)
