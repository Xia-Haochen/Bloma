import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import * as speech from '../../../main/desktop/speech-verification'
import * as releases from '../../../main/software/release-store'
import * as verification from '../../../main/software/verification'
import * as quality from '../../../main/software/delivery-qualification'
import {createProject,updateProject,findProject} from '../../../main/project/project-service'
import {prdScopeFingerprint} from '../../../main/project/requirement-contract'
import {readPrdBackplane} from '../../../main/project/prd-store'
import {assistedAcceptanceAction,assistedAcceptanceView} from '../../../main/software/assisted-acceptance'
import {hasRunForProject} from '../../../main/orchestration/stages/run-registry'
import {readSoftwareRunState} from '../../../main/software/run-state'
import {runLeanProduction} from '../../../main/desktop/lean-production'

let home:string,old:string|undefined,id:string,candidate:any,complete:(value:any)=>void
let changes=false
beforeEach(()=>{
  old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-assisted-'));process.env.PROMA_HOME=home
  const p=createProject({request_id:'create',mode:'quick'},{workflowVersion:'software-v1'})
  id=p.project_id;updateProject(id,{last_session_id:'session'})
  candidate={id:'a'.repeat(64),projectId:id,root:p.root_path,source:{digest:'b'.repeat(64)}}
  writeFileSync(join(p.root_path,'CORE_CHECK.json'),JSON.stringify({speech:{module:'speech_runtime',factory:'SpeechEngine',method:'transcribe'}}))
  const core={status:'unverified',speech:{status:'passed'},host_gui:{status:'passed'},distribution:{status:'passed'},
    pending_user_checks:[{kind:'microphone',feature:'F-001'}],requirements:[{id:'F-001',verification:'unverified'}]}
  const result={status:'unverified',candidate,core,security:{passed:true},input_identity:{scope:prdScopeFingerprint(readPrdBackplane(id)),source:candidate.source.digest}}
  mkdirSync(join(home,'software-verification'),{recursive:true})
  writeFileSync(join(home,'software-verification',id+'.json'),JSON.stringify({version:1,state:'complete',result,result_hash:createHash('sha256').update(JSON.stringify(result)).digest('hex')}))
  changes=false
  vi.spyOn(releases,'readSoftwareCandidate').mockResolvedValue(candidate)
  vi.spyOn(releases,'verifyReleaseSource').mockImplementation(async()=>{if(changes)throw Error('RELEASE_WORKING_SOURCE_CHANGED')})
  vi.spyOn(verification,'verificationInputs').mockResolvedValue({key:'same',input_identity:{...result.input_identity,rules:'rules'}} as never)
  vi.spyOn(verification,'verifySoftwareCandidate').mockImplementation(async()=>{
    const verified={...result,status:'passed',core:{...core,status:'passed',pending_user_checks:[]}}
    writeFileSync(join(home,'software-verification',id+'.json'),JSON.stringify({version:1,state:'complete',result:verified,result_hash:createHash('sha256').update(JSON.stringify(verified)).digest('hex')}))
    return verified as never
  })
  vi.spyOn(quality,'deliveryQualityGate').mockResolvedValue(undefined)
  vi.spyOn(releases,'promoteSoftwareRelease').mockImplementation(async()=>{
    updateProject(id,{status:'completed',current_stage:'completed',desktop_phase:'delivered',software_release_id:candidate.id})
  })
  vi.spyOn(speech,'saveMicrophoneEvidence').mockImplementation(()=>{})
  vi.spyOn(speech,'runHostSpeechProbe').mockImplementation(async input=>{
    writeFileSync(join(input.controlDir!,'progress.json'),JSON.stringify({phase:'ready',devices:[{id:2,name:'Test device'}]}))
    return new Promise((resolve,reject)=>{
      complete=resolve
      input.signal!.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})
    })
  })
})
afterEach(async()=>{
  const state=assistedAcceptanceView(id)
  if(hasRunForProject(id)&&state?.attempt_id)await assistedAcceptanceAction({request_id:'cleanup',project_id:id,action:'cancel',attempt_id:state.attempt_id})
  vi.restoreAllMocks()
  if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old
  rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})
})
const start=()=>assistedAcceptanceAction({request_id:'start',project_id:id,action:'start',candidate_id:candidate.id})
const pass={status:'passed',microphone:{status:'passed',rms:.1},real_decode_calls:4}
it('resuming a microphone-dependent candidate waits for the entry without a maker model call',async()=>{
  const query=vi.fn(async function*(){throw Error('must not call model')})
  const persist=vi.fn(),completeRun=vi.fn()
  await runLeanProduction({projectId:id,sessionId:'session',requestId:'continue',content:'继续',query} as never,
    {publish:vi.fn(),persistAssistant:persist,persistSystem:vi.fn(),complete:completeRun} as never)
  expect(query).not.toHaveBeenCalled()
  expect(readSoftwareRunState(id)?.status).toBe('waiting_user')
  expect(persist).toHaveBeenCalledWith('session',expect.stringContaining('继续验收'))
})
it('starts only after user action, selects a device, records evidence and resumes the same candidate to publication',async()=>{
  expect(assistedAcceptanceView(id)?.phase).toBe('available')
  expect(speech.runHostSpeechProbe).not.toHaveBeenCalled()
  const state=await start()
  expect(state?.phase).toBe('ready')
  expect(hasRunForProject(id)).toBe(true)
  expect((await start())?.attempt_id).toBe(state?.attempt_id)
  expect(speech.runHostSpeechProbe).toHaveBeenCalledTimes(1)
  await expect(assistedAcceptanceAction({request_id:'bad',project_id:id,action:'capture',attempt_id:state!.attempt_id,device:9})).rejects.toThrow('NOT_READY')
  await assistedAcceptanceAction({request_id:'capture',project_id:id,action:'capture',attempt_id:state!.attempt_id,device:2})
  expect(JSON.parse(readFileSync(join(home,'assisted-acceptance',id,state!.attempt_id!,'capture.json'),'utf8'))).toEqual({device:2})
  complete(pass)
  await vi.waitFor(()=>expect(assistedAcceptanceView(id)?.phase).toBe('passed'))
  expect(speech.saveMicrophoneEvidence).toHaveBeenCalledTimes(1)
  expect(verification.verifySoftwareCandidate).toHaveBeenCalledWith(id,'start',expect.any(AbortSignal),true,candidate)
  expect(findProject(id).software_release_id).toBe(candidate.id)
  expect(hasRunForProject(id)).toBe(false)
})
it('cancellation releases ownership and cannot save success or publish',async()=>{
  const state=await start()
  await assistedAcceptanceAction({request_id:'cancel',project_id:id,action:'cancel',attempt_id:state!.attempt_id})
  expect(assistedAcceptanceView(id)?.phase).toBe('cancelled')
  expect(speech.saveMicrophoneEvidence).not.toHaveBeenCalled()
  expect(releases.promoteSoftwareRelease).not.toHaveBeenCalled()
  expect(hasRunForProject(id)).toBe(false)
})
it('rejects source changes during recording and retains remaining quality gates after successful recording',async()=>{
  await start();changes=true;complete(pass)
  await vi.waitFor(()=>expect(assistedAcceptanceView(id)?.phase).toBe('failed'))
  expect(speech.saveMicrophoneEvidence).not.toHaveBeenCalled()
  changes=false
  vi.mocked(quality.deliveryQualityGate).mockResolvedValue('QUALITY_REVIEW_REQUIRED')
  await assistedAcceptanceAction({request_id:'second',project_id:id,action:'start',candidate_id:candidate.id})
  complete(pass)
  await vi.waitFor(()=>expect(assistedAcceptanceView(id)?.phase).toBe('passed'))
  expect(assistedAcceptanceView(id)?.detail).toContain('QUALITY_REVIEW_REQUIRED')
  expect(releases.promoteSoftwareRelease).not.toHaveBeenCalled()
})
it('keeps the failed automatic comparison and accepts explicit feedback only for an observed, current attempt',async()=>{
  const state=await start()
  const observation={...pass,tests:[{passed:true},{passed:true},{passed:true}],microphone:{status:'failed',rms:.003,text:'嗯下周四下午3点开会。'}}
  complete(observation)
  await vi.waitFor(()=>expect(assistedAcceptanceView(id)?.phase).toBe('failed'))
  expect(assistedAcceptanceView(id)?.can_confirm).toBe(true)
  expect(speech.saveMicrophoneEvidence).not.toHaveBeenCalled()
  const input={request_id:'feedback',project_id:id,action:'feedback' as const,accepted:true,attempt_id:state!.attempt_id,candidate_id:candidate.id}
  await expect(assistedAcceptanceAction({...input,attempt_id:'old-attempt'})).rejects.toThrow('NOT_READY')
  await assistedAcceptanceAction(input)
  await vi.waitFor(()=>expect(assistedAcceptanceView(id)?.phase).toBe('passed'))
  await assistedAcceptanceAction(input)
  expect(verification.verifySoftwareCandidate).toHaveBeenCalledTimes(1)
  expect(speech.saveMicrophoneEvidence).toHaveBeenCalledWith(id,candidate.root,expect.any(Object),observation,{attempt_id:state!.attempt_id,candidate_id:candidate.id})
  expect(JSON.parse(readFileSync(join(home,'assisted-acceptance',id,state!.attempt_id!,'observations.json'),'utf8')).microphone.status).toBe('failed')
})
it('never lets user feedback substitute for a missing device or actual decoding',async()=>{
  const state=await start()
  complete({status:'environment_blocked',error:'no device',probe_version:1})
  await vi.waitFor(()=>expect(assistedAcceptanceView(id)?.phase).toBe('unavailable'))
  await expect(assistedAcceptanceAction({request_id:'feedback',project_id:id,action:'feedback',accepted:true,attempt_id:state!.attempt_id,candidate_id:candidate.id})).rejects.toThrow('NOT_READY')
  expect(speech.saveMicrophoneEvidence).not.toHaveBeenCalled()
})
