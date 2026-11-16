import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync,existsSync,cpSync,readdirSync} from 'node:fs'
import {resolve,join,relative} from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import http from 'node:http'
import {_electron as electron,expect} from '@playwright/test'
import {startService} from '../benchmarks/software-v0.1/tools/controlled-service.mjs'
import {equipmentFacts,documentFacts} from '../benchmarks/software-v0.1/tools/oracles.mjs'

const require=createRequire(import.meta.url)
const out=resolve(process.argv[2]),mode=process.argv[3]||'equipment'
assert.ok(!existsSync(out),'Use a fresh evidence directory')
mkdirSync(out,{recursive:true})
const source=resolve('tests/fixtures/benchmark-reference'),appRoot=join(out,'app')
cpSync(source,appRoot,{recursive:true})
const inputs=resolve('benchmarks/software-v0.1/inputs')
const evidence={mode,started_at:new Date().toISOString(),checks:[],scope:'Actual Electron UI, local controlled service, process restart and exported artifacts. Live-provider semantics, physical microphone and human listening are separate.'}
let app,page,service
const check=(name,detail={})=>{evidence.checks.push({name,status:'passed',...detail});writeFileSync(join(out,'result.json'),JSON.stringify(evidence,null,2));console.log(name)}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function launch(profile='profile',appDirectory=appRoot,extraEnv={},extraArgs=[]){
  const env={...process.env,APP_DATA_DIR:join(out,profile),REFERENCE_MODE:mode.replace(/-(live|cancel|audio|replay)$/,''),...extraEnv}
  delete env.ELECTRON_RUN_AS_NODE
  app=await electron.launch({executablePath:require('electron'),args:[join(appDirectory,'main.cjs'),'--autoplay-policy=no-user-gesture-required',...extraArgs],cwd:appDirectory,env,timeout:30000})
  page=await app.firstWindow()
  page.setDefaultTimeout(20000)
  await page.locator('#status[data-ok=true]').waitFor()
}
async function shot(name){
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.show();window.focus();window.webContents.invalidate()})
  const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(out,name+'.png'),Buffer.from(png,'base64'))
}
async function click(id,ok=true){
  // Clear observation marker only; every business operation still uses its visible UI.
  await page.locator('#status').evaluate(node=>delete node.dataset.ok)
  await page.locator('#'+id).click()
  await page.locator('#status[data-ok="'+ok+'"]').waitFor()
}
async function fill(values){for(const [id,value]of Object.entries(values))await page.locator('#'+id).fill(String(value))}
async function table(id){
  return page.locator('#'+id+' table').evaluate(table=>{
    const rows=[...table.rows],headers=[...rows.shift().cells].map(c=>c.textContent)
    return rows.map(row=>Object.fromEntries([...row.cells].map((cell,i)=>[headers[i],cell.textContent])))
  })
}
async function exportFile(id,name){
  await page.locator('#status').evaluate(node=>delete node.dataset.export)
  await page.locator('#'+id).click()
  await page.locator('#status[data-export]').waitFor()
  const source=await page.locator('#status').getAttribute('data-export'),file=join(out,name)
  cpSync(source,file)
  assert.ok(readFileSync(file).length)
  return file
}
async function config(endpoint){
  await fill({endpoint:endpoint.base_url,model:endpoint.model,key:endpoint.test_key})
  await click('save-settings')
}
async function equipmentRun(){
  await launch()
  const importFiles=async(files,ok=true)=>{
    await page.locator('#files').setInputFiles(files)
    await click('preview',ok)
    if(ok)await click('commit')
  }
  await importFiles(['equipment.csv','members.csv'].map(file=>join(inputs,'equipment',file)))
  await fill({equipment:'E03',name:'便携示波器'});await click('rename')
  await fill({member:'M02',name:'陈雨校准'});await click('rename-member')
  assert.deepEqual(await table('members'),[{id:'M01',name:'林舟'},{id:'M02',name:'陈雨校准'}])
  await fill({member:'M02',name:'陈雨'});await click('rename-member')
  await fill({equipment:'E01',name:'重复相机',quantity:5});await click('add-equipment',false)
  assert.deepEqual((await table('inventory')).map(row=>row.name),['相机','三脚架','便携示波器'])
  check('B1_import_edit_duplicate_identity');await shot('equipment-import')
  async function operation(action,member,equipment,quantity,due='2026-11-20',ok=true){
    await fill({member,equipment,quantity,due});await click(action,ok)
  }
  await operation('borrow','M01','E01',2,'2026-11-15')
  await operation('borrow','M01','E02',1)
  await operation('borrow','M02','E01',1)
  await operation('borrow','M02','E03',1,'2026-11-15')
  await operation('return','M01','E01',1)
  const rows=await table('inventory'),facts={after_partial:Object.fromEntries(rows.map(row=>[row.id,{total:+row.total,outstanding:+row.outstanding,available:+row.available}]))}
  facts.overdue=(await table('overdue')).map(row=>row.member+':'+row.equipment+':'+(row.quantity-row.returned))
  await fill({'filter-member':'M01'});await page.locator('#filter').click()
  assert.deepEqual((await table('outstanding')).map(row=>[row.member,row.equipment,+row.outstanding]),[['M01','E01',1],['M01','E02',1]])
  await fill({'filter-member':'M02'});await page.locator('#filter').click()
  assert.deepEqual((await table('outstanding')).map(row=>[row.member,row.equipment,+row.outstanding]),[['M02','E01',1],['M02','E03',1]])
  check('B2_B3_cross_member_partial_return_overdue');await shot('equipment-partial')
  const before={inventory:await table('inventory'),loans:await table('loans')}
  for(const args of [['borrow','M02','E03',2],['return','M01','E02',2],['borrow','M01','E01',-1]]){
    await operation(...args,'2026-11-20',false)
    assert.deepEqual({inventory:await table('inventory'),loans:await table('loans')},before)
  }
  await operation('return','M02','E03',1)
  assert.deepEqual((await table('outstanding')).map(row=>[row.member,row.equipment,+row.outstanding]),[['M02','E01',1]],'member filter must refresh after a return')
  check('R1_each_rejection_atomic_then_valid_operation')
  const beforeInvalid=await table('inventory')
  await importFiles([join(inputs,'equipment/equipment-invalid.csv')],false)
  await expect(page.locator('#status')).toContainText('E01')
  await click('cancel');assert.deepEqual(await table('inventory'),beforeInvalid)
  await importFiles([join(inputs,'equipment/equipment-extra.csv')])
  const snapshot={inventory:await table('inventory'),members:await table('members'),loans:await table('loans')}
  check('R2_bad_import_cancel_retry');await shot('equipment-final')
  await app.close();await launch()
  assert.deepEqual({inventory:await table('inventory'),members:await table('members'),loans:await table('loans')},snapshot)
  facts.after_restart=Object.fromEntries((await table('inventory')).map(row=>[row.id,+row.available]))
  const backup=await exportFile('export','equipment-backup.csv')
  await app.close();await launch('empty-profile')
  await importFiles([backup])
  assert.deepEqual({inventory:await table('inventory'),members:await table('members'),loans:await table('loans')},snapshot)
  await operation('return','M02','E01',1)
  facts.after_import_and_return=Object.fromEntries((await table('inventory')).map(row=>[row.id,+row.available]))
  equipmentFacts(facts)
  writeFileSync(join(out,'equipment-facts.json'),JSON.stringify(facts,null,2))
  check('P1_P2_full_process_restart_export_restore_continue',{backup_sha256:hash(readFileSync(backup))})
  await app.close()
  const broken=join(out,'wrong-inventory-app');cpSync(appRoot,broken,{recursive:true})
  const file=join(broken,'equipment.cjs'),text=readFileSync(file,'utf8')
  assert.ok(text.includes('available:row.total-outstanding(state,row.id)'))
  writeFileSync(file,text.replace('available:row.total-outstanding(state,row.id)','available:row.total'))
  await launch('profile',broken)
  const observed=Object.fromEntries((await table('inventory')).map(row=>[row.id,+row.available]))
  assert.throws(()=>assert.deepEqual(observed,facts.after_restart))
  await shot('equipment-negative-control')
  check('negative_product_wrong_inventory_rejected',{observed})
}
function inputHash(directory){
  const rows=[]
  function visit(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory())visit(file);else rows.push([relative(directory,file).replaceAll('\\','/'),hash(readFileSync(file))])}}
  visit(directory);return hash(JSON.stringify(rows.sort((a,b)=>a[0].localeCompare(b[0]))))
}
async function documentsRun(){
  service=await startService(join(out,'service'))
  const control=(values)=>writeFileSync(join(out,'service/control.json'),JSON.stringify({auth_key:'benchmark-test-key',fail_next:0,delay_ms:0,...values}))
  const documentInputs=join(out,'document-inputs');mkdirSync(documentInputs)
  const expected=JSON.parse(readFileSync(join(inputs,'documents/facts.json'),'utf8'))
  for(const file of [...Object.keys(expected.files),'损坏.pdf','不支持编码.txt']){mkdirSync(join(documentInputs,file,'..'),{recursive:true});cpSync(join(inputs,'documents',file),join(documentInputs,file))}
  const before=inputHash(documentInputs)
  await launch();await config(service.endpoint)
  await page.locator('#files').setInputFiles(documentInputs)
  await click('import')
  const prefix='document-inputs/'
  const imported=await page.locator('#documents input').evaluateAll(nodes=>nodes.map(node=>node.value))
  assert.deepEqual(imported.map(name=>name.replace(prefix,'')).sort(),Object.keys(expected.files).sort())
  await expect(page.locator('#import-errors')).toContainText('损坏.pdf')
  await expect(page.locator('#import-errors')).toContainText('不支持编码.txt')
  await expect(page.locator('#import-errors')).toContainText('不支持的文本编码')
  await expect(page.locator('#import-errors')).toContainText('PDF文件损坏')
  assert.ok(!(await page.locator('#import-errors').innerText()).includes('Traceback'))
  await fill({query:'青禾'});await page.locator('#search').click()
  const search=await page.locator('#search-results li').evaluateAll(nodes=>nodes.map(node=>({...node.dataset})))
  for(let i=0;i<search.length;i++){await page.locator('#search-results button').nth(i).click();await expect(page.locator('#source')).toContainText(search[i].text)}
  // Read each imported document through its visible source view using a public text query.
  for(const [file,expectedDoc]of Object.entries(expected.files)){
    const lines=expectedDoc.lines||expectedDoc.pages.flat()
    await fill({query:lines[0]});await page.locator('#search').click()
    await page.locator('#search-results button').filter({hasText:prefix+file}).first().click()
    for(const line of lines)await expect(page.locator('#source')).toContainText(line)
  }
  await page.locator('#clear').click();assert.equal(await page.locator('#documents input').count(),6)
  check('B1_B2_all_formats_duplicate_names_exact_text_source_navigation');await shot('documents-import')
  const select=async(files)=>{
    // Checkboxes are selected by their public file identity.
    for(let i=0;i<imported.length;i++)await page.locator('#documents input').nth(i).setChecked(files.includes(imported[i].replace(prefix,'')))
  }
  await select(expected.selected)
  await click('queue')
  await expect(page.locator('article[data-state=completed]')).toHaveCount(3,{timeout:30000})
  const stable=await page.locator('#tasks').innerText()
  const requests=()=>readFileSync(join(out,'service/requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(requests().length,3)
  for(const request of requests())assert.ok(expected.selected.some(name=>request.messages.at(-1).content.startsWith(prefix+name+'\n')))
  control({delay_ms:5000})
  await click('queue');await expect(page.locator('article[data-id=T4]')).toHaveAttribute('data-state','running')
  await page.locator('article[data-id=T6] button[data-action=cancel]').click()
  await expect(page.locator('article[data-id=T6]')).toHaveAttribute('data-state','cancelled')
  await fill({query:'青禾'});await page.locator('#search').click();assert.equal(await page.locator('#search-results li').count(),3)
  await expect(page.locator('article[data-id=T5]')).toHaveAttribute('data-state','completed',{timeout:20000})
  assert.equal(requests().length,5)
  check('R1_corrupt_files_isolated_queue_cancel_no_request_UI_responsive')
  control({fail_next:1})
  await select([expected.selected[0]]);await click('queue')
  await expect(page.locator('article[data-id=T7]')).toHaveAttribute('data-state','failed')
  await expect(page.locator('article[data-id=T7]')).toContainText('503')
  await page.locator('article[data-id=T7] button[data-action=retry]').click()
  await expect(page.locator('article[data-id=T7]')).toHaveAttribute('data-state','completed')
  assert.equal((await page.locator('#tasks').innerText()).slice(0,stable.length),stable)
  await select(expected.selected);await click('aggregate')
  await expect(page.locator('article[data-id=T8]')).toHaveAttribute('data-state','completed')
  const last=requests().at(-1).messages.at(-1).content
  for(const file of expected.selected)assert.ok(last.includes(prefix+file))
  assert.ok(!last.includes('3000'))
  check('B3_controlled_payload_selection_summary_and_aggregate_R2_retry_preserves_results')
  await shot('documents-completed')
  const persisted=await page.locator('#tasks').innerText()
  await app.close();await launch()
  assert.equal(await page.locator('#tasks').innerText(),persisted)
  await expect(page.locator('#endpoint')).toHaveValue(service.endpoint.base_url)
  // Prove persisted credentials are usable without re-entering settings.
  await select([expected.selected[0]]);await click('queue')
  await expect(page.locator('article[data-id=T9]')).toHaveAttribute('data-state','completed')
  const markdown=await exportFile('export-md','results.md'),csv=await exportFile('export-csv','results.csv')
  const exported=readFileSync(markdown,'utf8')
  const facts={imported_files:imported.map(name=>name.replace(prefix,'')),search_results:search.map(row=>({...row,file:row.file.replace(prefix,'')})),selected_files:expected.selected,
    original_input_sha256_before:before,original_input_sha256_after:inputHash(documentInputs),exported_text:exported}
  documentFacts(facts,expected)
  assert.ok(exported.includes('cancelled'))
  assert.ok(readFileSync(csv,'utf8').includes('cancelled'))
  writeFileSync(join(out,'document-facts.json'),JSON.stringify(facts,null,2))
  check('P1_P2_restart_configuration_resume_exports_input_unchanged')
  await app.close()
  const broken=join(out,'wrong-source-app');cpSync(appRoot,broken,{recursive:true})
  const file=join(broken,'documents-renderer.js'),text=readFileSync(file,'utf8')
  assert.ok(text.includes('location:line.location'))
  writeFileSync(file,text.replace('location:line.location','location:"page:99"'))
  await launch('profile',broken)
  await fill({query:'青禾'});await page.locator('#search').click()
  const wrong=await page.locator('#search-results li').evaluateAll(nodes=>nodes.map(node=>({...node.dataset})))
  assert.throws(()=>documentFacts({...facts,search_results:wrong.map(row=>({...row,file:row.file.replace(prefix,'')}))},expected))
  await shot('documents-negative-control')
  check('negative_product_wrong_source_location_rejected')
}
async function voiceRun(){
  for(const name of ['REFERENCE_VOICE_PYTHON','REFERENCE_SPEECH_TOOLS','BLOMA_SPEECH_MODEL_DIR'])assert.ok(process.env[name],'Missing '+name)
  service=await startService(join(out,'service'))
  const control=values=>writeFileSync(join(out,'service/control.json'),JSON.stringify({auth_key:'benchmark-test-key',fail_next:0,delay_ms:0,...values}))
  const requests=()=>existsSync(join(out,'service/requests.jsonl'))?readFileSync(join(out,'service/requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
  async function observe(){
    await page.evaluate(()=>{
      window.externalPlayback=[]
      window.externalPCM=[]
      const audio=document.querySelector('audio')
      // Observe rendered samples through the browser audio graph. This records
      // digital playback, not a claim about the physical speaker or listener.
      const context=new AudioContext(),source=context.createMediaElementSource(audio),processor=context.createScriptProcessor(4096,1,1)
      source.connect(processor);processor.connect(context.destination)
      processor.onaudioprocess=event=>{
        const samples=event.inputBuffer.getChannelData(0)
        event.outputBuffer.getChannelData(0).set(samples)
        const current=window.externalPCM.at(-1)
        if(current&&!audio.paused)for(const value of samples)current.samples.push(Math.round(Math.max(-1,Math.min(1,value))*32767))
      }
      audio.addEventListener('play',()=>{
        void context.resume()
        window.externalPCM.push({rate:context.sampleRate,samples:[]})
        window.externalPlayback.push({event:'play',at:Date.now(),time:audio.currentTime,duration:audio.duration})
      })
      audio.addEventListener('ended',()=>window.externalPlayback.push({event:'ended',at:Date.now(),time:audio.currentTime,duration:audio.duration,muted:audio.muted,volume:audio.volume,rate:audio.playbackRate}))
    })
  }
  const file=async(name)=>{await page.locator('#files').setInputFiles(join(inputs,'voice',name));await page.locator('#import').click()}
  async function complete(count){
    await expect(page.locator('#history article[data-role=assistant]')).toHaveCount(count,{timeout:120000})
    await expect.poll(()=>page.evaluate(()=>window.externalPlayback.filter(row=>row.event==='ended').length),{timeout:180000}).toBe(count)
  }
  await launch();await config(service.endpoint);await observe()
  await file('silence.wav')
  await expect(page.locator('#phase')).toHaveText('没有检测到语音',{timeout:120000})
  assert.equal(requests().length,0);assert.equal(await page.locator('#history article').count(),0)
  check('R1_silent_WAV_no_text_no_request')
  await file('01-name.wav')
  await expect(page.locator('#phase')).toHaveText('播放中',{timeout:120000})
  // Queue another real voice input while the first response is still playing.
  await file('02-budget.wav')
  await complete(2)
  await file('03-recall.wav');await complete(3)
  const initialRequests=requests()
  assert.equal(initialRequests.length,3)
  assert.deepEqual(initialRequests.map(row=>row.messages.map(message=>message.role)),
    [['system','user'],['system','user','assistant','user'],['system','user','assistant','user','assistant','user']])
  for(const keyword of ['语音助手','周五'])assert.ok(initialRequests[0].messages.at(-1).content.includes(keyword))
  assert.match(initialRequests[1].messages.at(-1).content,/(三百|300)/)
  assert.ok(initialRequests[1].messages.at(-1).content.includes('蓝色'))
  const playback=await page.evaluate(()=>window.externalPlayback)
  for(let i=0;i<3;i++){
    const start=playback[2*i],end=playback[2*i+1]
    assert.equal(start.event,'play');assert.equal(end.event,'ended')
    assert.ok(end.duration>1&&end.time>=end.duration-.15&&!end.muted&&end.volume>0&&end.rate===1)
    assert.ok((end.at-start.at)/1000>=end.duration-.5)
    if(i)assert.ok(start.at>=playback[2*i-1].at)
  }
  writeFileSync(join(out,'playback-observations.json'),JSON.stringify(playback,null,2))
  const pcm=await page.evaluate(()=>window.externalPCM)
  const decoded=[]
  for(const [index,record]of pcm.entries()){
    const end=playback[index*2+1],seconds=record.samples.length/record.rate
    assert.ok(seconds>=end.duration-.3,'rendered audio truncated')
    assert.ok(record.samples.some(value=>Math.abs(value)>500),'rendered audio silent')
    const bytes=Buffer.alloc(44+record.samples.length*2)
    bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16)
    bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(record.rate,24)
    bytes.writeUInt32LE(record.rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34)
    bytes.write('data',36);bytes.writeUInt32LE(record.samples.length*2,40)
    for(let i=0;i<record.samples.length;i++)bytes.writeInt16LE(record.samples[i],44+i*2)
    writeFileSync(join(out,'rendered-round-'+(index+1)+'.wav'),bytes)
    const observation=await require('../tests/fixtures/benchmark-reference/process.cjs')(process.env.REFERENCE_VOICE_PYTHON,
      join(appRoot,'voice.py'),{action:'asr',file:join(out,'rendered-round-'+(index+1)+'.wav')})
    decoded.push({round:index+1,text:observation.text})
  }
  assert.match(decoded[1].text,/(300|三百)/,'Actual rendered speech must include the budget')
  assert.ok(decoded[1].text.includes('蓝色'))
  writeFileSync(join(out,'decoded-rendered.json'),JSON.stringify(decoded,null,2))
  for(const name of readdirSync(join(out,'profile')).filter(name=>/^reply-.*\.wav$/.test(name)))cpSync(join(out,'profile',name),join(out,name))
  const history=await page.locator('#history').innerText()
  writeFileSync(join(out,'three-round-history.txt'),history)
  check('B1_standard_WAV_real_ASR_B2_request_history_B3_natural_media_end_no_overlap',{human_listening:'pending',physical_microphone:'user assured, not measured',live_recall:'separate live run'})
  if(mode==='voice-audio'){check('B3_browser_rendered_PCM_saved_full_duration_nonzero');return}
  await shot('voice-three-round')
  control({fail_next:1});await file('01-name.wav')
  await expect(page.locator('#status')).toContainText('503',{timeout:120000})
  assert.equal(await page.locator('#history').innerText(),history)
  control({auth_key:'changed-key'});await file('01-name.wav')
  await expect(page.locator('#status')).toContainText('401',{timeout:120000})
  assert.equal(await page.locator('#history').innerText(),history)
  await config({...service.endpoint,test_key:'changed-key'})
  await file('01-name.wav');await complete(4)
  check('R2_503_401_then_settings_repair_history_preserved')
  const before=await page.locator('#history').innerText()
  await app.close();await launch();await observe()
  assert.equal(await page.locator('#history').innerText(),before)
  await expect(page.locator('#endpoint')).toHaveValue(service.endpoint.base_url)
  await file('03-recall.wav')
  await expect(page.locator('#history article[data-role=assistant]')).toHaveCount(5,{timeout:120000})
  await expect.poll(()=>page.evaluate(()=>window.externalPlayback.filter(row=>row.event==='ended').length),{timeout:180000}).toBe(1)
  assert.equal(requests().at(-1).messages.length,10)
  check('P1_P2_full_process_restart_saved_credential_history_continue')
  await app.close()
  const broken=join(out,'truncated-audio-app');cpSync(appRoot,broken,{recursive:true})
  const target=join(broken,'voice-renderer.js'),text=readFileSync(target,'utf8')
  assert.ok(text.includes('audio.play().catch(reject)'))
  writeFileSync(target,text.replace('audio.play().catch(reject)',"audio.play().catch(reject);setTimeout(()=>{audio.pause();audio.dispatchEvent(new Event('ended'))},500)"))
  await launch('negative-profile',broken);await config({...service.endpoint,test_key:'changed-key'});await observe()
  await file('01-name.wav');await complete(1)
  const wrong=await page.evaluate(()=>window.externalPlayback.find(row=>row.event==='ended'))
  assert.throws(()=>assert.ok(wrong.time>=wrong.duration-.15))
  writeFileSync(join(out,'negative-playback.json'),JSON.stringify(wrong,null,2))
  await shot('voice-negative-control')
  check('negative_product_false_ended_truncation_rejected',{observed:wrong})
}
async function cancelRun(){
  service=await startService(join(out,'service'))
  await launch('profile',appRoot,{},['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
  await config(service.endpoint)
  await page.locator('#record').click();await expect(page.locator('#phase')).toHaveText('录音中')
  await page.locator('#cancel').click();await expect(page.locator('#phase')).toHaveText('已取消录音')
  assert.equal(await page.locator('#history article').count(),0)
  assert.ok(!existsSync(join(out,'service/requests.jsonl')))
  await shot('voice-cancel')
  check('R1_cancel_via_real_recording_UI_with_Chromium_synthetic_device_no_request',{physical_microphone:'user assured, not measured'})
}
async function liveRun(){
  let endpoint
  if(mode==='voice-replay'){
    assert.ok(process.env.REFERENCE_REPLAY_LOG,'Required original live provider response evidence')
    const bytes=readFileSync(process.env.REFERENCE_REPLAY_LOG)
    const rows=bytes.toString().trim().split('\n').map(JSON.parse).filter(row=>row.sequence>=5)
    assert.equal(rows.length,4)
    let count=0
    const server=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk
      const original=rows[count++]
      try{
        assert.deepEqual(JSON.parse(body).messages,original.request.messages)
        res.setHeader('content-type','application/json');res.end(JSON.stringify(original.response))
      }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}))}
    })
    await new Promise(done=>server.listen(0,'127.0.0.1',done))
    service={server}
    endpoint={base_url:'http://127.0.0.1:'+server.address().port+'/v1',model:'deepseek-flash',test_key:'replay-test-key'}
    evidence.replay={source_sha256:hash(bytes),scope:'Replay original real-provider responses to verify repaired TTS; no new paid model calls'}
  }else{
    assert.ok(process.env.REFERENCE_LIVE_ENDPOINT,'Required evaluator relay endpoint file')
    endpoint=JSON.parse(readFileSync(process.env.REFERENCE_LIVE_ENDPOINT,'utf8'))
  }
  await launch();await config(endpoint)
  if(mode.startsWith('voice-')){
    await fill({role:'你是中文助手。请用简短的中文自然回答，保留用户要求的事实。'});await click('save-settings')
    const rounds=[]
    async function round(file,index){
      await page.locator('#files').setInputFiles(join(inputs,'voice',file));await page.locator('#import').click()
      await expect(page.locator('#history article[data-role=assistant]')).toHaveCount(index,{timeout:120000})
      await expect(page.locator('#phase')).toHaveText('本轮完成',{timeout:180000})
      const text=await page.locator('#history article[data-role=assistant]').last().innerText()
      rounds.push({file,text})
      await shot('voice-live-'+index)
    }
    for(const [i,file]of ['01-name.wav','02-budget.wav','03-recall.wav'].entries())await round(file,i+1)
    const recall=rounds[2].text
    for(const fact of ['语音助手','周五','蓝色'])assert.ok(recall.includes(fact),fact)
    assert.match(recall,/(300|三百)/)
    const before=await page.locator('#history').innerText()
    await app.close();await launch();assert.equal(await page.locator('#history').innerText(),before)
    await round('03-recall.wav',4)
    for(const fact of ['语音助手','周五','蓝色'])assert.ok(rounds[3].text.includes(fact),fact)
    assert.match(rounds[3].text,/(300|三百)/)
    for(const name of readdirSync(join(out,'profile')).filter(name=>/^reply-.*\.wav$/.test(name)))cpSync(join(out,'profile',name),join(out,name))
    if(mode==='voice-replay'){
      const decoded=[]
      for(const i of [2,3,4]){
        const observation=await require('../tests/fixtures/benchmark-reference/process.cjs')(process.env.REFERENCE_VOICE_PYTHON,
          join(appRoot,'voice.py'),{action:'asr',file:join(out,'reply-'+(i*2)+'.wav')})
        assert.match(observation.text,/(300|三百)/,'Synthesized live reply must speak the budget')
        assert.ok(observation.text.includes('蓝色'))
        decoded.push({round:i,text:observation.text})
      }
      writeFileSync(join(out,'decoded-replies.json'),JSON.stringify(decoded,null,2))
    }
    writeFileSync(join(out,'live-replies.json'),JSON.stringify(rounds,null,2))
    check(mode==='voice-replay'?'original_live_replies_replayed_repaired_TTS_numbers_and_restart':'live_deepseek_high_four_facts_three_rounds_restart_continue',{human_semantic_and_listening_review:'pending'})
  }else{
    const expected=JSON.parse(readFileSync(join(inputs,'documents/facts.json'),'utf8'))
    const dir=join(out,'documents');mkdirSync(dir)
    for(const file of Object.keys(expected.files)){mkdirSync(join(dir,file,'..'),{recursive:true});cpSync(join(inputs,'documents',file),join(dir,file))}
    await page.locator('#files').setInputFiles(dir);await click('import')
    const nodes=page.locator('#documents input'),names=await nodes.evaluateAll(nodes=>nodes.map(n=>n.value))
    for(let i=0;i<names.length;i++)await nodes.nth(i).setChecked(expected.selected.includes(names[i].replace('documents/','')))
    await click('queue');await expect(page.locator('article[data-state=completed]')).toHaveCount(3,{timeout:240000})
    await click('aggregate');await expect(page.locator('article[data-state=completed]')).toHaveCount(4,{timeout:120000})
    const text=await page.locator('article[data-id=T4] pre').innerText()
    for(const fact of ['林舟','300','蓝色','2026','11','20'])assert.ok(text.includes(fact),fact)
    assert.ok(!text.includes('3000'))
    for(const name of ['项目纪要.txt','预算.md','交付.pdf'])assert.ok(text.includes(name),name)
    await exportFile('export-md','live-results.md');await exportFile('export-csv','live-results.csv')
    await shot('documents-live')
    check('live_deepseek_high_selected_summaries_aggregate_facts_sources',{human_semantic_review:'pending'})
  }
}
try{
  if(mode==='equipment')await equipmentRun()
  else if(mode==='documents')await documentsRun()
  else if(mode==='voice'||mode==='voice-audio')await voiceRun()
  else if(mode==='voice-cancel')await cancelRun()
  else if(mode.endsWith('-live')||mode==='voice-replay')await liveRun()
  else throw Error('Unknown mode '+mode)
  evidence.status='passed'
}catch(error){
  evidence.status='failed';evidence.error=error.stack
  if(page&&!page.isClosed()){evidence.visible_error=await page.locator('#status').innerText().catch(()=>'');await shot('failure').catch(()=>{})}
  throw error
}
finally{
  evidence.finished_at=new Date().toISOString()
  writeFileSync(join(out,'result.json'),JSON.stringify(evidence,null,2))
  if(app)await app.close().catch(()=>{})
  if(service)await new Promise(done=>service.server.close(done))
}
