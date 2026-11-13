import {testCorrectionChanges} from '../../../main/software/test-corrections'
import {runAgentLoop} from '../../../main/agent/loop/agent-loop'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
import {testCorrectionRejectionFeedback} from '../../../main/software/test-corrections'
import {createProtocolFailureGuard,toolFailureKey} from '../../../main/agent/loop/work-progress'
import {formatToolFeedback} from '../../../shared/tool-feedback'
import {proposeTestTransaction,pendingTestCorrectionInputs,stageTestCorrectionCandidate} from '../../../main/software/test-corrections'
import {applyApprovedNativeCorrections} from '../../../main/software/native-gui-registration'
import {guiSuitePath} from '../../../main/desktop/gui-acceptance'
import {buildSoftwareVerifyTool} from '../../../main/software/verification-tool'
import {applyApprovedTestCorrections} from '../../../main/software/test-corrections'
import {reviewPendingTestCorrections} from '../../../main/software/test-correction-review'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {beforeEach,afterEach,expect,it} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {updateProject} from '../../../main/project/project-service'
import {createServer} from 'node:net'
import {readPrdBackplane,markPrdUserConfirmed} from '../../../main/project/prd-store'
import {syncDocuments} from '../../../main/project/document-sync'
import {parseLeanBrief} from '../../../main/guide/lean-brief'
import {prdScopeFingerprint} from '../../../main/project/requirement-contract'
import {freezeNativeGuiTests,nativeTestContractChanges,type NativeGuiTests} from '../../../main/software/native-gui-tests'
import {readProjectStages,verifyProjectStage} from '../../../main/software/project-stages'
import {registerNativeGuiTests} from '../../../main/software/native-gui-registration'
import {createQualityReview} from '../../../main/software/quality-review'
import {sealSoftwareRelease} from '../../../main/software/release-store'
import {proposeTestCorrection,decideTestCorrection,applyTestCorrection,filterApprovedTestChanges,pendingTestCorrection,readTestContractFile,testCorrectionView} from '../../../main/software/test-corrections'
import {buildTestCorrectionTools} from '../../../main/software/test-correction-tools'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {createToolState} from '../../../main/agent/loop/agent-loop'
let home:string,old:string|undefined,p:ReturnType<typeof createProject>,before:NativeGuiTests,original:string
// A timed-out Vitest callback is not automatically cancelled. Keep its own
// asynchronous work attached until it has stopped, before restoring HOME.
let activeFixtureWork:{controller:AbortController;pending:Promise<unknown>;settled:boolean}|undefined
function runScopedFixture<T>(body:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(activeFixtureWork)throw Error('PREVIOUS_FIXTURE_WORK_NOT_DRAINED')
  const controller=new AbortController(),record={controller,pending:Promise.resolve().then(()=>body(controller.signal)),settled:false}
  record.pending=record.pending.finally(()=>{record.settled=true})
  activeFixtureWork=record
  return record.pending
}
async function drainFixtureWork(){
  const record=activeFixtureWork;if(!record)return
  if(!record.settled)record.controller.abort(Error('FIXTURE_FINISHED'))
  // The returned test promise retains its original rejection. Teardown only
  // waits; it must not restart an operation or convert the test into a pass.
  await record.pending.catch(()=>{})
  if(activeFixtureWork===record)activeFixtureWork=undefined
}
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex')
beforeEach(()=>{
  if(activeFixtureWork)throw Error('PREVIOUS_FIXTURE_WORK_NOT_DRAINED')
  old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'test-correction-'));process.env.PROMA_HOME=home
  p=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'保留创建记录',ui:'required',delivery:'browser',requirements:[{description:'保留原记录',expected:'旧记录保留创建时信息'}]}),{projectId:p.project_id,sessionId:'s',source:'保留原记录',previous:readPrdBackplane(p.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture')
  syncDocuments({request_id:'scope',project_id:p.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(p.project_id)
  original=`export default async({test,page,expect})=>{await test('F-001 original record',async()=>{await page.click('#load');await expect(page.locator('#version')).toHaveText('current')})}`
  writeFileSync(join(p.root_path,'acceptance.mjs'),original)
  before=freezeNativeGuiTests(p.project_id,p.root_path,'acceptance.mjs',['F-001'])
  const state={version:1,revision:1,attempts:[{id:'old-failed',stage:'first',scope:prdScopeFingerprint(readPrdBackplane(p.project_id)),source:'old',status:'failed',executed:true,covers:['F-001'],native:before,at:'past'}]}
  const dir=join(home,'software-stage-checks',p.project_id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'state.json'),JSON.stringify({...state,checksum:sha(JSON.stringify(state))}))
})
afterEach(async()=>{
  const ownedHome=home,previousHome=old
  await drainFixtureWork()
  if(process.env.PROMA_HOME===ownedHome){if(previousHome===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previousHome}
  rmSync(ownedHome,{recursive:true,force:true})
})
it('aborts and drains owned fixture work before its temporary home can be removed',async()=>{
  const ownedHome=home;let stopped=false
  const operation=runScopedFixture(async signal=>{
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
    await new Promise(resolve=>setTimeout(resolve,25))
    expect(existsSync(ownedHome)).toBe(true);stopped=true
  })
  await new Promise(resolve=>setImmediate(resolve))
  await drainFixtureWork();await operation
  expect(stopped).toBe(true);expect(activeFixtureWork).toBeUndefined()
})
const proposal=()=>proposeTestCorrection(p.project_id,{contract_digest:before.digest,file:'acceptance.mjs',old_text:"toHaveText('current')",new_text:"toHaveText('created')",feature_ids:['F-001'],reason:'独立原始记录显示创建时值，当前值不是需求预期'})
function decision(id:string){const evidence=join(home,'independent.json');writeFileSync(evidence,'{"observed":"created","original_assertion":"current"}');return{verdict:'approve' as const,reviewer:'independent_operator' as const,reason:'核对确认需求和独立原始记录后裁定',expected_sources:{'F-001':'旧记录保留创建时信息'},evidence:[{path:evidence,sha256:sha(readFileSync(evidence))}]}}
it('adjudicates with isolated frozen inputs, preserves failure, and leaves application to the existing host',async()=>{
  proposal();let calls=0
  const query:import('../../../main/orchestration/stages/orchestration-contracts').SDKQuery=async function*(prompt,options){
    calls++;const packet=JSON.parse(prompt)
    expect(packet.proposal.before.text).toBe(original)
    expect(packet.proposal.after.text).toContain("toHaveText('created')")
    expect(options.sessionId).toContain('-test-review-')
    expect(options.history?.length??0).toBeLessThanOrEqual(1)
    yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({verdict:'approve',reason:'确认预期要求保留创建时信息，旧断言检查当前值不符',assessment:[{feature:'F-001',preserved:true,reason:'仍然实际加载原记录并断言创建时值'}]})}]}}
  }
  const input={projectId:p.project_id,sessionId:'maker',query,env:{},maxTokens:8192,signal:new AbortController().signal}
  await reviewPendingTestCorrections(input);await reviewPendingTestCorrections(input)
  expect(calls).toBe(1);expect(pendingTestCorrection(p.project_id)).toBe(false)
  expect(testCorrectionView(p.project_id).proposals[0].decision?.reviewer).toBe('independent_model')
  expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toBe(original)
  expect(readProjectStages(p.project_id).attempts[0].status).toBe('failed')
  applyApprovedTestCorrections(p.project_id)
  expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toContain("toHaveText('created')")
})
it.each(['defer','invalid','approve-with-false','reject'])('fails closed or preserves rejection for %s without retrying the review',async mode=>{
  proposal();let calls=0
  const query:import('../../../main/orchestration/stages/orchestration-contracts').SDKQuery=async function*(){calls++;yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:mode==='invalid'?'invalid':JSON.stringify({verdict:mode==='approve-with-false'?'approve':mode,reason:'证据不足或违反业务预期',assessment:[{feature:'F-001',preserved:false,reason:'操作可达性未证实'}]})}]}}}
  const action=reviewPendingTestCorrections({projectId:p.project_id,sessionId:'maker',query,env:{},maxTokens:8192,signal:new AbortController().signal})
  if(mode==='reject'){await action;expect(testCorrectionView(p.project_id).proposals[0].status).toBe('rejected')}
  else{await expect(action).rejects.toThrow('TEST_CORRECTION_REVIEW_REQUIRED');expect(pendingTestCorrection(p.project_id)).toBe(true)}
  expect(calls).toBe(1);expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toBe(original)
})
it('preserves the original failure and archive; only exact independently approved bytes may pass contract admission',()=>{
  const a=proposal();expect(pendingTestCorrection(p.project_id)).toBe(true)
  expect(()=>applyTestCorrection(p.project_id,a.id)).toThrow('NOT_APPROVED')
  expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toBe(original)
  const forged={...decision(a.id),reviewer:'maker'} as never
  expect(()=>decideTestCorrection(p.project_id,a.id,forged)).toThrow('INDEPENDENT_EVIDENCE')
  decideTestCorrection(p.project_id,a.id,decision(a.id));expect(pendingTestCorrection(p.project_id)).toBe(false)
  expect(applyTestCorrection(p.project_id,a.id).verification).toBe('not_issued')
  const after=freezeNativeGuiTests(p.project_id,p.root_path,'acceptance.mjs',['F-001'])
  expect(nativeTestContractChanges(before,after).length).toBeGreaterThan(0)
  expect(filterApprovedTestChanges(p.project_id,before,after,nativeTestContractChanges(before,after))).toEqual([])
  expect(readProjectStages(p.project_id).attempts[0].status).toBe('failed')
  expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
  writeFileSync(join(p.root_path,'acceptance.mjs'),original.replace("'current'","'anything'"))
  const other=freezeNativeGuiTests(p.project_id,p.root_path,'acceptance.mjs',['F-001'])
  expect(filterApprovedTestChanges(p.project_id,before,other,nativeTestContractChanges(before,other)).length).toBeGreaterThan(0)
})
it('makes a registered contract readable and reviewable before execution without permitting unchecked edits',()=>{
  rmSync(join(home,'software-stage-checks',p.project_id,'state.json'))
  const scope=prdScopeFingerprint(readPrdBackplane(p.project_id));updateProject(p.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  before=registerNativeGuiTests(p.project_id,'acceptance.mjs').native_tests!
  expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
  expect(testCorrectionView(p.project_id).contracts[0]).toMatchObject({origin:'registered_formal',execution:'not_observed'})
  expect(()=>readTestContractFile(p.project_id,'0'.repeat(64),'acceptance.mjs')).toThrow('NOT_REGISTERED')
  writeFileSync(join(p.root_path,'acceptance.mjs'),original.replace("toHaveText('current')","toHaveText('wrong')"))
  expect(()=>registerNativeGuiTests(p.project_id,'acceptance.mjs')).toThrow('GUI_EXISTING_EXPECTATIONS_CHANGED')
  const proposed=proposal();expect(()=>applyTestCorrection(p.project_id,proposed.id)).toThrow('NOT_APPROVED')
  expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
})
it('keeps frozen contract inspection available during review while mutations stay blocked',async()=>{
  const policy=createSoftwareCollaborationPolicy(p.project_id,p.root_path,'s'),tools=buildTestCorrectionTools(p.project_id,policy),release=policy.freezeReview()
  const ctx={projectId:p.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  try{
    const result=await tools.find(t=>t.name==='read_test_contract')!.execute({contract_digest:before.digest,file:'acceptance.mjs'},ctx)
    expect(result.isError).not.toBe(true);expect(JSON.parse(result.output).text).toBe(original)
    expect((await tools.find(t=>t.name==='apply_test_correction')!.execute({proposal_id:'none'},ctx)).isError).toBe(true)
    expect((await tools.find(t=>t.name==='read_test_contract')!.execute({}, {...ctx,sessionId:'foreign'})).isError).toBe(true)
  }finally{release()}
})
it('rejects changed evidence, altered scope, working-file interference and corrupted decisions',()=>{
  const a=proposal(),d=decision(a.id);decideTestCorrection(p.project_id,a.id,d)
  writeFileSync(join(p.root_path,'acceptance.mjs'),original+'\n// independent edit')
  expect(()=>applyTestCorrection(p.project_id,a.id)).toThrow('WORKING_BYTES_CHANGED')
  writeFileSync(d.evidence[0].path,'changed')
  expect(()=>applyTestCorrection(p.project_id,a.id)).toThrow('EVIDENCE_CHANGED')
  writeFileSync(join(home,'software-test-corrections',p.project_id,'state.json'),'{broken')
  expect(()=>pendingTestCorrection(p.project_id)).toThrow()
})
it('maker tools have no approval route and reject forged reviewer fields',async()=>{
  const tools=buildTestCorrectionTools(p.project_id,createSoftwareCollaborationPolicy(p.project_id,p.root_path,'s'))
  expect(tools.map(t=>t.name)).toEqual(['read_test_contract','propose_test_correction','apply_test_correction'])
  const ctx={projectId:p.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  expect((await tools[1].execute({reviewer:'independent_operator',verdict:'approve'},ctx)).isError).toBe(true)
  expect((await tools[0].execute({},{...ctx,projectId:'foreign'})).isError).toBe(true)
  expect(()=>proposeTestCorrection(p.project_id,{contract_digest:before.digest,file:'../outside',old_text:'x',new_text:'y',feature_ids:['F-001'],reason:'x'})).toThrow('FILE_NOT_IN_CONTRACT')
  const view=JSON.parse((await tools[0].execute({},ctx)).output)
  expect(view.contracts).toEqual([expect.objectContaining({origin:'executed_stage',contract_digest:before.digest,entry:'acceptance.mjs'})])
  const item=view.contracts[0]
  expect(JSON.parse((await tools[0].execute({contract_digest:item.contract_digest,file:item.entry},ctx)).output).text).toBe(original)
  const state=readProjectStages(p.project_id);state.attempts[0].executed=false
  writeFileSync(join(home,'software-stage-checks',p.project_id,'state.json'),JSON.stringify({...state,checksum:sha(JSON.stringify(state))}))
  expect(testCorrectionView(p.project_id).contracts).toEqual([expect.objectContaining({origin:'registered_stage',execution:'not_started',contract_digest:before.digest})])
})
it('rejects case removal and undeclared features without altering the original test or creating a pending approval',()=>{
  expect(()=>proposeTestCorrection(p.project_id,{contract_digest:before.digest,file:'acceptance.mjs',old_text:original,new_text:'export default async()=>{}',feature_ids:['F-001'],reason:'remove failing test'})).toThrow()
  expect(()=>proposeTestCorrection(p.project_id,{contract_digest:before.digest,file:'acceptance.mjs',old_text:"'current'",new_text:"'created'",feature_ids:['F-999'],reason:'unknown feature'})).toThrow('PROPOSAL_INVALID')
  expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toBe(original)
  expect(pendingTestCorrection(p.project_id)).toBe(false)
})
it('composes sequential exact approvals while still checking every original retained contract',()=>{
  const first=proposal();decideTestCorrection(p.project_id,first.id,decision(first.id));applyTestCorrection(p.project_id,first.id)
  const intermediate=freezeNativeGuiTests(p.project_id,p.root_path,'acceptance.mjs',['F-001'])
  const state=readProjectStages(p.project_id);state.revision++;state.attempts.push({...state.attempts[0],id:'intermediate',native:intermediate})
  writeFileSync(join(home,'software-stage-checks',p.project_id,'state.json'),JSON.stringify({...state,checksum:sha(JSON.stringify(state))}))
  const second=proposeTestCorrection(p.project_id,{contract_digest:intermediate.digest,file:'acceptance.mjs',old_text:"page.locator('#version')",new_text:"page.locator('#record-version')",feature_ids:['F-001'],reason:'独立核对后的精确定位修订，原创建值断言保持'})
  decideTestCorrection(p.project_id,second.id,decision(second.id));applyTestCorrection(p.project_id,second.id)
  const after=freezeNativeGuiTests(p.project_id,p.root_path,'acceptance.mjs',['F-001'])
  expect(filterApprovedTestChanges(p.project_id,before,after,nativeTestContractChanges(before,after))).toEqual([])
  expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
})
it('pending disputes stop another parent model call, and a rejected decision permits diagnosis without authorizing an edit',async()=>{
  const a=proposal(),quality=createQualityReview(p.project_id,'s',createSoftwareCollaborationPolicy(p.project_id,p.root_path,'s'));let calls=0
  const query=quality.wrapQuery(async function*(){calls++;yield{type:'result' as const,subtype:'success' as const}})
  const run=async()=>{for await(const _ of query('continue',{env:{},sessionId:'s',signal:new AbortController().signal})){} }
  await expect(run()).rejects.toThrow('TEST_CORRECTION_REVIEW_REQUIRED');expect(calls).toBe(0)
  decideTestCorrection(p.project_id,a.id,{...decision(a.id),verdict:'reject'})
  await run();expect(calls).toBe(1);expect(()=>applyTestCorrection(p.project_id,a.id)).toThrow('NOT_APPROVED')
})
it('blocks publication while pending or approved-but-unapplied and rejects a decision after scope changes',async()=>{
  const a=proposal()
  await expect(sealSoftwareRelease({projectId:p.project_id} as never,{} as never)).rejects.toThrow('TEST_CORRECTION_REVIEW_REQUIRED')
  decideTestCorrection(p.project_id,a.id,decision(a.id))
  await expect(sealSoftwareRelease({projectId:p.project_id} as never,{} as never)).rejects.toThrow('TEST_CORRECTION_APPLY_REQUIRED')
  const changed=readPrdBackplane(p.project_id);changed.constraints=[...(changed.constraints??[]),'新增已确认边界']
  syncDocuments({request_id:'change',project_id:p.project_id,session_id:'s',checkpoint:'requirement_confirmed'},changed);markPrdUserConfirmed(p.project_id)
  expect(()=>applyTestCorrection(p.project_id,a.id)).toThrow('NOT_APPROVED')
})
it('real browser: failed frozen expectation is retained, independently corrected, and must actually pass a new stage run',async()=>runScopedFixture(async signal=>{
  const started=performance.now(),events:Array<{phase:string;at_ms:number;event:string}>=[]
  let currentPhase='setup',failure:string|undefined
  const phase=async<T>(name:string,body:()=>Promise<T>)=>{
    signal.throwIfAborted();currentPhase=name;events.push({phase:name,at_ms:performance.now()-started,event:'start'})
    try{const result=await body();signal.throwIfAborted();events.push({phase:name,at_ms:performance.now()-started,event:'end'});return result}
    catch(error){events.push({phase:name,at_ms:performance.now()-started,event:'error'});throw error}
  }
  const frozenOriginal=original
  try{
  // A different project has no fabricated stage history; exercise the real path.
  const project=createProject({request_id:'browser',mode:'longterm'},{workflowVersion:'software-v1'}),id=project.project_id
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'载入已创建记录',ui:'required',delivery:'browser',requirements:[{description:'载入记录',expected:'载入后显示created'}],project_plan:{version:1,current:'first',stages:[{id:'first',title:'载入',feature_ids:['F-001']}]}}),{projectId:id,sessionId:'s',source:'载入后显示created',previous:readPrdBackplane(id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip'
  syncDocuments({request_id:'confirm',project_id:id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const brief=markPrdUserConfirmed(id)!,scope=prdScopeFingerprint(brief);updateProject(id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
  writeFileSync(join(project.root_path,'server.cjs'),`require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<button id="load" onclick="document.getElementById(\\'version\\').textContent=\\'created\\'">Load</button><p id="version"></p>')}).listen(${port},'127.0.0.1')`)
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs'],url:`http://127.0.0.1:${port}`}))
  writeFileSync(join(project.root_path,'acceptance.mjs'),frozenOriginal)
  const failed=await phase('initial_wrong_stage',()=>verifyProjectStage(id,'first','acceptance.mjs',signal))
  expect(failed.status).toBe('failed');expect(failed.feedback.scope).toBe('partial_cumulative_gui')
  const oldAttempt=readProjectStages(id).attempts[0],serverBefore=readFileSync(join(project.root_path,'server.cjs'),'utf8')
  registerNativeGuiTests(id,'acceptance.mjs')
  const a=proposeTestCorrection(id,{contract_digest:oldAttempt.native.digest,file:'acceptance.mjs',old_text:"toHaveText('current')",new_text:"toHaveText('created')",feature_ids:['F-001'],reason:'确认预期为created，失败证据实际也是created，current不符来源'})
  const workingEdit=frozenOriginal.replace("toHaveText('current')","toHaveText('unfinished')")
  writeFileSync(join(project.root_path,'acceptance.mjs'),workingEdit)
  const reviewQuery:import('../../../main/orchestration/stages/orchestration-contracts').SDKQuery=async function*(prompt){
    const packet=JSON.parse(prompt)
    expect(packet.proposed_execution).toMatchObject({product_verified:false,source_unchanged:true,result:{status:'passed'}})
    expect(packet).toHaveProperty('baseline_execution')
    expect(packet).not.toHaveProperty('execution')
    expect(readFileSync(join(project.root_path,'acceptance.mjs'),'utf8')).toBe(workingEdit)
    expect(readProjectStages(id).attempts.map(a=>a.status)).toEqual(['failed'])
    yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({verdict:'approve',reason:'对照确认预期和独立隔离执行',assessment:[{feature:'F-001',preserved:true,reason:'实际加载并检查创建时值，旧失败保留'}]})}]}}
  }
  await phase('review_corrected_proposal',()=>reviewPendingTestCorrections({projectId:id,sessionId:'s',query:reviewQuery,env:{},maxTokens:8192,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])}))
  expect(testCorrectionView(id).proposals.find(row=>row.id===a.id)?.status).toBe('approved')
  expect(()=>applyApprovedTestCorrections(id)).toThrow('WORKING_BYTES_CHANGED')
  expect(readFileSync(join(project.root_path,'acceptance.mjs'),'utf8')).toBe(workingEdit)
  writeFileSync(join(project.root_path,'acceptance.mjs'),frozenOriginal)
  await phase('apply_and_host_verify',()=>buildSoftwareVerifyTool(id,createSoftwareCollaborationPolicy(id,project.root_path,'s')).execute({},{projectId:id,sessionId:'s',requestId:'approved-recovery',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),state:createToolState()}))
  expect(readFileSync(join(project.root_path,'acceptance.mjs'),'utf8')).toContain("toHaveText('created')")
  expect(readProjectStages(id).attempts[0].status).toBe('failed')
  expect((await phase('new_correct_stage',()=>verifyProjectStage(id,'first','acceptance.mjs',signal))).status).toBe('passed')
  expect(readProjectStages(id).attempts.map(a=>a.status)).toEqual(['failed','passed'])
  expect(readFileSync(join(project.root_path,'server.cjs'),'utf8')).toBe(serverBefore)
  expect(registerNativeGuiTests(id,'acceptance.mjs').covers).toEqual(['F-001'])
  currentPhase='done'
  }catch(error){failure=String(error).slice(0,1200);throw error}
  finally{
    const report=process.env.CORRECTION_PHASE_REPORT
    if(report)try{writeFileSync(report,JSON.stringify({elapsed_ms:performance.now()-started,phase:currentPhase,aborted:signal.aborted,error:failure,events},null,2))}catch(error){console.error('CORRECTION_PHASE_REPORT_FAILED',String(error))}
  }
}),90000)

