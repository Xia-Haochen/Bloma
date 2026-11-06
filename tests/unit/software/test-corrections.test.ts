import {applyApprovedNativeCorrections} from '../../../main/software/native-gui-registration'
import {guiSuitePath} from '../../../main/desktop/gui-acceptance'
import {buildSoftwareVerifyTool} from '../../../main/software/verification-tool'
import {applyApprovedTestCorrections} from '../../../main/software/test-corrections'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
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
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex')
beforeEach(()=>{
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
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true})})
const proposal=()=>proposeTestCorrection(p.project_id,{contract_digest:before.digest,file:'acceptance.mjs',old_text:"toHaveText('current')",new_text:"toHaveText('created')",feature_ids:['F-001'],reason:'独立原始记录显示创建时值，当前值不是需求预期'})
function decision(id:string){const evidence=join(home,'independent.json');writeFileSync(evidence,'{"observed":"created","original_assertion":"current"}');return{verdict:'approve' as const,reviewer:'independent_operator' as const,reason:'核对确认需求和独立原始记录后裁定',expected_sources:{'F-001':'旧记录保留创建时信息'},evidence:[{path:evidence,sha256:sha(readFileSync(evidence))}]}}
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
it('real browser: failed frozen expectation is retained, independently corrected, and must actually pass a new stage run',async()=>{
  // A different project has no fabricated stage history; exercise the real path.
  const project=createProject({request_id:'browser',mode:'longterm'},{workflowVersion:'software-v1'}),id=project.project_id
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'载入已创建记录',ui:'required',delivery:'browser',requirements:[{description:'载入记录',expected:'载入后显示created'}],project_plan:{version:1,current:'first',stages:[{id:'first',title:'载入',feature_ids:['F-001']}]}}),{projectId:id,sessionId:'s',source:'载入后显示created',previous:readPrdBackplane(id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip'
  syncDocuments({request_id:'confirm',project_id:id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const brief=markPrdUserConfirmed(id)!,scope=prdScopeFingerprint(brief);updateProject(id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
  writeFileSync(join(project.root_path,'server.cjs'),`require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<button id="load" onclick="document.getElementById(\\'version\\').textContent=\\'created\\'">Load</button><p id="version"></p>')}).listen(${port},'127.0.0.1')`)
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs'],url:`http://127.0.0.1:${port}`}))
  writeFileSync(join(project.root_path,'acceptance.mjs'),original)
  const failed=await verifyProjectStage(id,'first','acceptance.mjs',new AbortController().signal)
  expect(failed.status).toBe('failed');expect(failed.feedback.scope).toBe('partial_cumulative_gui')
  const oldAttempt=readProjectStages(id).attempts[0],serverBefore=readFileSync(join(project.root_path,'server.cjs'),'utf8')
  registerNativeGuiTests(id,'acceptance.mjs')
  const a=proposeTestCorrection(id,{contract_digest:oldAttempt.native.digest,file:'acceptance.mjs',old_text:"toHaveText('current')",new_text:"toHaveText('created')",feature_ids:['F-001'],reason:'确认预期为created，失败证据实际也是created，current不符来源'})
  decideTestCorrection(id,a.id,{verdict:'approve',reviewer:'independent_operator',reason:'独立核对确认来源与实际断言记录',expected_sources:{'F-001':'载入后显示created'},evidence:[{path:oldAttempt.report!,sha256:sha(readFileSync(oldAttempt.report!))}]})
  await buildSoftwareVerifyTool(id,createSoftwareCollaborationPolicy(id,project.root_path,'s')).execute({},{projectId:id,sessionId:'s',requestId:'approved-recovery',signal:AbortSignal.timeout(60000),state:createToolState()})
  expect(readFileSync(join(project.root_path,'acceptance.mjs'),'utf8')).toContain("toHaveText('created')")
  expect(readProjectStages(id).attempts[0].status).toBe('failed')
  expect((await verifyProjectStage(id,'first','acceptance.mjs',new AbortController().signal)).status).toBe('passed')
  expect(readProjectStages(id).attempts.map(a=>a.status)).toEqual(['failed','passed'])
  expect(readFileSync(join(project.root_path,'server.cjs'),'utf8')).toBe(serverBefore)
  expect(registerNativeGuiTests(id,'acceptance.mjs').covers).toEqual(['F-001'])
},90000)

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
