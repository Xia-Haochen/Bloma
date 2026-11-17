import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {equipmentFacts,documentFacts,voiceFacts} from './oracles.mjs'
import {startService} from './controlled-service.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const tmp=mkdtempSync(join(tmpdir(),'benchmark-calibration-'))
const expected=JSON.parse(readFileSync(join(root,'inputs/documents/facts.json'),'utf8'))
const equipment={after_partial:{E01:{total:5,outstanding:2,available:3},E02:{total:3,outstanding:1,available:2},E03:{total:2,outstanding:1,available:1}},
  overdue:['M01:E01:1','M02:E03:1'],after_restart:{E01:3,E02:2,E03:2,E04:4},after_import_and_return:{E01:4}}
const documents={imported_files:Object.keys(expected.files),search_results:expected.search,selected_files:expected.selected,
  original_input_sha256_before:'a'.repeat(64),original_input_sha256_after:'a'.repeat(64),exported_text:'林舟负责青禾项目，预算300元。'}
const voice={rounds:Array.from({length:3},()=>({duration:5,ended:true,muted:false,played_seconds:5,text_audio_match:true})),
  recalled_facts:['语音助手','周五','300','蓝色'],current_input_in_request:true,history_in_request:true}
const results=[]
function check(name,run){run();results.push({name,status:'passed'})}
const examples={equipment,documents,voice}
let server
try{
  check('equipment positive numeric reference',()=>equipmentFacts(equipment))
  check('equipment inventory corruption rejected',()=>{const x=structuredClone(equipment);x.after_partial.E01.available=5;assert.throws(()=>equipmentFacts(x))})
  check('equipment overdue misassociation rejected',()=>{const x=structuredClone(equipment);x.overdue[0]='M02:E01:1';assert.throws(()=>equipmentFacts(x))})
  check('equipment restore corruption rejected',()=>{const x=structuredClone(equipment);x.after_import_and_return.E01=3;assert.throws(()=>equipmentFacts(x))})
  check('documents positive fact reference',()=>documentFacts(documents,expected))
  check('documents lost duplicate-name file rejected',()=>{const x=structuredClone(documents);x.imported_files.pop();assert.throws(()=>documentFacts(x,expected))})
  check('documents wrong page rejected',()=>{const x=structuredClone(documents);x.search_results[0].location='page:99';assert.throws(()=>documentFacts(x,expected))})
  check('documents input mutation rejected',()=>assert.throws(()=>documentFacts({...documents,original_input_sha256_after:'b'.repeat(64)},expected)))
  check('documents unselected budget leakage rejected',()=>assert.throws(()=>documentFacts({...documents,exported_text:'林舟3000元'},expected)))
  check('voice positive observation reference',()=>voiceFacts(voice))
  check('voice truncated audio rejected',()=>{const x=structuredClone(voice);x.rounds[1].played_seconds=2;assert.throws(()=>voiceFacts(x))})
  check('voice muted audio rejected',()=>{const x=structuredClone(voice);x.rounds[0].muted=true;assert.throws(()=>voiceFacts(x))})
  check('voice forgotten context rejected',()=>assert.throws(()=>voiceFacts({...voice,history_in_request:false})))
  const service=await startService(tmp)
  server=service.server
  const call=async(key='benchmark-test-key',stream=false)=>{
    const response=await fetch(service.endpoint.base_url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},
      body:JSON.stringify({model:'benchmark-model',stream,messages:[{role:'user',content:'青禾预算300元'}]})})
    return {status:response.status,body:await response.text()}
  }
  const good=await call();assert.equal(good.status,200);assert.ok(good.body.includes('青禾预算300元'));results.push({name:'controlled service actual HTTP success',status:'passed'})
  assert.equal((await call('wrong')).status,401);results.push({name:'controlled service actual HTTP auth failure',status:'passed'})
  writeFileSync(join(tmp,'control.json'),JSON.stringify({auth_key:'benchmark-test-key',fail_next:1,delay_ms:0}))
  assert.equal((await call()).status,503)
  assert.equal((await call()).status,200);results.push({name:'controlled service one-shot failure and recovery',status:'passed'})
  assert.ok((await call('benchmark-test-key',true)).body.includes('[DONE]'));results.push({name:'controlled service SSE completion',status:'passed'})
  const logs=readFileSync(join(tmp,'requests.jsonl'),'utf8')
  assert.ok(!logs.includes('Bearer')&&!logs.includes('benchmark-test-key'));results.push({name:'service log omits credentials',status:'passed'})
  const out=join(root,'calibration')
  mkdirSync(out,{recursive:true})
  for(const [task,facts]of Object.entries(examples))writeFileSync(join(out,task+'-positive-facts.json'),JSON.stringify(facts,null,2))
  writeFileSync(join(out,'results.json'),JSON.stringify({at:new Date().toISOString(),scope:'oracle mutation controls and real controlled HTTP service; excludes application UI, physical microphone and live-model semantics',results},null,2))
  console.log(JSON.stringify({checks:results.length,passed:results.length}))
}finally{if(server)await new Promise(done=>server.close(done));rmSync(tmp,{recursive:true,force:true})}