it('host applies approved corrections once, while pending decisions and working conflicts remain blocked',()=>{
 const a=proposal();expect(()=>applyApprovedTestCorrections(p.project_id)).toThrow('REVIEW_REQUIRED')
 expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toBe(original)
 decideTestCorrection(p.project_id,a.id,decision(a.id))
 writeFileSync(join(p.root_path,'acceptance.mjs'),original+'\n// conflicting edit')
 expect(()=>applyApprovedTestCorrections(p.project_id)).toThrow('WORKING_BYTES_CHANGED')
 writeFileSync(join(p.root_path,'acceptance.mjs'),original)
 expect(applyApprovedTestCorrections(p.project_id)).toBe(1)
 expect(applyApprovedTestCorrections(p.project_id)).toBe(0)
 expect(readFileSync(join(p.root_path,'acceptance.mjs'),'utf8')).toContain("toHaveText('created')")
 expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
})

it('host resumes a correction applied before formal binding refresh without repeating application',()=>{
 const scope=prdScopeFingerprint(readPrdBackplane(p.project_id));updateProject(p.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
 const oldSuite=registerNativeGuiTests(p.project_id,'acceptance.mjs')
 const a=proposal();decideTestCorrection(p.project_id,a.id,decision(a.id));applyTestCorrection(p.project_id,a.id)
 expect(JSON.parse(readFileSync(guiSuitePath(p.project_id),'utf8')).native_tests.digest).toBe(oldSuite.native_tests!.digest)
 expect(applyApprovedNativeCorrections(p.project_id)).toBe(true)
 expect(JSON.parse(readFileSync(guiSuitePath(p.project_id),'utf8')).native_tests.digest).not.toBe(oldSuite.native_tests!.digest)
 expect(applyApprovedNativeCorrections(p.project_id)).toBe(false)
 expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
})

it('seals a large multi-file candidate, stages exact resources and rejects conflicting edits atomically',()=>{
  const root=p.root_path, entry=join(root,'acceptance.mjs')
  const proposed="import {helper} from './helper.mjs';\n"+original.replace("await page.click('#load');","helper();await page.click('#load');")+'\n/*'+ 'large-script '.repeat(4000)+'*/'
  writeFileSync(entry,proposed);writeFileSync(join(root,'helper.mjs'),'export const helper=()=>42')
  writeFileSync(join(root,'native-inputs.json'),JSON.stringify({files:['fixture.txt']}));writeFileSync(join(root,'fixture.txt'),'frozen fixture')
  const result=proposeTestTransaction(p.project_id,{contract_digest:before.digest,script:'acceptance.mjs',reason:'修复共享辅助调用并补充必要输入，不改业务断言'})
  const pending=pendingTestCorrectionInputs(p.project_id)[0]
  expect(pending.files!.after.map(f=>f.file)).toEqual(['fixture.txt','helper.mjs','native-inputs.json'])
  expect(pending.after.text.length).toBeGreaterThan(42000)
  writeFileSync(join(root,'fixture.txt'),'conflicting later edit')
  const probe=join(home,'isolated-probe');mkdirSync(probe)
  stageTestCorrectionCandidate(p.project_id,pending.native,probe)
  expect(readFileSync(join(probe,'fixture.txt'),'utf8')).toBe('frozen fixture')
  expect(readFileSync(join(probe,'acceptance.mjs'),'utf8')).toBe(proposed)
  decideTestCorrection(p.project_id,result.id,decision(result.id))
  writeFileSync(entry,original)
  expect(()=>applyTestCorrection(p.project_id,result.id)).toThrow('WORKING_BYTES_CHANGED')
  expect(readFileSync(entry,'utf8')).toBe(original)
  writeFileSync(join(root,'fixture.txt'),'frozen fixture')
  applyTestCorrection(p.project_id,result.id)
  const after=freezeNativeGuiTests(p.project_id,root,'acceptance.mjs',['F-001'])
  expect(after.digest).toBe(pending.native.digest)
  expect(filterApprovedTestChanges(p.project_id,before,after,nativeTestContractChanges(before,after))).toEqual([])
  expect(readProjectStages(p.project_id).attempts[0].status).toBe('failed')
  expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
})
it('rejects stale working versions and replacing the registered entry',()=>{
  writeFileSync(join(p.root_path,'acceptance.mjs'),original+'\n// repaired')
  expect(()=>proposeTestTransaction(p.project_id,{contract_digest:before.digest,script:'acceptance.mjs',working_digest:before.digest,reason:'repair'})).toThrow('WORKING_BYTES_CHANGED')
  expect(()=>proposeTestTransaction(p.project_id,{contract_digest:before.digest,script:'different.mjs',reason:'replace'})).toThrow('PROPOSAL_INVALID')
})

it('approves a helper-only repair that exposes a product failure, retains the failure and never issues product PASS',async()=>{
 const project=createProject({request_id:'product-failure',mode:'longterm'},{workflowVersion:'software-v1'}),id=project.project_id,root=project.root_path
 const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'载入记录',ui:'required',delivery:'browser',requirements:[{description:'载入记录',expected:'载入后显示current'}],project_plan:{version:1,current:'first',stages:[{id:'first',title:'载入',feature_ids:['F-001']}]}}),{projectId:id,sessionId:'s',source:'载入后显示current',previous:readPrdBackplane(id),software:true})!
 if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip'
 syncDocuments({request_id:'confirm',project_id:id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
 const brief=markPrdUserConfirmed(id)!,scope=prdScopeFingerprint(brief);updateProject(id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
 writeFileSync(join(root,'server.cjs'),`require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<button id="load">Load</button><p id="version">wrong product value</p>')}).listen(${port},'127.0.0.1')`)
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs'],url:`http://127.0.0.1:${port}`}))
 writeFileSync(join(root,'helper.mjs'),`export const prepare=()=>{throw Error('broken test helper')}`)
 writeFileSync(join(root,'acceptance.mjs'),"import {prepare} from './helper.mjs';\n"+original.replace("await page.click('#load');","prepare();await page.click('#load');"))
 const first=await verifyProjectStage(id,'first','acceptance.mjs',AbortSignal.timeout(60000));expect(first.status).not.toBe('passed')
 const baseline=readProjectStages(id).attempts[0]
 writeFileSync(join(root,'helper.mjs'),'export const prepare=()=>{}')
 const proposed=proposeTestTransaction(id,{contract_digest:baseline.native.digest,script:'acceptance.mjs',reason:'修复测试助手抛错；保留原业务输入和断言'})
 const query:import('../../../main/orchestration/stages/orchestration-contracts').SDKQuery=async function*(prompt){const packet=JSON.parse(prompt)
   expect(packet.proposed_execution).toMatchObject({product_verified:false,result:{status:'failed',failure_kind:'assertion'}})
   yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({verdict:'approve',reason:'助手修正保持原契约；实际断言仍揭示产品失败，不能发布',assessment:[{feature:'F-001',preserved:true,reason:'原加载行为和current断言未变'}]})}]}}
 }
 await reviewPendingTestCorrections({projectId:id,sessionId:'s',query,env:{},maxTokens:8192,signal:AbortSignal.timeout(60000)})
 expect(testCorrectionView(id).proposals.find(row=>row.id===proposed.id)?.status).toBe('approved')
 applyApprovedTestCorrections(id)
 const result=await verifyProjectStage(id,'first','acceptance.mjs',AbortSignal.timeout(60000))
 expect(result.status).toBe('failed');expect(readProjectStages(id).attempts[0].status).toBe(first.status)
 const changes=testCorrectionChanges(id,true)
 expect(changes).toEqual([expect.objectContaining({cases:[{name:'F-001 original record',feature:'F-001',body:'unchanged'}],files:[{file:'helper.mjs',change:'changed',shared_input_changed:true}],verification:'not_issued'})])
 expect((await import('../../../main/project/project-service')).findProject(id).software_release_id).toBeUndefined()
},180000)

