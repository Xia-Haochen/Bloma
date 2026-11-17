import assert from 'node:assert/strict'
import {cpSync, mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {createProject, updateProject} from '../main/project/project-service'
import {parseLeanBrief} from '../main/guide/lean-brief'
import {readPrdBackplane, markPrdUserConfirmed} from '../main/project/prd-store'
import {syncDocuments} from '../main/project/document-sync'
import {prdScopeFingerprint} from '../main/project/requirement-contract'
import {configureIndependentPolicy} from '../main/software/independent-policy'
import {prepareSpeechCapability} from '../main/software/capability-tools'
import {speechPythonPath} from '../main/software/capability-bindings'
import {registerNativeGuiTests} from '../main/software/native-gui-registration'
import {verifySoftwareCandidate} from '../main/software/verification'
import {closeAllDebugSessions} from '../main/software/debug-sessions'

for (const name of ['BLOMA_CALIBRATION_OUT','BLOMA_CALIBRATION_ASSETS','BLOMA_CALIBRATION_VENV']) {
  assert.ok(process.env[name], 'Required calibration input: '+name)
}
const out=resolve(process.env.BLOMA_CALIBRATION_OUT!)
const assets=resolve(process.env.BLOMA_CALIBRATION_ASSETS!)
const sourcePython=resolve(process.env.BLOMA_CALIBRATION_VENV!)
assert.ok(!existsSync(out),'Use a new output directory for each calibration')
mkdirSync(out,{recursive:true})
process.env.PROMA_HOME=join(out,'home')
process.env.BLOMA_SPEECH_MODEL_DIR=assets
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex')
const project=createProject({request_id:'reference',mode:'quick'},{workflowVersion:'software-v1'})
const id=project.project_id, root=project.root_path
configureIndependentPolicy(id,{version:1,enabled:false})
const parsed=parseLeanBrief(JSON.stringify({
  action:'brief',goal:'语音参考校准',ui:'required',delivery:'desktop',
  requirements:[
    {description:'固定音频转写',expected:'标准语音转写结果包含开会',capabilities:['speech']},
    {description:'离线朗读',expected:'固定回复合成为音频并播放到结尾',capabilities:[]},
    {description:'保存文本',expected:'关闭重开后仍显示本轮转写与回复',capabilities:[]},
  ],
}),{projectId:id,sessionId:'reference',source:'语音参考校准',previous:readPrdBackplane(id),software:true})!
assert.equal(parsed.action,'brief')
if(parsed.action!=='brief')throw Error('REFERENCE_BRIEF_INVALID')
parsed.brief.lean_brief!.preview='skip'
syncDocuments({project_id:id,session_id:'reference',request_id:'confirm',checkpoint:'requirement_confirmed'},parsed.brief)
const brief=markPrdUserConfirmed(id)!,scope=prdScopeFingerprint(brief)
updateProject(id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
cpSync('tests/fixtures/acceptance-reference',root,{recursive:true})
cpSync(sourcePython,join(root,'.venv'),{recursive:true})
const fixture=join(root,'voice-golden.wav')
cpSync('main/templates/tools/voice-golden.wav',fixture)
writeFileSync(join(root,'native-inputs.json'),JSON.stringify({files:['voice-golden.wav']}))
const resources=['model.int8.onnx','tokens.txt','silero_vad.onnx','tts-vits-zh/model.onnx','tts-vits-zh/tokens.txt','tts-vits-zh/lexicon.txt']
const before=Object.fromEntries(resources.map(file=>[file,hash(join(assets,file))]))
const signal=AbortSignal.timeout(600000)
console.log('preparing_reference_runtime')
const prepared=await prepareSpeechCapability(id,root,signal,{install_dependencies:false})
assert.equal(prepared.status,'prepared')
writeFileSync(join(root,'calibration-config.json'),JSON.stringify({python:speechPythonPath(root),tts:join(assets,'tts-vits-zh')}))
const electron=createRequire(resolve('package.json'))('electron')
writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'electron',window_title:'语音参考应用',command:[electron,'main.cjs']}))
writeFileSync(join(root,'CORE_CHECK.json'),JSON.stringify({speech:{module:'speech_runtime',factory:'SpeechEngine',method:'transcribe',rate_argument:true}}))
registerNativeGuiTests(id,'acceptance.mjs',true)
const evidence:any={project:id,fixture_sha256:hash(fixture),resources:before,scope:'real offline ASR, real offline TTS, Electron playback and restart; fixed reply, no provider model or physical microphone',runs:[]}
try{
  for(const variant of ['reference','wrong_reply','restored']){
    const file=join(root,'voice.py'),original=readFileSync('tests/fixtures/acceptance-reference/voice.py','utf8')
    writeFileSync(file,variant==='wrong_reply'?original.replace('收到，我们下周四下午三点开会。','这是错误回复。'):original)
    console.log('running_'+variant)
    const result=await verifySoftwareCandidate(id,variant,signal,true)
    evidence.runs.push({variant,status:result.status,summary:result.summary,candidate:result.candidate?.id,
      speech:result.core?.speech,launch:result.launch?.passed,cases:result.core?.host_gui?.case_results})
    writeFileSync(join(out,'result.json'),JSON.stringify(evidence,null,2))
    console.log(JSON.stringify({variant,status:result.status,summary:result.summary}))
    assert.equal(result.status,variant==='wrong_reply'?'failed':'passed')
  }
  assert.deepEqual(Object.fromEntries(resources.map(file=>[file,hash(join(assets,file))])),before)
  evidence.resources_unchanged=true
  writeFileSync(join(out,'result.json'),JSON.stringify(evidence,null,2))
}finally{await closeAllDebugSessions()}
