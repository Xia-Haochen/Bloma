import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { readIndependentDesign, readIndependentPolicy, independentDesignVersion } from './independent-design'
import { independentDesignMatchesPolicy } from './independent-policy'
import { observeSoftwareGui } from './gui-observer'
import type { SoftwareRelease } from './release-store'
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import type { IndependentSemantics, IndependentStep } from './independent-semantics'
import { currentIndependentSemantics, independentChallengeVersion } from './independent-quality'
import { qualityHash } from './quality-ledger'
import { runHostSpeechProbe, type SpeechVerificationSpec } from '../desktop/speech-verification'
import { CORE_MANIFEST_REL, type CoreVerificationResult } from '../desktop/core-verification'
import { prepareAcceptanceEnvironment, AcceptanceEnvironmentError, type AcceptanceEnvironment, type AcceptanceEnvironmentEvidence } from './acceptance-environment'
import { requirementCapabilities } from '../model/requirement-capabilities'
import { isStaticGuiSelector } from './gui-selectors'
import { sealGuiFixtures, materializeGuiFixtures } from '../desktop/gui-fixtures'
import { mainRootDir } from '../platform/paths'

export interface IndependentCaseResult { id: string; feature: string; status: 'passed' | 'failed' | 'unverified' | 'not_run'; kind: 'product_assertion' | 'product_runtime' | 'semantic' | 'adapter' | 'environment' | 'none'; expected_source?: string; issues?: string[]; steps: Array<{ id: string; passed: boolean; actual?: unknown }>; error?: string; evidence_warnings?:string[]; environment?: AcceptanceEnvironmentEvidence }
export interface IndependentVerification { status: 'disabled' | 'passed' | 'failed' | 'unverified'; semantics?: IndependentSemantics; case_results?: IndependentCaseResult[]; design_version?: string; design_digest?: string
  execution_scope?: 'registered_cases'|'registered_cases_with_controlled_service'
  external_model_effects?: 'not_required'|'unverified'
  error?: string; diagnostic?: { id: string; expected: string; actual: unknown }; report_path?: string }

export function independentAdapterVersion(root:string){
  const file=join(root,'INDEPENDENT_ADAPTER.json')
  return existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null
}

function stepControls(step: IndependentStep): string[] {
  if (!('control' in step)) return []
  return step.kind === 'expect_audio' && step.text_control ? [step.control, step.text_control] : [step.control]
}
function readIndependentAdapter(root: string, digest: string | undefined, controls: Set<string>) {
  const file=join(root,'INDEPENDENT_ADAPTER.json')
  if(!existsSync(file))throw Error('INDEPENDENT_ADAPTER_REQUIRED: 提供版本1的controls逻辑控件名到静态CSS选择器映射，不含输入或断言')
  const text=readFileSync(file,'utf8');if(Buffer.byteLength(text)>32*1024)throw Error('INDEPENDENT_ADAPTER_TOO_LARGE')
  const adapter=JSON.parse(text) as {version:number;design_digest:string;controls:Record<string,string>}
  if(!adapter||adapter.version!==1||adapter.design_digest!==digest||Object.keys(adapter).some(key=>!['version','design_digest','controls'].includes(key))||!adapter.controls||typeof adapter.controls!=='object'||Array.isArray(adapter.controls))throw Error('INDEPENDENT_ADAPTER_INVALID')
  const missing = [...controls].filter(key => !Object.hasOwn(adapter.controls,key))
  const invalid = [...controls].filter(key => Object.hasOwn(adapter.controls,key) && !isStaticGuiSelector(adapter.controls[key]))
  if (missing.length || invalid.length) throw Error('INDEPENDENT_ADAPTER_STATIC_CSS_REQUIRED: '+JSON.stringify({
    missing:missing.slice(0,20),invalid:invalid.slice(0,20),
    next:'只需要补齐当前案例实际用到的静态 CSS。多余控件不会参与执行。模型设置由 CORE_CHECK.llm.settings 管理。',
  }))
  return adapter.controls
}