it('delivers candidate-bound security locations to the independent correction reviewer',async()=>runScopedFixture(async signal=>{
 writeFileSync(join(p.root_path,'server.cjs'),"require('http').createServer((q,s)=>s.end('fixture')).listen(17899,'127.0.0.1')")
 writeFileSync(join(p.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs'],url:'http://127.0.0.1:17899'}))
 writeFileSync(join(p.root_path,'unsafe.cjs'),"const {exec}=require('node:child_process');\nexec(process.argv[2]);\n")
 const proposed=proposeTestCorrection(p.project_id,{contract_digest:before.digest,file:'acceptance.mjs',old_text:"toHaveText('current')",new_text:"toHaveText('created')",feature_ids:['F-001'],reason:'Correct expected historical value'})
 let reviewed=false
 const query:import('../../../main/orchestration/stages/orchestration-contracts').SDKQuery=async function*(prompt){
   const packet=JSON.parse(prompt),probe=packet.proposed_execution
   expect(probe).toMatchObject({proposal:proposed.id,product_verified:false,source_unchanged:true,result:{status:'unverified',execution:'not_started',error:'TEST_CORRECTION_PROBE_SECURITY_FAILED',security:{passed:false}}})
   expect(probe.candidate).toBeTruthy();expect(probe.source).toBeTruthy()
   expect(probe.result.security.issues).toEqual(expect.arrayContaining([expect.objectContaining({file:'unsafe.cjs',line:2,category:'dangerous_execution'})]))
   reviewed=true
   yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({verdict:'reject',reason:'unsafe.cjs:2 prevents isolated execution',assessment:[{feature:'F-001',preserved:false,reason:'Changed path has not executed'}]})}]}}
 }
 await reviewPendingTestCorrections({projectId:p.project_id,sessionId:'s',query,env:{},maxTokens:8192,signal})
 expect(reviewed).toBe(true)
 expect(testCorrectionView(p.project_id).proposals.find(row=>row.id===proposed.id)?.status).toBe('rejected')
}),60000)
it('feeds rejected semantic corrections into the existing guard despite unrelated successful writes',()=>{
 const a=proposal();decideTestCorrection(p.project_id,a.id,{...decision(a.id),verdict:'reject'})
 const feedback=testCorrectionRejectionFeedback(p.project_id)!,guard=createProtocolFailureGuard()
 const call={name:'__host_after_tools_verification',turn:1,status:'error' as const,failureKey:toolFailureKey('host',formatToolFeedback(feedback,''))}
 expect(guard([call])).toBeUndefined();expect(guard([{name:'write_file',turn:2,status:'ok'}])).toBeUndefined()
 expect(guard([call])).toBeUndefined();expect(guard([call])).toMatchObject({count:3})
})
it('makes a pending complete candidate readable without treating it as an approved baseline',()=>{
 writeFileSync(join(p.root_path,'acceptance.mjs'),original+'\n// candidate')
 const a=proposeTestTransaction(p.project_id,{contract_digest:before.digest,script:'acceptance.mjs',reason:'prepare correction'})
 const candidate=pendingTestCorrectionInputs(p.project_id)[0]
 expect(readTestContractFile(p.project_id,candidate.native.digest,'acceptance.mjs').text).toContain('// candidate')
 expect(()=>proposeTestTransaction(p.project_id,{contract_digest:candidate.native.digest,script:'acceptance.mjs',reason:'unapproved baseline'})).toThrow('NOT_REGISTERED')
 expect(()=>applyTestCorrection(p.project_id,a.id)).toThrow('NOT_APPROVED')
})

