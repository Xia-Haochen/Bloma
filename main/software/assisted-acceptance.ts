import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import type { AssistedAcceptanceInput, AssistedAcceptanceView } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import type { SpeechVerificationResult } from '../desktop/speech-verification'
import { microphoneAcceptance } from './microphone-acceptance'
import { readSoftwareCandidate, verifyReleaseSource, promoteSoftwareRelease, type SoftwareRelease } from './release-store'
import { verifySoftwareCandidate, verificationInputs, awaitingUserChecks, type SoftwareVerification } from './verification'
import { deliveryQualityGate } from './delivery-qualification'
import { saveSoftwareRunState } from './run-state'
import { isLongtermSoftware, stageLongtermMilestone } from './longterm-state'
import { registerBackgroundRun, unregisterBackgroundRun } from '../orchestration/stages/run-registry'
import { launchSoftwareTrial } from './trial'

interface Attempt extends AssistedAcceptanceView {
  project_id:string
  operation_id?:string
  scope:string
  request_id:string
  at:string
  ended_at?:string
  adapter_version:number
  inputs:SoftwareVerification['input_identity']
  feedback_request_id?:string
}
const live = new Map<string, {controller:AbortController;done:Promise<void>}>()
const active = new Set(['preparing','ready','recording','decoding','verifying'])
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function directory(id:string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('ASSISTED_PROJECT_INVALID')
  return join(getPromaHome(),'assisted-acceptance',id)
}
function read(id:string):Attempt | undefined {
  const file=join(directory(id),'current.json')
  if (!existsSync(file)) return
  const value=JSON.parse(readFileSync(file,'utf8')) as Attempt
  if(value.project_id!==id || !/^[a-f0-9]{64}$/.test(value.candidate_id) || !value.attempt_id || !/^[A-Za-z0-9-]+$/.test(value.attempt_id)) throw Error('ASSISTED_RECORD_INVALID')
  return value
}
function save(attempt:Attempt) {
  writeTextFileAtomic(join(directory(attempt.project_id),attempt.attempt_id!,'attempt.json'),JSON.stringify(attempt))
  writeTextFileAtomic(join(directory(attempt.project_id),'current.json'),JSON.stringify(attempt))
}
function receipt(id:string):SoftwareVerification | undefined {
  const file=join(getPromaHome(),'software-verification',id+'.json')
  if(!existsSync(file))return
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(value.state!=='complete')return
  if(value.version!==1 || !value.result || hash(value.result)!==value.result_hash)throw Error('ASSISTED_VERIFICATION_INVALID')
  return value.result
}
async function resumeVerification(attempt:Attempt,candidate:SoftwareRelease,signal:AbortSignal) {
  const id=attempt.project_id, project=findProject(id)
  attempt.can_confirm=false;attempt.phase='verifying';attempt.detail='实测证据已保存，正在复验同一候选。';save(attempt)
  const verified=await verifySoftwareCandidate(id,attempt.request_id,signal,true,candidate)
  const gap=verified.status==='passed'?await deliveryQualityGate(id,signal):verified.summary
  if(gap) {
    attempt.phase='passed';attempt.detail=(attempt.assessment_source==='user_observation'?'麦克风实测已由你核对通过':'麦克风实测自动检查通过')+'，剩余验收事项：'+gap.slice(0,350)
  } else if(isLongtermSoftware(id)) {
    stageLongtermMilestone(id,project.last_session_id!,attempt.request_id,candidate)
    attempt.phase='passed';attempt.detail='实测和自动检查通过，请核对当前里程碑。'
  } else {
    await promoteSoftwareRelease(candidate,{version:verified.input_identity!.source,scope:attempt.scope,at:new Date().toISOString()},signal,
      ()=>findProject(id).lean_operation_id===attempt.operation_id&&prdScopeFingerprint(readPrdBackplane(id))===attempt.scope,true)
    attempt.phase='passed';attempt.detail='实测和正式验收通过，程序已交付。'
  }
  if(findProject(id).status!=='completed')saveSoftwareRunState({projectId:id,sessionId:project.last_session_id!,runId:attempt.attempt_id!,status:'blocked',candidateId:candidate.id,error:attempt.detail})
}
function startOwned(attempt:Attempt,work:(signal:AbortSignal)=>Promise<void>) {
  const id=attempt.project_id,controller=new AbortController(),owner=findProject(id).last_session_id??'assisted-'+id
  saveSoftwareRunState({projectId:id,sessionId:owner,runId:attempt.attempt_id!,status:'verifying',candidateId:attempt.candidate_id,error:attempt.detail})
  const backgroundId=registerBackgroundRun(owner,controller,id,()=>{})
  const holder={controller,done:Promise.resolve()}
  live.set(id,holder)
  holder.done=(async()=>{
    try { await work(controller.signal) }
    catch(error) {
      attempt.phase=controller.signal.aborted?'cancelled':'failed'
      attempt.detail=controller.signal.aborted?'已取消本次实测。':(error instanceof Error?error.message:String(error)).slice(0,500)
    } finally {
      attempt.ended_at=new Date().toISOString()
      try {
        save(attempt)
        if(attempt.phase!=='passed')saveSoftwareRunState({projectId:id,sessionId:owner,runId:attempt.attempt_id!,status:'waiting_user',candidateId:attempt.candidate_id,error:attempt.detail})
      } finally {live.delete(id);unregisterBackgroundRun(owner,backgroundId)}
    }
  })().catch(error=>console.error('[assisted-acceptance] result persistence failed',String(error)))
}
export async function pendingAssistedCandidate(id:string, requestId?:string) {
  const report=receipt(id)
  if (!report?.candidate || requestId && report.input_identity?.request_id!==requestId
    || !awaitingUserChecks(report.core) || !report.security?.passed
    || report.independent?.status==='failed' || report.independent?.case_results?.some(row=>row.status==='failed')) return
  try {await verifyReleaseSource(report.candidate)} catch {return} // stale receipts resume the normal repair/verification route
  if(report.input_identity?.scope!==prdScopeFingerprint(readPrdBackplane(id)))return
  return report.candidate
}
export function assistedAcceptanceView(id:string):AssistedAcceptanceView | null {
  const attempt=read(id), report=receipt(id)
  if(attempt) {
    const project=findProject(id)
    const stale=attempt.operation_id!==project.lean_operation_id || attempt.scope!==prdScopeFingerprint(readPrdBackplane(id))
      || !!report?.candidate && report.candidate.id!==attempt.candidate_id
    if(stale)return report?.candidate&&awaitingUserChecks(report.core)
      ? {candidate_id:report.candidate.id,phase:'available',detail:'候选版本已变化，请测试当前版本。'}
      : {...attempt,phase:'stale',detail:'候选版本已变化，请先完成当前版本自动检查。'}
    if(attempt.phase==='passed'&&report?.candidate&&awaitingUserChecks(report.core))return {candidate_id:report.candidate.id,phase:'available',detail:'当前实测凭据已失效，请重新测试。'}
    if(active.has(attempt.phase) && !live.has(id)) return {...attempt,phase:'interrupted',detail:'上次实测中断，可重新开始。'}
    if(live.has(id)&&attempt.phase==='preparing') {
      const progress=join(directory(id),attempt.attempt_id!,'progress.json')
      if(existsSync(progress)) {
        const value=JSON.parse(readFileSync(progress,'utf8'))
        if(['ready','recording','decoding'].includes(value.phase))return {...attempt,...value,detail:value.phase==='ready'?'选择麦克风后开始录音。':value.phase==='recording'?'正在录音，请说：我们下周四下午三点开会。':'正在识别刚才的录音。'}
      }
    }
    return attempt
  }
  if(report?.candidate && awaitingUserChecks(report.core))return {candidate_id:report.candidate.id,phase:'available',detail:'需要一次实体麦克风实测。'}
  return null
}
export async function assistedAcceptanceAction(input:AssistedAcceptanceInput, busy=false):Promise<AssistedAcceptanceView | null> {
  const id=input.project_id
  if(input.action==='query')return assistedAcceptanceView(id)
  if(input.action==='open') {
    const report=receipt(id),candidate=report?.candidate
    if(busy||!candidate||candidate.id!==input.candidate_id||!report.security?.passed
      ||report.input_identity?.scope!==prdScopeFingerprint(readPrdBackplane(id)))throw Error('ASSISTED_CURRENT_CANDIDATE_REQUIRED')
    await verifyReleaseSource(candidate)
    const trial=await launchSoftwareTrial(id,undefined,false,candidate.id)
    if(!trial.started)throw Error(trial.detail)
    return assistedAcceptanceView(id)
  }
  const previous=read(id)
  if(input.action==='feedback') {
    if(previous?.feedback_request_id===input.request_id&&previous.attempt_id===input.attempt_id&&previous.candidate_id===input.candidate_id)return assistedAcceptanceView(id)
    if(busy||live.has(id)||input.accepted!==true||!previous||previous.attempt_id!==input.attempt_id
      ||previous.candidate_id!==input.candidate_id||previous.adapter_version!==microphoneAcceptance.version
      ||assistedAcceptanceView(id)?.phase!=='failed')throw Error('ASSISTED_FEEDBACK_NOT_READY')
    const candidate=await pendingAssistedCandidate(id)
    if(!candidate||candidate.id!==previous.candidate_id)throw Error('ASSISTED_CURRENT_CANDIDATE_REQUIRED')
    const current=await verificationInputs(id,input.request_id)
    if(current.input_identity.source!==previous.inputs?.source||current.input_identity.scope!==previous.scope
      ||current.input_identity.rules!==previous.inputs?.rules)throw Error('ASSISTED_INPUT_CHANGED')
    const result:SpeechVerificationResult=JSON.parse(readFileSync(join(directory(id),previous.attempt_id!,'observations.json'),'utf8'))
    if(!microphoneAcceptance.canConfirm(result))throw Error('ASSISTED_OBSERVATION_NOT_CONFIRMABLE')
    if(live.has(id))throw Error('ASSISTED_ATTEMPT_ACTIVE')
    writeTextFileAtomic(join(directory(id),previous.attempt_id!,'feedback.json'),JSON.stringify({source:'user_observation',accepted:true,
      request_id:input.request_id,candidate_id:candidate.id,attempt_id:previous.attempt_id,at:new Date().toISOString(),original_inputs:previous.inputs,current_inputs:current.input_identity}))
    previous.feedback_request_id=input.request_id;previous.assessment_source='user_observation';previous.can_confirm=false
    previous.phase='verifying';previous.detail='已收到你对本次实际转写的核对，正在继续验收。';save(previous)
    startOwned(previous,async signal=>{
      signal.throwIfAborted()
      await verifyReleaseSource(candidate,signal)
      microphoneAcceptance.accept(candidate,result,{attempt_id:previous.attempt_id!,candidate_id:candidate.id})
      await resumeVerification(previous,candidate,signal)
    })
    return assistedAcceptanceView(id)
  }
  if(input.action==='cancel') {
    if(!previous || previous.attempt_id!==input.attempt_id)throw Error('ASSISTED_ATTEMPT_CHANGED')
    const running=live.get(id)
    running?.controller.abort()
    await running?.done
    return assistedAcceptanceView(id)
  }
  if(input.action==='capture') {
    const view=assistedAcceptanceView(id)
    if(!previous || previous.attempt_id!==input.attempt_id || view?.phase!=='ready' || !live.has(id)
      || !Number.isSafeInteger(input.device) || !view.devices?.some(device=>device.id===input.device))throw Error('ASSISTED_CAPTURE_NOT_READY')
    const file=join(directory(id),previous.attempt_id!,'capture.json')
    if(existsSync(file) && JSON.parse(readFileSync(file,'utf8')).device!==input.device)throw Error('ASSISTED_CAPTURE_ALREADY_STARTED')
    if(!existsSync(file))writeTextFileAtomic(file,JSON.stringify({device:input.device}))
    return view
  }
  if(input.action!=='start')throw Error('ASSISTED_ACTION_INVALID')
  if(live.has(id)) {
    if(previous?.candidate_id===input.candidate_id)return assistedAcceptanceView(id)
    throw Error('ASSISTED_ATTEMPT_ACTIVE')
  }
  if(previous?.request_id===input.request_id)return assistedAcceptanceView(id)
  if(busy)throw Error('当前项目正在执行，请等本轮结束后实测。')
  const project=findProject(id), report=receipt(id)
  if(project.status!=='active'||!report?.candidate||!report.security?.passed||input.candidate_id!==report.candidate.id||!awaitingUserChecks(report.core))throw Error('ASSISTED_CURRENT_CANDIDATE_REQUIRED')
  if(!await pendingAssistedCandidate(id))throw Error('ASSISTED_CURRENT_CANDIDATE_REQUIRED')
  const candidate=await readSoftwareCandidate(id,input.candidate_id)
  await verifyReleaseSource(candidate)
  const before=await verificationInputs(id,input.request_id)
  // Lock again after asynchronous source validation.
  if(live.has(id))return assistedAcceptanceView(id)
  if(receipt(id)?.candidate?.id!==candidate.id)throw Error('ASSISTED_CURRENT_CANDIDATE_REQUIRED')
  const attempt:Attempt={project_id:id,operation_id:project.lean_operation_id,scope:prdScopeFingerprint(readPrdBackplane(id)),
    request_id:input.request_id,candidate_id:candidate.id,attempt_id:randomUUID(),phase:'preparing',detail:'正在准备识别入口和麦克风设备。',at:new Date().toISOString(),adapter_version:microphoneAcceptance.version,assessment_source:'automatic',inputs:before.input_identity}
  const controlDir=join(directory(id),attempt.attempt_id!)
  mkdirSync(controlDir,{recursive:true});save(attempt)
  startOwned(attempt,async signal=>{
      const result=await microphoneAcceptance.execute(candidate,controlDir,signal)
      writeTextFileAtomic(join(controlDir,'observations.json'),JSON.stringify(result))
      signal.throwIfAborted()
      await verifyReleaseSource(candidate,signal)
      if(findProject(id).lean_operation_id!==attempt.operation_id || prdScopeFingerprint(readPrdBackplane(id))!==attempt.scope)throw Error('ASSISTED_TARGET_CHANGED')
      if((await verificationInputs(id,input.request_id,signal)).key!==before.key)throw Error('ASSISTED_INPUT_CHANGED')
      attempt.observation=result.microphone
      attempt.can_confirm=microphoneAcceptance.canConfirm(result)
      if(result.status==='environment_blocked') {
        attempt.phase='unavailable';attempt.detail='设备或识别环境暂不可用：'+(result.error??'请检查麦克风连接和系统权限。');return
      }
      if(result.status!=='passed'||result.microphone?.status!=='passed')throw Error(result.error ?? ((result.microphone?.rms??0)<.001?'未采集到足够声音，请检查设备选择、静音和麦克风权限后重试。':'已采集到声音，但识别结果与测试语句不一致，请查看本次转写后重试。'))
      microphoneAcceptance.accept(candidate,result)
      await resumeVerification(attempt,candidate,signal)
  })
  return assistedAcceptanceView(id)
}