/** Cheap input check. A valid mapping still needs actual GUI execution. */
export function independentAdapterPreflight(projectId: string, root: string) {
  if (!readIndependentPolicy(projectId)?.enabled) return
  const design = readIndependentDesign(projectId)
  if (design?.status !== 'frozen' || !design.contract) return
  const semantics = currentIndependentSemantics(projectId, design.contract)
  const grounded = new Set(semantics.cases.filter(row => row.status === 'grounded').map(row => row.id))
  const required = new Set(design.contract.cases.filter(item => grounded.has(item.id)).flatMap(item => item.steps.flatMap(stepControls)))
  if (!required.size) return
  try {
    readIndependentAdapter(root, design.digest, required)
    return { status: 'ready_for_execution' as const, required_controls: [...required] }
  } catch (error) {
    return { status: 'mapping_pending' as const, required_controls: [...required], detail: String(error),
      next: '先用 inspect_app 核对正常入口的实际控件，再绑定映射。可优先沿用现有控件，无需为映射改变默认页面。' }
  }
}

/** Adapter values are selectors only. All action values, assertions and order
 * come from the host-frozen B design, never from implementer-authored code. */
export function independentSuite(projectId:string,root:string,caseIds?:string[]):GuiAcceptanceSuite{
  const record=readIndependentDesign(projectId),project=findProject(projectId)
  const policy=readIndependentPolicy(projectId)
  if(record?.status!=='frozen'||!record.contract||record.scope!==prdScopeFingerprint(readPrdBackplane(projectId))
    ||record.operation!==(project.lean_operation_id??'initial')||record.design_hash!==project.ux_confirmation?.design_hash
    ||policy?.enabled&&!independentDesignMatchesPolicy(record,policy))throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  const semantics=currentIndependentSemantics(projectId,record.contract)
  const selected=caseIds?record.contract.cases.filter(c=>caseIds.includes(c.id)):record.contract.cases
  if(!selected.length||caseIds&&selected.length!==caseIds.length||selected.some(c=>semantics.cases.find(s=>s.id===c.id)?.status!=='grounded')||!caseIds&&!semantics.ready)throw Error('INDEPENDENT_SEMANTICS_UNRESOLVED: 不得执行无依据预期或把争议写成产品缺陷')
  if (selected.some(item => item.steps.some(step => step.kind === 'speech_probe'))) throw Error('INDEPENDENT_SPEECH_REQUIRES_HOST_PROBE')
  const controls = readIndependentAdapter(root, record.digest, new Set(selected.flatMap(item => item.steps.flatMap(stepControls))))
  const suite:GuiAcceptanceSuite = {version:1,scope_hash:record.scope,design_hash:record.design_hash,covers:[...new Set(selected.map(item=>item.feature))],steps:selected.flatMap(item=>item.steps.map((step,index)=>{
    const id=`${item.id}-${index}`
    if(step.kind==='restart')return{id,kind:'restart' as const}
    if(step.kind==='speech_probe')throw Error('INDEPENDENT_SPEECH_REQUIRES_HOST_PROBE')
    const selector=controls[step.control]
    if(step.kind==='expect_audio')return{id,kind:'expect_audio' as const,selector,text_selector:step.text_control?controls[step.text_control]:undefined}
    if(step.kind==='speech_input')return{id,kind:'upload' as const,selector,path:step.sample==='silence'?'input/voice-silence.wav':'input/voice-golden.wav'}
    if(step.kind==='fill')return{id,kind:'fill' as const,selector,value:step.value}
    if(step.kind==='click')return{id,kind:'click' as const,selector}
    return{id,kind:'expect' as const,selector,property:step.property,
      ...(['nonempty','observed'].includes(step.oracle?.kind ?? '') ? {nonempty:true as const} : {equals:step.equals})}
  }))}
  if (selected.some(item => item.steps.some(step => step.kind === 'speech_input'))) {
    const samples = new Set(selected.flatMap(item=>item.steps.filter(step=>step.kind==='speech_input').map(step=>step.sample==='silence'?'voice-silence.wav':'voice-golden.wav')))
    suite.fixtures = [...samples].map(source=>({path:'input/'+source,source}))
    return sealGuiFixtures(projectId,join(mainRootDir(),'templates/tools'),suite)
  }
  return suite
}
export async function verifyIndependentDesign(projectId:string,candidate:SoftwareRelease,signal?:AbortSignal,
  core?: Pick<CoreVerificationResult, 'speech'>):Promise<IndependentVerification>{
  const policy=readIndependentPolicy(projectId)
  if(!policy&&readIndependentDesign(projectId))throw Error('INDEPENDENT_POLICY_MISSING')
  if(!policy?.enabled)return{status:'disabled' as const}
  const record=readIndependentDesign(projectId),brief=readPrdBackplane(projectId)
  if(record?.status!=='frozen'||!record.contract)throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  // Check the target even when every proposal is disputed and no process runs.
  if(record.scope!==prdScopeFingerprint(brief)||record.operation!==(findProject(projectId).lean_operation_id??'initial')||record.design_hash!==findProject(projectId).ux_confirmation?.design_hash
    ||!independentDesignMatchesPolicy(record,policy))throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  const semantics=currentIndependentSemantics(projectId,record.contract)
  const designVersion=independentDesignVersion(projectId),challengeVersion=independentChallengeVersion(projectId)
  const directory=join(getPromaHome(),'software-independent-evidence',projectId,randomUUID())
  mkdirSync(directory,{recursive:true})
  const cases:IndependentCaseResult[]=[],version=independentAdapterVersion(candidate.root)
  const progress=()=>writeTextFileAtomic(join(directory,'in-progress.json'),JSON.stringify({state:'incomplete',candidate_id:candidate.id,design:record.digest,semantics,cases,at:new Date().toISOString()}))
  progress()
  let diagnostic:IndependentVerification['diagnostic']
  // The caller can reuse the probe it just ran against the same frozen candidate.
  let speech = core?.speech
  for(const item of record.contract.cases){
    signal?.throwIfAborted()
    const semantic=semantics.cases.find(c=>c.id===item.id)!,requirement=brief.requirements.find(r=>r.id===item.feature)!
    if(semantic.status!=='grounded'){cases.push({id:item.id,feature:item.feature,status:'not_run',kind:'semantic',issues:semantic.issues,steps:[],expected_source:requirement&&trustedAcceptance(brief,requirement)});progress();continue}
    try{
      if (item.steps[0]?.kind === 'speech_probe') {
        const manifest = join(candidate.root, CORE_MANIFEST_REL)
        const spec: SpeechVerificationSpec | undefined = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).speech : undefined
        if (spec) speech ??= await runHostSpeechProbe({ projectId, root: candidate.root, speech: spec, signal })
        else speech = undefined
        const status = speech?.status === 'passed' ? 'passed' : speech?.status === 'failed' ? 'failed' : 'unverified'
        cases.push({ id:item.id, feature:item.feature, status,
          kind:status === 'passed' ? 'none' : status === 'failed' ? 'product_assertion' : spec ? 'environment' : 'adapter',
          steps: speech?.tests?.map(test => ({ id:`${item.id}-${test.name}`, passed:test.passed, actual:test })) ?? [],
          error: status === 'passed' ? undefined : speech?.error ?? (spec ? '固定音频转写检查未通过' : '缺少产品实际转写入口登记'),
          expected_source:requirement && trustedAcceptance(brief, requirement) })
        progress()
        continue
      }
      const suite=independentSuite(projectId,candidate.root,[item.id]),base=join(directory,String(cases.length)),temporary=mkdtempSync(join(tmpdir(),'bloma-b-'))
      // Each case gets fresh data; restart segments within the case retain it.
      let observed:Awaited<ReturnType<typeof observeSoftwareGui>>
      const comparisons = Object.fromEntries(item.steps.flatMap((step, index) =>
        step.kind === 'expect' && step.oracle?.kind === 'observed' ? [[`${item.id}-${index}`, `${item.id}-${step.oracle.step}`]] : []))
      let environment:AcceptanceEnvironment|undefined,environmentEvidence:AcceptanceEnvironmentEvidence|undefined
      try {
        materializeGuiFixtures(projectId,suite,join(temporary,'data'))
        const features=[item.feature,...(item.related??[]).map(row=>row.feature)]
        environment=await prepareAcceptanceEnvironment({root:candidate.root,features,signal,
          requiresLlm:Boolean(item.service)||brief.requirements.some(row=>features.includes(row.id)&&requirementCapabilities(row).has('llm')),
          requestExpectation:item.service?.requests})
        observed=await observeSoftwareGui({projectId,root:candidate.root,launch:candidate.launch,suite,temporary,screenshotDir:join(base,'evidence'),signal,purpose:'acceptance',comparisons,environment})
        environmentEvidence=environment.evidence()
      } finally {
        try { await environment?.close() } finally {
          const target=realpathSync(temporary);if(dirname(target)!==realpathSync(tmpdir())||!basename(target).startsWith('bloma-b-'))throw Error('INDEPENDENT_CLEANUP_PATH_INVALID');rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100})
        }
      }
      const failed=observed.steps.find(s=>!s.passed),step=suite.steps.find(s=>s.id===failed?.id)
      const assertion=observed.status==='failed'&&(step?.kind==='expect'||step?.kind==='expect_audio')&&observed.error?.startsWith(`GUI_ASSERTION_FAILED:${step.id}`)
      const runtime=observed.failure_kind==='runtime'
      const environmentBlocked=observed.error?.startsWith('ACCEPTANCE_ENVIRONMENT_')===true
      const status=environmentBlocked?'unverified':observed.status==='passed'?'passed':assertion||runtime?'failed':'unverified'
      cases.push({id:item.id,feature:item.feature,status,kind:status==='passed'?'none':environmentBlocked?'environment':runtime?'product_runtime':assertion?'product_assertion':failed?'adapter':'environment',steps:observed.steps,error:observed.error,evidence_warnings:observed.evidence_warnings,expected_source:trustedAcceptance(brief,requirement),environment:environmentEvidence})
      if (failed && !diagnostic) {
        const source = comparisons[failed.id]
        const expected = source ? observed.steps.find(row => row.id === source && row.passed)?.actual
          : step?.kind === 'expect_audio' ? '非静音音频实际播放至结尾' : step?.kind === 'expect' ? step.equals ?? '非空输出' : '冻结的独立业务步骤'
        diagnostic = {id:failed.id,expected:String(expected ?? '缺少先前有效观察'),actual:failed.actual}
      }
    }catch(error){signal?.throwIfAborted();cases.push({id:item.id,feature:item.feature,status:'unverified',kind:error instanceof AcceptanceEnvironmentError?'environment':'adapter',steps:[],error:String(error),expected_source:trustedAcceptance(brief,requirement)})}
    progress()
  }
  const result:IndependentVerification={status:cases.some(c=>c.status==='failed')?'failed':semantics.ready&&cases.every(c=>c.status==='passed')?'passed':'unverified',semantics,case_results:cases,design_digest:record.digest,design_version:designVersion,diagnostic,report_path:join(directory,'report.json')}
  const controlled=cases.some(row=>row.environment?.mode==='controlled_service')
  result.execution_scope=controlled?'registered_cases_with_controlled_service':'registered_cases'
  result.external_model_effects=controlled||brief.requirements.some(row=>requirementCapabilities(row).has('llm'))
    ||cases.some(row=>row.error?.includes('ACCEPTANCE_ENVIRONMENT_'))?'unverified':'not_required'
  if(independentAdapterVersion(candidate.root)!==version||independentDesignVersion(projectId)!==designVersion||independentChallengeVersion(projectId)!==challengeVersion||prdScopeFingerprint(readPrdBackplane(projectId))!==record.scope)throw Error('INDEPENDENT_INPUT_CHANGED')
  if(result.status==='unverified')result.error=!semantics.ready?'INDEPENDENT_SEMANTICS_UNRESOLVED: 预期或覆盖声明有争议，不是已确认产品缺陷'
    :cases.find(row=>row.kind==='environment')?.error??'INDEPENDENT_EXECUTION_UNVERIFIED: 检查适配器或执行环境'
  writeTextFileAtomic(result.report_path!,JSON.stringify({state:'complete',result,candidate_id:candidate.id,candidate_source:candidate.source.digest,adapter:version,contract_hash:qualityHash(record.contract),at:new Date().toISOString()}))
  return result
}
