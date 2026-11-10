import { serializeRedactedJson } from '../../shared/redacted-json'
import { readEngineeringDesign, ENGINEERING_GUIDANCE, ENGINEERING_REVIEW_SCHEMA, parseEngineeringReview } from './engineering-design'
import { buildQualityFindingsTool } from './quality-findings-tool'
import {softwareVerificationFingerprint} from '../desktop/verification-fingerprint'
import { deliveryQualityGate, deliveryQualityBlock } from './delivery-qualification'
import { withAbort } from '../agent/loop/agent-loop'
import {pendingTestCorrection,testCorrectionChanges} from './test-corrections'
import {ModelRequestRefusal} from '../platform/llm/model-request-refusal'
import { defaultQuickSecurityGate } from '../desktop/production-contracts'
import { runtimeInventory } from './release-store'
import { reviewReadIdentity, compactReviewManifest, reviewChangeContext, repeatedReviewFailure } from './quality-review-context'
import { canonicalFindingReference } from './quality-reference'
import { validateIntentObservations, bindIntentFindings } from './intent-review'
import { productDesignPolicy } from '../project/product-design-policy'
import { currentEngineeringFailures, unreviewedNegativeObservation, findingNeedsClosure, findingNeedsInvestigation, sameQualityScope, qualityCloseout, qualityWorkQueue, observedQualityFinding } from './quality-closeout'
import { visualReviewChecklist, visualCoverageComplete } from './visual-review-checklist'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLoopTool, ToolContext, AgentLoopInput } from '../agent/loop/agent-loop'
import { startDelegation, findDelegation, isProjectDelegationRunning } from '../agent/delegation/agent-collaboration'
import type { DelegationParentContext } from '../agent/delegation/delegation-context'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { trustedAcceptance } from '../project/requirement-contract'
import { verifySoftwareCandidate } from './verification'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { activeSoftwareCommands, redactSoftwareOutput, stopSoftwareSession } from './process-manager'
import { retainedDebugObservation, activeDebugSessionId, readDebugSession, closeDebugSessions } from './debug-sessions'
import { captureVisualMaterial, readVisualMaterial, grantVisualImage, validateVisualGrant, assertVisualRequest } from './visual-review-material'
import type { VisualMaterial } from './visual-review-material'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'
import { independentDesignVersion } from './independent-design'
import { challengeIndependentCase } from './independent-quality'
import { selectQualityCollaboration } from './collaboration-selection'

import { qualityTestSources, qualityCoverageRulesVersion, registeredQualityCases, qualityFailureBaseline, applicableQualityLedger, qualityRulesVersion as rulesVersion, qualityHash as hash, sameIdentity as same, qualityIdentity as identity, readQualityLedger, saveQualityLedger, type Review, type ReviewKind, type ReviewPurpose, type Ledger, type QualityFinding } from './quality-ledger'
export { qualityLedgerPath, readQualityLedger } from './quality-ledger'
export type { QualityFinding } from './quality-ledger'

/** The model supplies observations only. Candidate IDs, execution results and
 * state transitions belong to the host; the durable ledger lives outside source. */