it('removes a document from frozen inputs without deleting or overwriting the current product document',()=>{
 const root=p.root_path,stateFile=join(home,'software-stage-checks',p.project_id,'state.json')
 writeFileSync(join(root,'README.md'),'old product document');writeFileSync(join(root,'native-inputs.json'),JSON.stringify({files:['README.md']}))
 before=freezeNativeGuiTests(p.project_id,root,'acceptance.mjs',['F-001'])
 const {checksum,...state}=JSON.parse(readFileSync(stateFile,'utf8'));state.attempts[0].native=before;writeFileSync(stateFile,JSON.stringify({...state,checksum:sha(JSON.stringify(state))}))
 writeFileSync(join(root,'README.md'),'current product document');writeFileSync(join(root,'native-inputs.json'),JSON.stringify({files:[]}))
 const a=proposeTestTransaction(p.project_id,{contract_digest:before.digest,script:'acceptance.mjs',reason:'产品文档从当前候选读取，不再当冻结测试夹具'})
 decideTestCorrection(p.project_id,a.id,decision(a.id));applyTestCorrection(p.project_id,a.id)
 expect(readFileSync(join(root,'README.md'),'utf8')).toBe('current product document')
 expect(readTestContractFile(p.project_id,before.digest,'README.md').text).toBe('old product document')
})
it('publishes approved binary resources through the shared atomic file writer',()=>{
 const root=p.root_path,bytes=Buffer.from([0,255,9,42])
 writeFileSync(join(root,'binary.fixture'),bytes);writeFileSync(join(root,'native-inputs.json'),JSON.stringify({files:['binary.fixture']}))
 const a=proposeTestTransaction(p.project_id,{contract_digest:before.digest,script:'acceptance.mjs',reason:'补齐冻结二进制输入，不改业务案例'})
 decideTestCorrection(p.project_id,a.id,decision(a.id));rmSync(join(root,'binary.fixture'));applyTestCorrection(p.project_id,a.id)
 expect(readFileSync(join(root,'binary.fixture')).equals(bytes)).toBe(true)
})

