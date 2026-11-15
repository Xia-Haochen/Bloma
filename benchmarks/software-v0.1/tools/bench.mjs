import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,readdirSync,lstatSync,createReadStream,existsSync} from 'node:fs'
import {join,resolve,dirname,relative} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {equipmentFacts,documentFacts,voiceFacts} from './oracles.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const localScore=join(root,'tools/scoring.mjs')
const {scoreTrial}=await import(pathToFileURL(existsSync(localScore)?localScore:resolve(root,'../../scripts/score-software-benchmark.mjs')).href)
const [action,...args]=process.argv.slice(2)
if(action==='verify-pack'){
  const manifest=read(join(root,'MANIFEST.json'))
  for(const entry of manifest.files)assert.equal(hash(readFileSync(join(root,entry.path))),entry.sha256,entry.path)
  console.log(JSON.stringify({verified:true,files:manifest.files.length,manifest_sha256:hash(readFileSync(join(root,'MANIFEST.json')))}))
}else if(action==='init'){
  const [taskId,out]=args,dir=resolve(out),suite=read(join(root,'tasks.json'))
  const task=suite.tasks.find(t=>t.id===taskId)
  assert.ok(task,'unknown task');assert.ok(!existsSync(dir),'use a new run directory')
  mkdirSync(dir,{recursive:true})
  const trial={protocol_sha256:hash(readFileSync(join(root,'tasks.json'))),run_id:dir.split(/[\\/]/).at(-1),task_id:taskId,
    system_id:'TO_BE_SET',configuration_id:'TO_BE_SET',seed:'public-01',evaluator_id:'TO_BE_SET',track:'H',
    execution_status:'user_stopped',wall_seconds:0,cost_rmb:null,technical_interventions:0,artifact_sha256:null,observations:[]}
  writeFileSync(join(dir,'trial.json'),JSON.stringify(trial,null,2))
  writeFileSync(join(dir,'study.json'),readFileSync(join(root,'study.json')))
  writeFileSync(join(dir,'checks.json'),JSON.stringify(task.checks.map(c=>({check_id:c.id,status:'unverified',expected:c.expected,evidence:[],reviewers:[],notes:''})),null,2))
  writeFileSync(join(dir,'interventions.json'),JSON.stringify({normal_participation:[],technical_help:[],paused_intervals:[]},null,2))
  const names={'equipment-lending':['equipment','equipment'],'document-batch-workflow':['documents','document'],'voice-conversation':['voice','voice']}
  const [example,label]=names[taskId]
  const blank=value=>Array.isArray(value)?value.map(blank):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,blank(child)]))
    :typeof value==='boolean'?false:typeof value==='number'?null:''
  writeFileSync(join(dir,label+'-facts.json'),JSON.stringify(blank(read(join(root,'calibration',example+'-positive-facts.json'))),null,2))
  console.log(dir)
}else if(action==='event'){
  const [dir,kind,...message]=args
  const event={at:new Date().toISOString(),kind,message:message.join(' ')}
  if(kind==='start'){
    const studyBytes=readFileSync(join(resolve(dir),'study.json'))
    assert.ok(!studyBytes.toString().includes('TO_BE_SET'),'fill the shared study first')
    event.study_sha256=hash(studyBytes)
    event.protocol_sha256=hash(readFileSync(join(root,'tasks.json')))
  }
  appendFileSync(join(resolve(dir),'events.jsonl'),JSON.stringify(event)+'\n')
}else if(action==='snapshot'){
  const [folder,output]=args,base=resolve(folder),target=resolve(output),files=[]
  assert.ok(relative(base,target).startsWith('..'),'place manifest outside product directory')
  async function visit(directory){
    for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(item.name==='.git')continue
      const file=join(directory,item.name),info=lstatSync(file)
      assert.ok(!info.isSymbolicLink(),'copy external dependencies into the delivery directory before freezing: '+file)
      if(info.isDirectory()){await visit(file);continue}
      const digest=createHash('sha256')
      for await(const bytes of createReadStream(file))digest.update(bytes)
      files.push({path:relative(base,file).replaceAll('\\','/'),size:info.size,sha256:digest.digest('hex')})
    }
  }
  await visit(base)
  mkdirSync(dirname(target),{recursive:true})
  writeFileSync(target,JSON.stringify({files,artifact_sha256:hash(JSON.stringify(files))},null,2))
  console.log(hash(JSON.stringify(files)))
}else if(action==='finalize'){
  const dir=resolve(args[0]),trial=read(join(dir,'trial.json')),snapshot=read(join(dir,'artifact-manifest.json'))
  const study=read(join(dir,'study.json'))
  assert.ok(!JSON.stringify(study).includes('TO_BE_SET'),'fill the shared study configuration before comparison')
  for(const field of ['system_id','configuration_id','evaluator_id'])assert.notEqual(trial[field],'TO_BE_SET',field)
  const interventions=read(join(dir,'interventions.json'))
  const events=readFileSync(join(dir,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line))
  const starts=events.filter(row=>row.kind==='start'),stops=events.filter(row=>row.kind==='stop')
  assert.equal(starts.length,1);assert.equal(stops.length,1)
  const start=Date.parse(starts[0].at),stop=Date.parse(stops[0].at)
  assert.ok(Number.isFinite(start)&&Number.isFinite(stop)&&stop>=start)
  assert.equal(starts[0].study_sha256,hash(readFileSync(join(dir,'study.json'))),'study changed after start')
  assert.equal(starts[0].protocol_sha256,hash(readFileSync(join(root,'tasks.json'))),'protocol changed after start')
  let paused=0,last=start
  for(const interval of [...interventions.paused_intervals].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start))){
    const from=Date.parse(interval.start),to=Date.parse(interval.end)
    assert.ok(from>=last&&to>=from&&to<=stop&&interval.reason)
    paused+=to-from;last=to
  }
  trial.wall_seconds=(stop-start-paused)/1000
  const suite=read(join(root,'tasks.json'))
  assert.equal(study.wall_limit_seconds,suite.limits.wall_seconds)
  assert.equal(study.production_cost_cap_rmb,suite.limits.cost_rmb)
  trial.study_sha256=hash(readFileSync(join(dir,'study.json')))
  trial.technical_interventions=interventions.technical_help.length
  trial.artifact_sha256=snapshot.artifact_sha256
  trial.observations=read(join(dir,'checks.json')).map(row=>{
    if(row.status==='pass'){
      assert.ok(row.evidence.length>0,'evidence required: '+row.check_id)
      assert.ok(row.reviewers.length>0,'reviewer required: '+row.check_id)
      const semantic=trial.task_id==='voice-conversation'&&['B1','B2','B3'].includes(row.check_id)
        ||trial.task_id==='document-batch-workflow'&&row.check_id==='B3'
      if(semantic)assert.ok(new Set(row.reviewers).size>=2,'two reviewers required: '+row.check_id)
    }
    return {check_id:row.check_id,status:row.status,artifact_sha256:trial.artifact_sha256,
      evidence:row.evidence.map(file=>({path:file,sha256:hash(readFileSync(resolve(dir,file)))}))}
  })
  const result=scoreTrial(readFileSync(join(root,'tasks.json')),trial,dir)
  writeFileSync(join(dir,'trial.json'),JSON.stringify(trial,null,2))
  writeFileSync(join(dir,'score.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify(result,null,2))
}else if(action==='grade-equipment')console.log(equipmentFacts(read(resolve(args[0]))))
else if(action==='grade-documents')console.log(documentFacts(read(resolve(args[0])),read(join(root,'inputs/documents/facts.json'))))
else if(action==='grade-voice')console.log(voiceFacts(read(resolve(args[0]))))
else throw Error('Actions: verify-pack, init, event, snapshot, finalize, grade-equipment, grade-documents, grade-voice')
