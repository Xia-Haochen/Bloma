import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,readdirSync,mkdirSync,cpSync} from 'node:fs'
import {join,resolve,relative} from 'node:path'
import {createHash} from 'node:crypto'
const source=resolve(process.argv[2]),destination=resolve('benchmarks/software-v0.1/reference-evidence')
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
mkdirSync(destination,{recursive:true})
const runs=[]
for(const name of ['equipment-final','documents-clean','voice-final','voice-cancel','documents-live','voice-live','voice-replay']){
  const root=join(source,name),result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'))
  assert.equal(result.status,'passed',name)
  const target=join(destination,name);mkdirSync(target,{recursive:true})
  for(const file of readdirSync(root)){
    if(/\.(json|png|csv|md|wav|txt)$/.test(file)&&!(name==='voice-live'&&file.endsWith('.wav')))cpSync(join(root,file),join(target,file))
  }
  const appFiles=[]
  for(const file of readdirSync(join(root,'app')).sort()){
    if(/\.(cjs|js|py|html)$/.test(file))appFiles.push({path:file,sha256:hash(join(root,'app',file))})
  }
  writeFileSync(join(target,'app-source-manifest.json'),JSON.stringify(appFiles,null,2))
  runs.push({name,mode:result.mode,status:result.status,scope:name==='voice-live'?'Original live-provider semantic evidence; TTS number correction validated in voice-final and voice-replay':result.scope,
    started_at:result.started_at,finished_at:result.finished_at,checks:result.checks,
    result:'reference-evidence/'+name+'/result.json',result_sha256:hash(join(target,'result.json')),source_manifest_sha256:hash(join(target,'app-source-manifest.json'))})
}
const live=join(destination,'live-service');mkdirSync(live,{recursive:true})
cpSync(join(source,'live-service/requests.jsonl'),join(live,'requests.jsonl'))
const original=JSON.parse(readFileSync(join(source,'live-service/preflight.json'),'utf8'))
const before=original.budget_before[0].accounted_upper_rmb
const after=JSON.parse(readFileSync(join(source,'live-service/budget-after.json'),'utf8'))[0].accounted_upper_rmb
const {balance,channel_id,budget_before,...publicPreflight}=original
writeFileSync(join(live,'preflight.json'),JSON.stringify(publicPreflight,null,2))
writeFileSync(join(live,'cost.json'),JSON.stringify({calls:8,cost_upper_rmb:Number((after-before).toFixed(6)),policy:'existing authorized ledger retained; no reset'},null,2))
const failures=[]
for(const name of ['equipment-a','documents-a','documents-b','voice-a','voice-b','voice-rendered']){
  const result=JSON.parse(readFileSync(join(source,name,'result.json'),'utf8'))
  failures.push({name,status:result.status,error:result.error,source_result_sha256:hash(join(source,name,'result.json'))})
}
failures.push({name:'voice-audio',status:'digital_timing_passed_but_semantic_audio_defect_found',error:'Independent ASR of rendered PCM found 300 missing; TTS numeric normalization rules were not enabled. Fixed and rerun as voice-final and voice-replay.'})
failures.push({name:'equipment-b',status:'data_checks_passed_but_stale_filtered_UI_found',error:'After a return the existing member filter stayed stale. Fixed and asserted refresh in equipment-final.'})
failures.push({name:'documents-final',status:'business_checks_passed_but_error_readability_defect_found',error:'Raw Python traceback and stderr encoding were unsuitable for UI. UTF-8 subprocess output and readable file errors verified in documents-clean.'})
writeFileSync(join(destination,'failed-attempts.json'),JSON.stringify(failures,null,2))
const sourceTarget=join(destination,'source');mkdirSync(sourceTarget,{recursive:true})
cpSync('tests/fixtures/benchmark-reference',sourceTarget,{recursive:true})
const index={version:'0.1.3',status:'local_reference_calibrated',runs,
  live_calls:8,live_cost_upper_rmb:Number((after-before).toFixed(6)),
  physical_microphone:{status:'user_assured_not_measured',statement:'可保证麦克风可用，不用实证了'},
  independent_human_semantic_and_listening_ratings:'pending; required for formal ranking, can run pilot meanwhile',
  production_harness_changed:false}
writeFileSync('benchmarks/software-v0.1/calibration/e2e-index.json',JSON.stringify(index,null,2))
writeFileSync(join(destination,'README.md'),'# 参考证据\n\n最终有效运行以../calibration/e2e-index.json列出的七个目录为准。其他目录保留为早期诊断记录，已知问题见failed-attempts.json，不能混入最终成功证明。source是最终参考源码；各轮app-source-manifest.json保留当时真实版本。语音真实调用与修复后原回复重放分别标注，未增加真实模型样本数。\n')
const files=[]
function visit(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())visit(file);else if(file!==join(destination,'EVIDENCE-MANIFEST.json'))files.push({path:relative(destination,file).replaceAll('\\','/'),sha256:hash(file)})}}
visit(destination)
writeFileSync(join(destination,'EVIDENCE-MANIFEST.json'),JSON.stringify({files},null,2))
console.log(JSON.stringify({runs:runs.length,files:files.length,live_cost_upper_rmb:index.live_cost_upper_rmb}))