export function createQualityReview(projectId: string, parent: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, initialEnv?:Record<string,string>, engineeringAdvice?:()=>unknown) {
  const recovery=readQualityLedger(projectId)
  let recovered=false
  for(const review of recovery.reviews){
    if(['pending','submitted'].includes(review.status)&&(!review.delegation||!isProjectDelegationRunning(projectId,review.delegation))){
      review.status='interrupted';review.failure_code='QUALITY_REVIEW_SESSION_ENDED';recovered=true
    }
  }
  if(recovered)saveQualityLedger(projectId,recovery)
  const children = new Map<string, string>()
  const materialsRead = new Set<string>(), sourceRead = new Set<string>()
  const providedReads=new Map<string,string>()
  const imagesRequested = new Set<string>()
  let pending: Review | undefined
  const currentObservation = () => {
    const id=activeDebugSessionId(projectId,parent),source=softwareVerificationFingerprint(findProject(projectId).root_path)
    const stored=id?readDebugSession(projectId,parent,id):retainedDebugObservation(projectId,parent)
    const snapshot=stored&&!stored.stale&&stored.source===source&&(!id||stored.state==='ready')?stored:undefined
    const engineering_failures=currentEngineeringFailures(engineeringAdvice?.())
    if(!snapshot&&!engineering_failures.length)return
    const ui=snapshot?.ui,steps=snapshot?.steps.slice(-16).map(({passed,actual})=>({passed,actual}))??[],logs=snapshot?.observations.filter(o=>o.kind!=='page.closed').slice(-16).map(({kind,message,method,url,status})=>({kind,message,method,url,status}))??[]
    const image_hash=snapshot?.screenshot&&!snapshot.screenshot_error&&existsSync(snapshot.screenshot)?createHash('sha256').update(readFileSync(snapshot.screenshot)).digest('hex'):undefined
    const execution_failed=snapshot?.state==='failed'
    return {source,digest:hash([source,ui,steps,logs,image_hash,engineering_failures,execution_failed]),image_hash,ui,steps,logs,engineering_failures,execution_failed}
  }
  const routeIdentity=(env:Record<string,string>,providerType?:string)=>hash([env.ANTHROPIC_BASE_URL,env.ANTHROPIC_MODEL,env.ANTHROPIC_PROVIDER_TYPE,providerType])
  let activeRoute: string | undefined = initialEnv ? routeIdentity(initialEnv) : undefined
  let busy = false
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) throw Error('QUALITY_OPERATION_RUNNING')
    busy = true
    try { return await work() } finally { busy = false }
  }
  const save = (ledger: Ledger) => saveQualityLedger(projectId, ledger)
  const assertParent = (ctx: ToolContext) => {
    policy.assertCommand(ctx)
    if (ctx.projectId !== projectId || ctx.sessionId !== parent) throw Error('QUALITY_PARENT_ONLY')
    if (activeSoftwareCommands(projectId, parent).length) throw Error('QUALITY_COMMANDS_RUNNING')
  }
  const prepare: NonNullable<DelegationParentContext['prepareDelegation']> = input => {
    if(input.args.role==='review'&&!pending)throw Error('QUALITY_REVIEW_HOST_ONLY: 交付审阅由宿主在verify_app后安排。')
    if (readQualityLedger(projectId).reviews.some(r => r.child === input.childSessionId)) throw Error('QUALITY_NEW_REVIEW_REQUIRED: 不续跑旧候选审阅')
    const lease = policy.prepare(input)
    if (!pending) return lease
    const review = pending
    const release = policy.freezeReview()
    try {
      children.set(input.childSessionId, review.id)
      const ledger = readQualityLedger(projectId)
      Object.assign(ledger.reviews.find(r => r.id === review.id)!, { child: input.childSessionId, delegation: input.delegationId,
        ...(review.visual ? { image: grantVisualImage(review.visual, input.childSessionId) } : {}) })
      save(ledger)
    } catch (error) { release(); lease.release(); throw error }
    return { release: () => {
      lease.release(); release(); children.delete(input.childSessionId)
      const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
      if (stored.status !== 'complete') { const ended = findDelegation(parent, input.delegationId); stored.status = 'interrupted'; stored.failure_code = ended?.error?.match(/\b[A-Z][A-Z_]{4,}\b/)?.[0] ?? 'loop:' + (ended?.loopStatus ?? 'interrupted'); save(ledger) }
    }, completionNote: () => '\n结构化审阅意见按实际提交记录保管；子任务完成不代表缺陷已关闭。' }
  }
  const begin = async (ctx: ToolContext, kind: ReviewKind = 'code', debugId?: string, purpose:ReviewPurpose='candidate') => exclusive(async () => {
    assertParent(ctx)
    // Reject known local delivery blockers before paying for C/V. This is the
    // existing delivery scan, not a second policy or a substitute review PASS.
    const security = defaultQuickSecurityGate(projectId)
    if (purpose==='candidate' && (!security || !security.passed || security.blocking)) throw Error('QUALITY_LOCAL_CHECK_REQUIRED: 先处理本机静态检查，再审阅稳定候选。' + (security?.listing ?? '扫描未完成'))
    const binding = await identity(projectId, ctx.signal), id = randomUUID(), ledger = readQualityLedger(projectId)
    const work = qualityCloseout(applicableQualityLedger(projectId), binding, undefined, rulesVersion(projectId), independentDesignVersion(projectId))
    if (purpose==='candidate' && work.must_fix.some(id=>qualityFailureBaseline(ledger.findings.find(f=>f.id===id)!)?.rules===rulesVersion(projectId))) throw Error('QUALITY_FINDING_REPRODUCTION_REQUIRED: 先用冻结案例复现或复测重要问题，不通过重新审阅代替闭合。' + JSON.stringify(work))
    const previous = ledger.reviews.filter(r => (r.kind ?? 'code') === kind && (r.purpose??'candidate')===purpose).at(-1)
    if (!work.must_fix.length && !work.required_investigation.length && (!currentObservation()||currentObservation()!.digest===previous?.observation?.digest) && previous?.status === 'complete' && same(previous.identity,binding) && (previous.intent_observations??[]).every(o=>o.status==='supported')) {
      if (kind === 'code' || previous.visual && previous.image && previous.child && previous.visual_delivery?.image_hash === previous.visual.image_hash) {
        if (kind === 'visual') validateVisualGrant(previous.visual!,previous.child!,previous.image!)
        return { delegation_id: previous.delegation!, child_session_id: previous.child!, review_id: previous.id, already_reviewed: true }
      }
    }
    const observation=currentObservation()
    let visual: VisualMaterial | undefined
    try {
      if (kind === 'visual') {
        if (readPrdBackplane(projectId).lean_brief?.ui !== 'required') throw Error('VISUAL_GUI_REQUIRED')
        visual = await captureVisualMaterial(projectId, parent, id, hash(binding), ctx.signal, debugId)
      }
    } finally { await closeDebugSessions(projectId, parent); await stopSoftwareSession(projectId, parent) }
    assertParent(ctx)
    if (!same(binding, await identity(projectId, ctx.signal))) throw Error('QUALITY_CAPTURE_CANDIDATE_CHANGED')
    const inventory = kind === 'code' ? await runtimeInventory(findProject(projectId).root_path, ctx.signal) : undefined
    if (inventory && inventory.digest !== binding.source) throw Error('QUALITY_CAPTURE_CANDIDATE_CHANGED')
    const review: Review = { id, kind, purpose, rules:purpose==='coverage'?qualityCoverageRulesVersion(projectId):rulesVersion(projectId), observation, run_id: ctx.requestId, identity: binding, visual, ...(inventory ? { source_manifest: compactReviewManifest(inventory) } : {}), status: 'pending', at: new Date().toISOString() }
    ledger.reviews.push(review); save(ledger)
    pending = review
    try {
      return startDelegation(ctx, { role: 'review', readOnly: true,
        task: purpose!=='candidate'?`这是${purpose}局部审查，不能替代最终C/V。读取read_quality_review及相关冻结测试；coverage核对断言能否区分原旅程中的错误实现，binding逐条核对binding_work所列触发和原预期。同一案例可分别绑定多个确实覆盖的疑点，不按F编号猜测；无匹配时保留缺口，有明确匹配时一次提交resolutions，宿主随后执行。` : kind === 'visual' ? `视觉审阅候选 ${id}。用read_quality_review读取确认预期、同次DOM/操作事实；必须view_quality_image查看真实图片，再提交visual_observations（image_sha256、area、region、observed；area须覆盖layout/interaction/content/scope）及findings。独立检查布局、遮挡、静态残留、单位、状态和当前对象；DOM与文件名不是图片。只报证据与疑点，不改源码或目标，不自报PASS。`
          : `审阅候选 ${id}。先用read_quality_review取得宿主绑定的确认需求和材料。先看宿主review_focus的同目标/环境前次审阅及文件差异，再批量读取相关实现，不重复读取同一范围；测试只在核对预期或疑点时读取，不逐页遍历全部测试和依赖。保留回合用于结构化提交。重点检查对象身份、异步状态、持久化、接口和遗漏分支；不继承制作方成功结论。用submit_quality_findings提交结构化疑点（没有发现也提交空数组），不自报PASS、不新增需求、不运行或修改文件。` })
    } finally { pending = undefined }
  })
  const ensureCoverage=async(ctx:ToolContext)=>{
    const brief=readPrdBackplane(projectId)
    if(brief.lean_brief?.ui!=='required'&&!brief.requirements_model?.workflows?.length)return
    if(!registeredQualityCases(projectId,true).length)throw Error('QUALITY_COVERAGE_MATERIALS_REQUIRED')
    const current=await identity(projectId,ctx.signal),rules=qualityCoverageRulesVersion(projectId)
    if(readQualityLedger(projectId).reviews.some(r=>r.purpose==='coverage'&&r.status==='complete'&&r.identity.target===current.target&&r.rules===rules))return
    const child=await begin(ctx,'code',undefined,'coverage')
    const run=findDelegation(parent,child.delegation_id)
    if(run?.completion)await withAbort(run.completion,ctx.signal)
    const review=readQualityLedger(projectId).reviews.find(r=>r.delegation===child.delegation_id)
    if(review?.status!=='complete')throw new ModelRequestRefusal('QUALITY_COVERAGE_REVIEW_INCOMPLETE')
    // Coverage discovers work; it never replaces execution or candidate C/V.
  }
  const system = (child: string) => children.has(child)
    ? readQualityLedger(projectId).reviews.find(r => r.id === children.get(child))?.kind === 'visual'
      ? '你是独立视觉/交互审阅V。只看宿主授权的当前候选真实图片、确认设计、同次DOM/操作事实；不继承制作方或C的结论，不读实现。先read_quality_review和view_quality_image；实际核对图片后用submit_quality_findings提交具体可见观察及疑点，不能用OCR/文件名/DOM替代看图，不能自报PASS或关闭问题。没有明确的业务预期保留争议；只读，不运行命令、不改文件。'
      : `你是独立只读代码/数据审阅C。项目根：${findProject(projectId).root_path}。业务范围以read_quality_review返回的已确认目标为依据；同时核对宿主提供的工程设计与工程底线。实现和设计是待查资料，不能当成已通过结论。定位具体触发、预期来源和证据，提交finding而非PASS。不看制作方自评，不改代码/预期，不运行命令。无法确定的业务规则保留争议。必须调用submit_quality_findings后才结束。` : undefined
  const childProtocol: AgentLoopTool[] = [{ name: 'read_quality_review', description: '读取本审阅的候选、确认需求及冻结测试索引。绑定case_name前核对冻结合同和相关测试正文；test_file只接受索引中的key，可用offset分页。', input_schema: { type: 'object', additionalProperties: false, properties: {test_file:{type:'string'},offset:{type:'integer',minimum:0}} },
    execute: async (_input, ctx) => {
      ctx.signal.throwIfAborted()
      const ledger = readQualityLedger(projectId), review = ledger.reviews.find(r => r.id === children.get(ctx.sessionId))
      if (ctx.projectId !== projectId || !review || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('QUALITY_REVIEW_STALE_OR_DENIED')
      if(Object.keys(_input).some(k=>!['test_file','offset'].includes(k))||_input.test_file===undefined&&_input.offset!==undefined)throw Error('QUALITY_REVIEW_INPUT_INVALID')
      if(review.rules&&review.rules!==(review.purpose==='coverage'?qualityCoverageRulesVersion(projectId):rulesVersion(projectId)))throw Error('QUALITY_REVIEW_TESTS_CHANGED')
      const testSources=qualityTestSources(projectId,review.purpose==='coverage')
      if(_input.test_file!==undefined){
        const file=testSources.find(f=>f.key===_input.test_file),offset=_input.offset??0
        if(!file||!Number.isSafeInteger(offset)||(offset as number)<0)throw Error('QUALITY_TEST_FILE_NOT_OWNED')
        const bytes=readFileSync(file.path)
        if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('QUALITY_FROZEN_TEST_CHANGED')
        const utf8=bytes.toString('utf8'),encoding=Buffer.from(utf8).equals(bytes)?'utf8':'base64',text=encoding==='utf8'?utf8:bytes.toString('base64')
        return{output:JSON.stringify({file:file.key,sha256:file.sha256,encoding,offset,text:text.slice(offset as number,(offset as number)+16000),total_characters:text.length,
          next:(offset as number)+16000<text.length?{test_file:file.key,offset:(offset as number)+16000}:undefined,authority:'frozen_test_input_not_execution_or_current_image'})}
      }
      const brief = readPrdBackplane(projectId)
      const visual = review.visual ? readVisualMaterial(review.visual, hash(review.identity)).manifest : undefined
      const ux = readConfirmedUxBinding(projectId, brief)
      materialsRead.add(ctx.sessionId)
      const work=qualityCloseout(applicableQualityLedger(projectId),review.identity,undefined,rulesVersion(projectId),independentDesignVersion(projectId))
      return { output: JSON.stringify({ review, binding_work:work.binding_findings.filter(id=>(ledger.findings.find(f=>f.id===id)?.review_kind??'code')===(review.kind??'code')), root: findProject(projectId).root_path, goal: brief.positioning, source_statements:brief.lean_brief?.intent_sources??brief.requirements_model?.sources, constraints: brief.constraints, assumptions: brief.assumptions, confirmed_ux: ux, design_policy: productDesignPolicy(brief),
        frozen_test_files:testSources.map(({path,...entry})=>entry),test_coverage:{scope:review.purpose==='coverage'?'available_cumulative_slice':'complete_registered_suite',cases:registeredQualityCases(projectId,review.purpose==='coverage'),workflows:brief.requirements_model?.workflows,requirements:brief.requirements,contract_changes:testCorrectionChanges(projectId,review.purpose==='coverage'),authority:'派生阅读投影；核对前置状态、触发、可见结果及持久状态，断言须能区分所报错误实现；共有词或F编号不证明覆盖。修订差异只指引阅读，不继承旧绑定或PASS。'},
        host_observation:review.observation, engineering_advice:engineeringAdvice?.(), confirmed_design: review.kind === 'visual' && ux?.html_path ? { html: readFileSync(join(findProject(projectId).root_path, ux.html_path), 'utf8').slice(0, 64000), bounded_characters: 64000 } : undefined,
        unresolved_findings: applicableQualityLedger(projectId).findings.filter(f=>findingNeedsClosure(f,review.identity,rulesVersion(projectId),independentDesignVersion(projectId))||findingNeedsInvestigation(f,review.identity,rulesVersion(projectId),independentDesignVersion(projectId))).map(f=>({...f,checks:f.checks.slice(-1)})), resolution_protocol:'旧疑点若被实际证据排除，在resolutions提交finding_id和具体触发/观察依据。普通案例通过不足以排除疑点；已确认失败不得用审阅关闭。', review_focus: review.kind === 'visual' ? undefined : reviewChangeContext(ledger, review.identity, review.source_manifest, review.id), intent: brief.requirements_model, intent_review_protocol: review.kind === 'visual' ? 'V仅按当前真实图片和同次操作事实检查布局/交互/内容/覆盖范围；不得声称核对全部长期业务。核心体验上下文用于识别偏题，具体疑点提交finding。截图可能保留用户或测试修改后的状态，当前数值不等于出厂默认；明确区分所见事实与推断。可自定义设置按已确认范围判断，不擅自把默认偏好变成禁止修改的约束。无需提交intent_observations。' : '有experience时逐项提交intent_observations:{commitment_id,status:supported|concern|unverified,evidence,limitations}；核对禁止替代。supported只是审阅意见，不代表真实运行通过。concern须提供finding_indices，填本次findings数组中对应问题的0起始索引，只关联真正影响该体验的问题；证据不足保留unverified。', visual_facts: visual, visual_checklist: review.kind === 'visual' ? visualReviewChecklist : undefined,
        engineering: review.kind === 'visual' ? undefined : { design: readEngineeringDesign(findProject(projectId).root_path), guidance: ENGINEERING_GUIDANCE, submission: '代码审阅提交engineering:{status:supported|concern|unverified,severity:high|medium|low,evidence,limitations}。具体引用文件/接口，核对职责、依赖、状态归属、错误和资源生命周期、测试与兼容。重要结构缺陷填concern并给严重性与具体影响，证据不足填unverified；普通建议和未评估项不阻断，不虚构F编号。设计文档与目录数量不能证明实现合理；supported仅表示审阅支持，实际行为仍由宿主验证。' }, requirements: brief.requirements.map(r => ({ id: r.id, description: r.description, expected_source: trustedAcceptance(brief, r) })), out_of_scope: brief.out_of_scope }) }
    } }, { name: 'submit_quality_findings', description: '提交只读疑点，不得指定状态或PASS。requirement只填F编号，expected_source从read_quality_review的expected_source逐字复制（不写来源说明或编号拼接）；无依据增强标suggestion，预期有争议标disputed。宿主生成ID、绑定候选；只能提交一次。',
    input_schema: { type: 'object', additionalProperties: false, required: ['findings'], properties: { engineering: ENGINEERING_REVIEW_SCHEMA, resolutions: {type:'array',maxItems:32,items:{type:'object',additionalProperties:false,required:['finding_id','evidence'],properties:{basis:{type:'string',enum:['static_misread','not_applicable']},finding_id:{type:'string'},evidence:{type:'string',minLength:1,maxLength:4000},case_name:{type:'string',description:'独立核对具体触发输入和断言后的注册案例名；可逐条绑定多个确实覆盖的疑点。已有实际失败只能保留原案例，批准绑定不代表执行通过。'}}}}, intent_observations: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['commitment_id','status','evidence','limitations'], properties: { commitment_id: {type:'string'}, status:{type:'string',enum:['supported','concern','unverified']}, evidence:{type:'string'}, limitations:{type:'string'}, finding_indices:{type:'array',maxItems:32,uniqueItems:true,items:{type:'integer',minimum:0},description:'concern必填；对应本次findings数组的0起始索引，不关联同功能的无关建议'} } } }, visual_observations: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['image_sha256', 'area', 'region', 'observed'], properties: { area: { type: 'string', enum: Object.keys(visualReviewChecklist) }, image_sha256: { type: 'string' }, region: { type: 'string', maxLength: 1000 }, observed: { type: 'string', maxLength: 2000 } } } }, findings: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
      required: ['expected_source', 'category', 'severity', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns', 'kind'], anyOf: [{ required: ['requirement'] }, { required: ['requirement_id'] }],
      properties: { ...Object.fromEntries(['requirement', 'expected_source', 'category', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns'].map(key => [key, { type: 'string', maxLength: 4000 }])),
        requires_execution:{type:'boolean',description:'默认true。依赖操作时序、账号/窗口/网络/持久化的疑点必须true；仅静态误读或不适用问题可false。'},
        case_name:{type:'string',maxLength:1000,description:'可选：独立审阅已核对具体触发输入和断言的注册案例名；不确定覆盖时省略，不按F编号猜测。'},
        requirement_id: { type: 'string', enum: [...readPrdBackplane(projectId).requirements.map(r => r.id), 'unscoped'], description: 'requirement的兼容别名；同时提供时必须相同。' },
        requirement: { type: 'string', enum: [...readPrdBackplane(projectId).requirements.map(r => r.id), 'unscoped'], description: '只填给定F编号；不要填需求全文、AC/BR编号或拼接多个编号。无确认依据的纯建议才用unscoped。' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, kind: { type: 'string', enum: ['suspected', 'disputed', 'suggestion'] } } } } } },
    execute: async (input, ctx) => {
      ctx.signal.throwIfAborted()
      const ledger = readQualityLedger(projectId), review = ledger.reviews.find(r => r.id === children.get(ctx.sessionId))
      if (ctx.projectId !== projectId || !review || review.status !== 'pending' || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('QUALITY_REVIEW_STALE_OR_DENIED')
      if(review.rules&&review.rules!==(review.purpose==='coverage'?qualityCoverageRulesVersion(projectId):rulesVersion(projectId)))throw Error('QUALITY_REVIEW_TESTS_CHANGED')
      if (!materialsRead.has(ctx.sessionId) || review.kind !== 'visual' && !sourceRead.has(ctx.sessionId)) throw Error('QUALITY_REVIEW_MATERIALS_NOT_READ: 先读取确认材料和候选文件')
      if (review.kind === 'visual') {
        if (!review.visual || !review.image || !review.visual_delivery || !imagesRequested.has(ctx.sessionId)) throw Error('VISUAL_IMAGE_NOT_DELIVERED')
        validateVisualGrant(review.visual, ctx.sessionId, review.image)
        const observations = input.visual_observations as Array<Record<string, unknown>>
        if (!Array.isArray(observations) || !observations.length || observations.length > 16 || observations.some(o => !o || Object.keys(o).some(k => !['image_sha256', 'area', 'region', 'observed'].includes(k))
          || !Object.hasOwn(visualReviewChecklist, String(o.area)) || o.image_sha256 !== review.visual!.image_hash || typeof o.region !== 'string' || !o.region.trim() || o.region.length > 1000 || typeof o.observed !== 'string' || !o.observed.trim() || o.observed.length > 2000)) throw Error('VISUAL_OBSERVATIONS_REQUIRED')
        if (!visualCoverageComplete(observations)) throw Error('VISUAL_CHECKLIST_INCOMPLETE: 须覆盖layout/interaction/content/scope，未观察状态明确写入scope')
        review.visual_observations = observations
      } else if (input.visual_observations !== undefined) throw Error('VISUAL_OBSERVATIONS_NOT_APPLICABLE')
      if (Object.keys(input).some(k => !['findings', 'visual_observations', 'intent_observations', 'resolutions', 'engineering'].includes(k)) || !Array.isArray(input.findings) || input.findings.length > 32) throw Error('QUALITY_FINDINGS_INVALID')
      const brief = readPrdBackplane(projectId)
      if (review.kind !== 'visual') review.engineering = input.engineering === undefined
        ? { status: 'unverified', evidence: '本次代码审阅未提供工程观察。', limitations: '未据此判断架构合格或不合格。' }
        : parseEngineeringReview(input.engineering)
      else if (input.engineering !== undefined) throw Error('ENGINEERING_REVIEW_NOT_APPLICABLE')
      const bindings:Array<{finding_id:string;case_name:string;evidence:string}>=[]
      const rows = input.findings.map((raw: unknown): QualityFinding => {
        const {case_name,requires_execution,...row} = canonicalFindingReference(raw), fields = ['requirement', 'expected_source', 'category', 'severity', 'location', 'trigger', 'evidence', 'reproduction', 'unknowns', 'kind']
        if (!row || Object.keys(row).some(k => !fields.includes(k)) || fields.some(k => typeof row[k] !== 'string' || (row[k] as string).length > 4000 || k !== 'unknowns' && !(row[k] as string).trim())
          || !['critical', 'high', 'medium', 'low'].includes(String(row.severity)) || !['suspected', 'disputed', 'suggestion'].includes(String(row.kind))) throw Error('QUALITY_FINDING_INVALID')
        if(requires_execution!==undefined&&typeof requires_execution!=='boolean')throw Error('QUALITY_EVIDENCE_REQUIREMENT_INVALID')
        const requirement = brief.requirements.find(r => r.id === row.requirement)
        if (!requirement && (row.requirement !== 'unscoped' || row.kind !== 'suggestion')) throw Error('QUALITY_REQUIREMENT_ID_INVALID: requirement只填当前F编号；纯增强建议才用unscoped。')
        const disposition = !requirement ? 'suggestion' : row.expected_source !== trustedAcceptance(brief, requirement) ? 'disputed' : row.kind
        const { kind: _kind, ...finding } = row
        const findingId=randomUUID()
        if(case_name!==undefined){if(typeof case_name!=='string'||!case_name.trim()||case_name.length>1000)throw Error('QUALITY_CASE_BINDING_INVALID');bindings.push({finding_id:findingId,case_name,evidence:String(row.reproduction)+'\n'+String(row.evidence)})}
        return { ...finding, requires_execution:requires_execution!==false, id: findingId, review: review.id, review_kind: review.kind ?? 'code', visual_material_hash: review.visual?.manifest_hash, identity: review.identity, disposition, checks: [] } as unknown as QualityFinding
      })
      const intent = validateIntentObservations(input.intent_observations, review.kind === 'visual' ? undefined : brief.requirements_model?.experience)
      review.intent_observations = bindIntentFindings(intent,brief.requirements_model?.experience,rows)
      const resolutions=input.resolutions??[]
      if(!Array.isArray(resolutions)||resolutions.length>32)throw Error('QUALITY_RESOLUTION_INVALID')
      const resolvedIds=new Set<string>()
      for(const item of resolutions){
        if(!item||Object.keys(item).some(key=>!['finding_id','evidence','case_name','basis'].includes(key))||typeof item.finding_id!=='string'||resolvedIds.has(item.finding_id)||item.case_name!==undefined&&(typeof item.case_name!=='string'||!item.case_name.trim()||item.case_name.length>1000))throw Error('QUALITY_RESOLUTION_INVALID')
        if(item.basis!==undefined&&!['static_misread','not_applicable'].includes(item.basis))throw Error('QUALITY_RESOLUTION_BASIS_INVALID')
        resolvedIds.add(item.finding_id)
        const f=ledger.findings.find(f=>f.id===item.finding_id)
        const baseline=f?qualityFailureBaseline(f):undefined
        if(!item.case_name&&(!item.basis||f?.requires_execution!==false))throw Error('QUALITY_RUNTIME_EXECUTION_REQUIRED')
        if(!f||f.independent||(baseline?item.case_name!==baseline.case_name:!['suspected','not_reproduced','confirmed','closed'].includes(f.disposition))
          ||(f.review_kind??'code')!==(review.kind??'code')||typeof item.evidence!=='string'||!item.evidence.trim()||item.evidence.length>4000)throw Error('QUALITY_RESOLUTION_INVALID')
      }
      for(const item of [...resolutions,...bindings]){
        if(!item.case_name)continue
        const f=[...ledger.findings,...rows].find(f=>f.id===item.finding_id)!
        const matches=registeredQualityCases(projectId).filter(c=>c.name===item.case_name&&c.requirements.includes(f.requirement))
        if(matches.length!==1)throw Error('QUALITY_CASE_BINDING_NOT_REGISTERED')
      }
      review.resolutions=[...resolutions,...bindings]
      // This validated final submission is the review's commit point. A later
      // transport failure or cancellation cannot undo an already accepted opinion.
      ledger.findings.push(...rows); review.status = 'complete'
      for(const item of review.resolutions){
        const finding=ledger.findings.find(f=>f.id===item.finding_id)!
        const evidence={identity:review.identity,review:review.id,evidence:item.evidence,...(item.basis?{basis:item.basis}:{})}
        if(item.case_name)finding.retest={...evidence,case_name:item.case_name,rules:rulesVersion(projectId)}
        else if(!qualityFailureBaseline(finding))finding.reviewed=evidence
      }
      save(ledger)
      return { output: JSON.stringify({ submitted: true, findings: rows, verification: 'unverified' }) }
    } }, { name: 'view_quality_image', description: '读取本视觉子会话获宿主授权的当前候选真实PNG。无path或debug_session_id参数；跨会话、过期、换图拒绝。附图之后还须实际核对并提交具体可见观察，图片本身不签发PASS。', input_schema: { type: 'object', additionalProperties: false, properties: {} }, execute: async (input, ctx) => {
      ctx.signal.throwIfAborted()
      const review = readQualityLedger(projectId).reviews.find(r => r.id === children.get(ctx.sessionId))
      if (Object.keys(input).length || ctx.projectId !== projectId || review?.kind !== 'visual' || !review.visual || !review.image || !same(review.identity, await identity(projectId, ctx.signal))) throw Error('VISUAL_IMAGE_NOT_OWNED_OR_STALE')
      validateVisualGrant(review.visual, ctx.sessionId, review.image); imagesRequested.add(ctx.sessionId)
      return { output: JSON.stringify({ sha256: review.visual.image_hash, candidate: review.identity, visual_review: 'image_attached_not_reviewed' }), images: [review.image] }
    } }]
  const check: AgentLoopTool = { name: 'check_quality_finding', description: '宿主诊断接口：运行冻结验收并记录具体案例观察。只有独立审阅确认的案例绑定才用于缺陷结算；未绑定的成功或失败都不能自行证明原疑点。已有失败须按原案例复测；合同修订须独立批准重绑定。制作Agent由verify_app统一推进，无需调用此记账接口。',
    input_schema: { type: 'object', additionalProperties: false, required: ['finding_id', 'case_name'], properties: { finding_id: { type: 'string' }, case_name: { type: 'string' } } },
    execute: async (input, ctx) => exclusive(async () => {
      assertParent(ctx)
      await closeDebugSessions(projectId, parent); await stopSoftwareSession(projectId, parent)
      assertParent(ctx)
      if (Object.keys(input).some(k => !['finding_id', 'case_name'].includes(k)) || typeof input.case_name !== 'string' || !input.case_name.trim()) throw Error('QUALITY_CHECK_INVALID')
      const ledger = readQualityLedger(projectId), finding = ledger.findings.find(f => f.id === input.finding_id)
      if (!finding || ['suggestion', 'disputed'].includes(finding.disposition)) throw Error('QUALITY_FINDING_UNGROUNDED')
      if (finding.independent) {
        if (finding.disposition === 'superseded' || finding.independent.case_id !== input.case_name || finding.independent.design_version !== independentDesignVersion(projectId)) throw Error('INDEPENDENT_RETEST_CONTRACT_CHANGED')
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal)
        const updated = readQualityLedger(projectId).findings.find(f => f.id === finding.id)!
        return { output: JSON.stringify({ finding: updated, status: result.status, summary: result.summary }), isError: result.status !== 'passed' || updated.disposition !== 'closed' }
      }
      if (!applicableQualityLedger(projectId).findings.some(f=>f.id===finding.id)) throw Error('QUALITY_FINDING_SCOPE_RETIRED')
      const before = await identity(projectId, ctx.signal), rules = rulesVersion(projectId), baseline = qualityFailureBaseline(finding)
      const rebound=finding.retest&&sameQualityScope(finding.retest.identity,before)&&finding.retest.rules===rules&&finding.retest.case_name===input.case_name
      if (baseline && (baseline.case_name !== input.case_name || baseline.rules !== rules)&&!rebound) throw Error('QUALITY_RETEST_CONTRACT_CHANGED')
      // Finding assessment consumes the same host evidence as verification.
      // Its cache validates source, rules, environment, request and receipt;
      // changed inputs or failed/incomplete evidence still execute afresh.
      const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal)
      const after = await identity(projectId, ctx.signal)
      if (!same(before, after) || rules !== rulesVersion(projectId)) throw Error('QUALITY_CHECK_INPUT_CHANGED')
      const settled = readQualityLedger(projectId).findings.find(f => f.id === finding.id)
      const last = settled?.checks.at(-1)
      if (last && last.candidate === result.candidate?.id && last.case_name === input.case_name
        && last.rules === rules && same(last.identity, before)) {
        return { output: JSON.stringify({ finding: settled, status: result.status, summary: result.summary }),
          isError: !['closed','not_reproduced'].includes(settled!.disposition) }
      }
      const outcome = observedQualityFinding(result, finding, input.case_name)
      finding.checks.push({ grounded:Boolean(rebound), at: new Date().toISOString(), identity: before, case_name: input.case_name, rules, outcome, report: result.report_path, candidate: result.candidate?.id,
        observation: serializeRedactedJson({ status: result.status, summary: result.summary, original_review_source: finding.identity.source, current_candidate_only: !baseline && !same(finding.identity,before),
          gui: result.core?.host_gui?.case_results?.filter(c => c.name === input.case_name && c.feature === finding.requirement), cli: result.core?.host_cli?.cases.filter(c => c.name === input.case_name && c.covers.includes(finding.requirement)) },redactSoftwareOutput) })
      finding.disposition = outcome === 'failed' && rebound ? 'confirmed' : outcome === 'passed' && baseline && result.status === 'passed' ? 'closed'
        : baseline ? 'confirmed' : outcome==='passed'&&rebound&&result.status==='passed'?'not_reproduced':'suspected'
      // Read again after asynchronous execution; no other writer may be erased.
      const current = readQualityLedger(projectId), index = current.findings.findIndex(f => f.id === finding.id)
      current.findings[index] = finding; save(current)
      return { output: JSON.stringify({ finding, status: result.status, summary: result.summary }), isError: finding.disposition !== 'closed' }
    }) }
  const observationGap=()=>unreviewedNegativeObservation(readQualityLedger(projectId),currentObservation())?'QUALITY_NEW_EXECUTION_REVIEW_REQUIRED: 当前版本出现新的负面执行事实，须独立判断，旧C不能覆盖。':undefined
  const gate = async(signal?: AbortSignal) => await deliveryQualityGate(projectId, signal, activeRoute)??observationGap()
  const parentTools: AgentLoopTool[] = [{name:'inspect_collaboration_plan',description:'只读核对当前候选相对已验证发布基线的宿主协作选择、实际差异及理由；不是PASS，不能传入低风险/跳过角色。B授权、重要缺陷和原交付检查不因此绕过。需要时仍可显式请求额外C/V审阅。',input_schema:{type:'object',additionalProperties:false,properties:{}},execute:async(input,ctx)=>{assertParent(ctx);if(Object.keys(input).length)throw Error('COLLABORATION_SELECTION_HOST_ONLY');return{output:JSON.stringify(await selectQualityCollaboration(projectId,await identity(projectId,ctx.signal),ctx.signal))}}}, {name:'challenge_independent_case',description:'提出B案例的业务预期/范围争议，须给具体理由和证据。只保留待核对主张并使旧PASS失效，不删除案例、不改冻结断言、不关闭已确认缺陷，也不自动重发B。需要用户澄清或新的确认设计才能解除；不要为适配器缺失擅自新增功能。',
    input_schema:{type:'object',additionalProperties:false,required:['case_id','reason','evidence'],properties:{case_id:{type:'string'},reason:{type:'string',maxLength:2000},evidence:{type:'string',maxLength:2000}}},
    execute:async(input,ctx)=>{assertParent(ctx);return{output:JSON.stringify({finding:await challengeIndependentCase(projectId,input,ctx.signal),verification:'unverified'})}}}, { name: 'start_quality_review', description: '冻结稳定候选，启动独立只读C审阅；继承当前Pi模型、共享预算及两并发限制。等待期间不能写文件或执行命令。修改后须重新审阅。', input_schema: { type: 'object', additionalProperties: false, properties: {} }, execute: async (_input, ctx) => ({ output: JSON.stringify(await begin(ctx)) }) },
    { name: 'start_visual_review', description: '宿主实际采集当前候选PNG和同次DOM/操作事实，封存并授权独立V子会话；继承父模型与共享预算。可指定本会话当前debug_session_id保留操作状态，否则复用当前实例或打开正常入口。图片缺失或渠道拒绝图像不能记为已审阅。', input_schema: { type: 'object', additionalProperties: false, properties: { debug_session_id: { type: 'string' } } }, execute: async (input, ctx) => {
      if (Object.keys(input).some(k => k !== 'debug_session_id') || input.debug_session_id !== undefined && typeof input.debug_session_id !== 'string') throw Error('VISUAL_INPUT_INVALID')
      return { output: JSON.stringify(await begin(ctx, 'visual', input.debug_session_id as string | undefined)) }
    } },
    buildQualityFindingsTool(projectId, assertParent, () => activeRoute), check]
  const reviewProtocol=(kind?:'code'|'visual')=>childProtocol.map(tool=>{
    if(!kind||tool.name!=='submit_quality_findings')return tool
    const schema=tool.input_schema as {properties:Record<string,unknown>;required?:string[]}
    const properties={...schema.properties};delete properties[kind==='visual'?'intent_observations':'visual_observations']
    const required=[...(schema.required??[])]
    if(kind==='visual')required.push('visual_observations')
    else if(readPrdBackplane(projectId).requirements_model?.experience)required.push('intent_observations')
    return{...tool,input_schema:{...tool.input_schema,properties,required}}
  })
  const reviewTools = (tools: AgentLoopTool[], child?: string): AgentLoopTool[] => child && readQualityLedger(projectId).reviews.find(r => r.id === children.get(child))?.kind === 'visual' ? reviewProtocol('visual') : [...tools.filter(t => ['read_file', 'list_files', 'find', 'grep'].includes(t.name)).map(tool => ({
    ...tool, execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      if (readQualityLedger(projectId).reviews.find(r => r.id === children.get(ctx.sessionId))?.kind === 'visual') throw Error('VISUAL_SOURCE_READ_DENIED: V只使用授权图片和操作事实')
      const review=readQualityLedger(projectId).reviews.find(r=>r.id===children.get(ctx.sessionId))
      const path=typeof input.path==='string'?input.path.replaceAll('\\','/').replace(/^\.\//,''):''
      const read=tool.name==='read_file'?reviewReadIdentity(review?.source_manifest,path,input):undefined
      const key=read?ctx.sessionId+':'+read.key:undefined
      if(key&&providedReads.has(key))return{output:JSON.stringify({already_provided:providedReads.get(key),requested_path:path,sha256:read!.sha256,aliases:read!.aliases,note:'相同字节和读取范围已在本次审查提供；需要其它范围时照常读取。'})}
      const result = await tool.execute(input, ctx)
      if(key&&!result.isError)providedReads.set(key,path)
      if (tool.name === 'read_file' && !result.isError && children.has(ctx.sessionId)) sourceRead.add(ctx.sessionId)
      return result
    }
  })), ...reviewProtocol(child?'code':undefined)]
  const wrapQuery = (query: SDKQuery, settleCorrections?: (signal:AbortSignal)=>Promise<void>): SDKQuery => async function* (prompt, options) {
    const route = routeIdentity(options.env,options.providerType)
    activeRoute = route
    let ledger = readQualityLedger(projectId)
    if (options.sessionId === parent) {
      if(pendingTestCorrection(projectId)&&settleCorrections)await settleCorrections(options.signal)
      if(pendingTestCorrection(projectId))throw new ModelRequestRefusal('TEST_CORRECTION_REVIEW_REQUIRED: 已保存提案，独立裁定前停止模型调用；制作方不能自行批准。')
      const active = ledger.reviews.filter(r => r.child && children.has(r.child) && r.delegation).map(r => findDelegation(parent, r.delegation!)).filter(r => r?.status === 'running' && !r.pendingQuestion)
      if (active.length) { await withAbort(Promise.all(active.map(r => r!.completion)), options.signal); ledger = readQualityLedger(projectId) }
    }
    if (options.sessionId === parent && ledger.reviews.filter(r => r.run_id === options.accounting?.runId && r.status === 'interrupted').length >= 2) {
      const repeated = repeatedReviewFailure(ledger, await identity(projectId, options.signal), options.accounting?.runId)
      if (repeated) throw Error('QUALITY_REVIEW_RETRY_BLOCKED: 同一候选同类审阅连续两次同因中断，停止本轮新调用并保留现场；先诊断后显式续跑，不重复开审阅。' + repeated)
    }
    const review = ledger.reviews.find(r => r.id === children.get(options.sessionId))
    if (review?.kind !== 'visual') { yield* query(prompt, options); return }
    if (!review.visual || !review.image || !same(review.identity, await identity(projectId, options.signal))) throw Error('VISUAL_QUERY_CANDIDATE_STALE')
    validateVisualGrant(review.visual, options.sessionId, review.image)
    const requested = imagesRequested.has(options.sessionId)
    let requestHash: string | undefined, started = false, success = false
    try { for await (const message of query(prompt, { ...options, requestGuard: request => {
      options.requestGuard?.(request)
      validateVisualGrant(review.visual!, options.sessionId, review.image!)
      if (requested) requestHash = assertVisualRequest(request.body, review.visual!.image_hash)
    }, onTransportAttempt: state => { options.onTransportAttempt?.(state); started = state === 'started' }, })) {
      if (message.type === 'result') success = message.subtype === 'success'
      yield message
    } } catch (error) {
      if (String(error).includes('不支持图片输入')) {
        const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
        stored.visual_error = 'MODEL_IMAGE_INPUT_UNSUPPORTED'; stored.visual_route = route; save(ledger)
      }
      throw error
    }
    options.signal.throwIfAborted()
    if (requested && requestHash && started && success) {
      validateVisualGrant(review.visual, options.sessionId, review.image)
      if (!same(review.identity, await identity(projectId, options.signal))) throw Error('VISUAL_QUERY_CANDIDATE_STALE')
      const ledger = readQualityLedger(projectId), stored = ledger.reviews.find(r => r.id === review.id)!
      stored.visual_delivery = { at: new Date().toISOString(), image_hash: review.visual.image_hash, request_hash: requestHash }; save(ledger)
    }
  }
  const childAfterTools=(child:string):AgentLoopInput['afterTools']=>async(_ctx,calls)=>{
    if(calls.some(c=>c.status!=='ok'||c.pending)||!calls.some(c=>c.name==='submit_quality_findings'))return
    if(readQualityLedger(projectId).reviews.some(r=>r.child===child&&r.status==='complete'))return{complete:true}
  }
  return { prepare, system, gate, begin, ensureCoverage, childAfterTools, acceptedHandoff:(delegation:string,child:string)=>readQualityLedger(projectId).reviews.some(r=>r.delegation===delegation&&r.child===child&&r.status==='complete'), completionAction: async (signal?: AbortSignal) => { const existing=await deliveryQualityBlock(projectId,signal,activeRoute),observedGap=observationGap(),reason=existing??(observedGap?{code:'code_review' as const,message:observedGap}:undefined), current = await identity(projectId, signal); const ledger=applicableQualityLedger(projectId);return {...qualityCloseout(ledger,current,reason,rulesVersion(projectId),independentDesignVersion(projectId),currentObservation()?.digest),feedback:JSON.stringify(qualityWorkQueue(ledger,current,reason,rulesVersion(projectId),independentDesignVersion(projectId)))} }, parentTools, reviewTools, wrapQuery, isQualityChild: (child: string) => children.has(child),
    // The role-only tool builder cannot know the child ID until execute. Protocol
    // tools authenticate the actual session, including against parent forgeries.
    childProtocol }
}