it('a real Pi session submits two edited files as one complete correction without a manual patch protocol',async()=>{
 const policy=createSoftwareCollaborationPolicy(p.project_id,p.root_path,'s'),tools=buildSoftwareAgentTools(p.project_id,'parent',policy),observed:string[]=[],outputs:string[]=[];let calls=0
 const query:import('../../../main/orchestration/stages/orchestration-contracts').SDKQuery=async function*(){
  calls++
  const content:any[]=calls===1?[
   {type:'tool_use',id:'read',name:'read_file',input:{path:'acceptance.mjs'}},
   {type:'tool_use',id:'helper',name:'write_file',input:{path:'helper.mjs',content:'export const helper=()=>42'}},
   {type:'tool_use',id:'entry',name:'write_file',input:{path:'acceptance.mjs',content:"import {helper} from './helper.mjs';\n"+original.replace("await page.click('#load');","helper();await page.click('#load');")}}
  ]:calls===2?[{type:'tool_use',id:'proposal',name:'propose_test_correction',input:{contract_digest:before.digest,script:'acceptance.mjs',reason:'修复共享助手，保留案例和原断言'}}]:[{type:'text',text:'已提交完整候选，等待独立裁定。'}]
  yield{type:'assistant',message:{role:'assistant',content}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
 }
 const result=await runAgentLoop({projectId:p.project_id,sessionId:'s',requestId:'complete-candidate',runtimeScope:'desktop-implement',system:'受控离线工程回归',task:'修复测试助手并提交完整候选，保留原断言。',tools,query,env:{},maxTokens:2048,maxTurns:5,permissionMode:'allow-all',signal:AbortSignal.timeout(60000),publish:()=>{},onToolObservation:e=>{if(e.phase==='completed'){observed.push(e.name);outputs.push(String(e.output))}}})
 expect(result.status).toBe('completed');expect(observed).toEqual(['read_file','write_file','write_file','propose_test_correction'])
 const candidates=pendingTestCorrectionInputs(p.project_id);expect(candidates,JSON.stringify(outputs)).toHaveLength(1);expect(candidates[0].native.files.map(f=>f.path)).toEqual(['acceptance.mjs','helper.mjs'])
 expect(readTestContractFile(p.project_id,before.digest,'acceptance.mjs').text).toBe(original)
},90000)


it('projects only applied independently approved test deltas without granting binding or PASS',()=>{
 const a=proposal()
 expect(testCorrectionChanges(p.project_id,true)).toEqual([])
 decideTestCorrection(p.project_id,a.id,decision(a.id))
 expect(testCorrectionChanges(p.project_id,true)).toEqual([])
 applyTestCorrection(p.project_id,a.id)
 const current=freezeNativeGuiTests(p.project_id,p.root_path,'acceptance.mjs',['F-001'])
 const state=readProjectStages(p.project_id);state.attempts.push({...state.attempts[0],id:'current-registration',native:current})
 writeFileSync(join(home,'software-stage-checks',p.project_id,'state.json'),JSON.stringify({...state,checksum:sha(JSON.stringify(state))}))
 expect(testCorrectionChanges(p.project_id)).toEqual([]) // not the formal suite yet
 expect(testCorrectionChanges(p.project_id,true)).toEqual([expect.objectContaining({id:a.id,before:before.digest,after:current.digest,
  cases:[{name:'F-001 original record',feature:'F-001',body:'changed'}],verification:'not_issued'})])
 expect(readProjectStages(p.project_id).attempts[0].status).toBe('failed')
})

it('real browser: weak text checks accept stale rewrite, strengthened approved checks reject it and pass only the repaired journey',async()=>{
 const project=createProject({request_id:'rewrite-replay',mode:'longterm'},{workflowVersion:'software-v1'}),id=project.project_id,root=project.root_path
 const expected='第二次内容被拒绝后正文和保存状态均回退规则模式，不保留上一轮改写'
 const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'拒绝改写后回退规则',ui:'required',delivery:'browser',requirements:[{description:'拒绝后清除旧改写',expected}],project_plan:{version:1,current:'first',stages:[{id:'first',title:'连续改写',feature_ids:['F-001']}]}}),{projectId:id,sessionId:'s',source:expected,previous:readPrdBackplane(id),software:true})!
 if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip'
 syncDocuments({request_id:'confirm',project_id:id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
 const brief=markPrdUserConfirmed(id)!,scope=prdScopeFingerprint(brief);updateProject(id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
 const server=(fixed:boolean)=>{
  const html=`<button id="rewrite">Rewrite</button><p id="reply"></p><p id="status"></p><script>let calls=0;let reply={text:'能申请什么：规则原文。依据：知识库',state:'ready',engine:'rules'};document.getElementById('rewrite').onclick=()=>{if(++calls===1)reply={text:'能申请什么：模型专有措辞。依据：知识库',state:'rewritten',engine:'model'};else{reply.state='rejected';if(${fixed}){reply.text='能申请什么：规则原文。依据：知识库';reply.engine='rules'}}localStorage.setItem('reply',JSON.stringify(reply));document.getElementById('reply').textContent=reply.text;document.getElementById('status').textContent=reply.state}</script>`
  return `require('http').createServer((q,s)=>{s.setHeader('content-type','text/html; charset=utf-8');s.end(${JSON.stringify(html)})}).listen(${port},'127.0.0.1')`
 }
 writeFileSync(join(root,'server.cjs'),server(false))
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs'],url:`http://127.0.0.1:${port}`}))
 const weak=`export default async({test,page,expect})=>{await test('F-001 rejection clears prior rewrite',async()=>{await page.click('#rewrite');await expect(page.locator('#reply')).toContainText('模型专有措辞');await page.click('#rewrite');await expect(page.locator('#status')).toHaveText('rejected');await expect(page.locator('#reply')).toContainText('能申请什么');await expect(page.locator('#reply')).toContainText('依据：知识库')})}`
 writeFileSync(join(root,'acceptance.mjs'),weak)
 expect((await verifyProjectStage(id,'first','acceptance.mjs',AbortSignal.timeout(60000))).status).toBe('passed')
 const baseline=readProjectStages(id).attempts[0];registerNativeGuiTests(id,'acceptance.mjs')
 const oldText="await expect(page.locator('#reply')).toContainText('依据：知识库')"
 const added=oldText+";await expect(page.locator('#reply')).not.toContainText('模型专有措辞');await expect(page.locator('#reply')).toContainText('规则原文');const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('reply')));expect(saved.state).toBe('rejected');expect(saved.engine).toBe('rules');expect(saved.text).not.toContain('模型专有措辞')"
 const proposed=proposeTestCorrection(id,{contract_digest:baseline.native.digest,file:'acceptance.mjs',old_text:oldText,new_text:added,feature_ids:['F-001'],reason:'保留两次操作和原断言，增加区分残留正文与真实规则回退的可见及持久状态断言'})
 const evidence=join(home,'rewrite-independent.json');writeFileSync(evidence,JSON.stringify({expected,counterexample:'旧正文包含通用关键词，第二次只改状态也可通过旧断言'}))
 decideTestCorrection(id,proposed.id,{verdict:'approve',reviewer:'independent_operator',reason:'fixture独立裁定：追加反例断言，保留原操作与预期',expected_sources:{'F-001':expected},evidence:[{path:evidence,sha256:sha(readFileSync(evidence))}]})
 applyApprovedNativeCorrections(id)
 expect(testCorrectionChanges(id)[0]).toMatchObject({before:baseline.native.digest,cases:[{name:'F-001 rejection clears prior rewrite',feature:'F-001',body:'changed'}],verification:'not_issued'})
 expect((await verifyProjectStage(id,'first','acceptance.mjs',AbortSignal.timeout(60000))).status).toBe('failed')
 writeFileSync(join(root,'server.cjs'),server(true))
 expect((await verifyProjectStage(id,'first','acceptance.mjs',AbortSignal.timeout(60000))).status).toBe('passed')
 expect(readProjectStages(id).attempts.map(a=>a.status)).toEqual(['passed','failed','passed'])
 expect(readTestContractFile(id,baseline.native.digest,'acceptance.mjs').text).toBe(weak)
},180000)
