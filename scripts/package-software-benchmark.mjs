import assert from 'node:assert/strict'
import {cpSync,readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync} from 'node:fs'
import {join,resolve,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'

const source=resolve('benchmarks/software-v0.1')
const output=resolve(process.argv[2])
assert.ok(!existsSync(output),'Use a new package directory')
mkdirSync(output,{recursive:true})
cpSync(source,output,{recursive:true})
cpSync('scripts/score-software-benchmark.mjs',join(output,'tools/scoring.mjs'))
const suite=JSON.parse(readFileSync('tests/fixtures/software-agent-benchmark/tasks.v0.1.json','utf8'))
suite.version='0.1.3'
suite.status='frozen'
suite.ranking_enabled=false
suite.calibration_scope='three_actual_Electron_reference_apps; controlled_faults_restart_exports_product_negative_controls; real_DeepSeek_high_semantics; digital_playback_capture; physical_microphone_user_assured; independent_human_ratings_pending'
for(const task of suite.tasks){
  if(task.id==='voice-conversation')task.resources=task.resources.replace('人工转写','对应文本')
  if(task.id==='equipment-lending')task.prompt+='逾期查询可以按指定日期作为基准。'
  const steps=readFileSync(join(source,'evaluator',task.id+'.md'),'utf8')
  const taskText='# '+task.id+'\n\n'+task.prompt+'\n\n## 输入及边界\n\n'+task.resources+
    '\n\n默认使用 Windows 桌面。可用运行时和模型配置以统一 study.json 为准。\n\n'+
    '## 公开验收标准\n\n'+task.checks.map(c=>'- '+c.id+'（'+c.points+'分） '+c.expected).join('\n')+
    '\n\n## 公开操作场景\n\n'+steps+'\n\n交付时提供正常启动入口、依赖说明和本机数据位置。\n'
  writeFileSync(join(output,'participant',task.id+'.md'),taskText)
}
writeFileSync(join(output,'tasks.json'),JSON.stringify(suite,null,2))
let scoring=readFileSync('docs/05_PROJECT_PLAN/software-agent-benchmark-v0.1.md','utf8')
scoring=scoring.replace('状态为协议草案。先冻结任务、评分与条件，再执行对照。','本包冻结为'+suite.version+'，执行前填写统一study.json。校准范围以CALIBRATION.md为准。')
scoring=scoring.replace('当前 tasks 文件状态为 draft','本包 tasks 文件状态为 frozen')
scoring=scoring.replace('先准备三个任务各自的验收输入、外部检查脚本、可用参考解和至少一个错误反例。任何任务未通过校准时标 draft，禁止把运行得分用于正式排名。',
  '本包提供统一输入、外部验收步骤、自动核对器和三个实际参考应用的端到端校准证据。单机校准支持pilot开跑，正式排名仍需两名独立评判者完成语义与听音标注，范围详见CALIBRATION.md。')
writeFileSync(join(output,'SCORING.md'),scoring)
const transcript=JSON.parse(readFileSync(join(output,'inputs/voice/transcripts.json'),'utf8'))
assert.equal(transcript.records.length,3)
for(const row of transcript.records){
  const bytes=readFileSync(join(output,'inputs/voice',row.file))
  assert.equal(bytes.subarray(0,4).toString(),'RIFF')
  assert.ok(bytes.length>8000)
}
const checks=JSON.parse(readFileSync(join(output,'calibration/results.json'),'utf8'))
assert.equal(checks.results.length,18)
assert.ok(checks.results.every(row=>row.status==='passed'))
const reference=JSON.parse(readFileSync(join(output,'calibration/e2e-index.json'),'utf8'))
assert.equal(reference.status,'local_reference_calibrated')
assert.ok(reference.runs.every(run=>run.status==='passed'))
const files=[]
function visit(directory){
  for(const item of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(directory,item.name)
    if(item.isDirectory()){visit(path);continue}
    files.push({path:relative(output,path).replaceAll('\\','/'),bytes:readFileSync(path).length,
      sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})
  }
}
visit(output)
const manifest={version:suite.version,created_at:new Date().toISOString(),
  source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files}
writeFileSync(join(output,'MANIFEST.json'),JSON.stringify(manifest,null,2))
console.log(JSON.stringify({output,files:files.length,manifest_sha256:createHash('sha256').update(readFileSync(join(output,'MANIFEST.json'))).digest('hex')}))
