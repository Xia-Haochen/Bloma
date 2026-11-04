import { ReleaseIntegrityError } from './release-store'
import type { SoftwareVerification } from './verification'
import { NativeTestContractError } from './native-gui-tests'

export interface VerificationFailure {
  category: 'product_assertion' | 'test_adapter' | 'environment' | 'harness' | 'security_policy' | 'unknown'
  classification_basis?: 'host_runtime'|'assertion'|'adapter_contract'|'static_policy'|'unresolved'|'legacy'
  observation?: { status: SoftwareVerification['status']; candidate_id?: string; source?: string; expected: unknown; actual: unknown }
  diagnosis?: { certainty: 'supported'|'suspected'|'unknown'; basis: string; root_cause_confirmed: false; note: string }
  code: string
  step?: string
  expected: unknown
  actual: unknown
  paths: string[]
  allowed_changes: string[]
  next_tool: string
  next_action?: {tool:string;arguments:Record<string,unknown>}
  next: string
}
export function verificationFailure(result: SoftwareVerification, error?: unknown): VerificationFailure | undefined {
  if (result.status === 'passed') return
  if(result.status==='unverified'&&result.independent?.semantics?.ready===false)return{
    category:'unknown',classification_basis:'unresolved',code:'INDEPENDENT_SEMANTICS_UNRESOLVED',expected:'已确认需求和可追溯的冻结独立预期',actual:result.independent.semantics,paths:[],
    observation:{status:result.status,candidate_id:result.candidate?.id,source:result.candidate?.source.digest,expected:'已确认需求和可追溯预期',actual:result.independent.semantics},
    diagnosis:{certainty:'unknown',basis:'unresolved',root_cause_confirmed:false,note:'业务预期存在争议，尚无产品缺陷结论。'},
    allowed_changes:['核对确认来源与未明确规则，保留争议；不得让实现者修改冻结输入、断言或新增需求'],next_tool:'read_production_context',next_action:{tool:'read_production_context',arguments:{topic:'independent-design'}},next:'先澄清业务预期或覆盖争议，保留现有候选和案例；这不是已确认产品缺陷，不自动修产品迎合错误预期，也不自动重发B。'}
  const summary = result.summary??'', gui = result.core?.host_gui
  const failed = gui?.steps?.find(step => !step.passed)
  const independent=result.independent&&'diagnostic'in result.independent?result.independent.diagnostic:undefined
  const assertion = failed?.actual && typeof failed.actual === 'object' ? (failed.actual as { assertion?: { expected?: unknown; actual?: unknown } }).assertion : undefined
  const cli = result.core?.host_cli?.cases.find(row => !row.passed)
  const security = result.security?.issues.filter(row => row.severity === 'critical' || row.severity === 'high')
  const details = summary + '\n' + JSON.stringify(failed?.actual ?? '')
  const adapterContract = /INDEPENDENT_ADAPTER|GUI_NATIVE_(?:PATH|SYNTAX|CASE|REPORT|ASSERTIONS|EVIDENCE|COVERAGE|INPUT|TEST_SOURCE|DEPENDENCY|PACKAGE|BOOTSTRAP)|GUI_EXISTING_EXPECTATIONS|EVIDENCE_(?:PATH|DIRECTORY)/.test(details)
  // A timeout alone can be a broken UI, overlay, wrong locator or slow runtime.
  // Only the contradictory hidden-selector + visible wait is decisive here.
  const contradictoryWait = /waiting for (?:locator|selector)[^\n]*\[hidden\][^\n]*to be visible/i.test(details)
  const ambiguousWait = /TimeoutError|strict mode violation|waiting for (?:locator|getBy)|intercepts pointer events/.test(details)
  const kind = gui?.failure_kind
  const explicitAssertion = Boolean(assertion && (assertion.expected !== undefined || assertion.actual !== undefined) || cli?.expected && cli.exit_code !== null
    || independent&&result.independent?.case_results?.some(row=>row.status==='failed'&&row.kind==='product_assertion'))
  const category: VerificationFailure['category'] = result.status === 'environment_blocked' ? 'environment'
    : security?.length ? 'security_policy'
    : kind === 'runtime' ? 'product_assertion'
    : kind === 'bootstrap' || adapterContract || contradictoryWait ? 'test_adapter'
    : explicitAssertion ? 'product_assertion'
    : ambiguousWait || kind === 'assertion' ? 'unknown'
    : kind === 'incomplete' ? 'harness'
    : 'unknown'
  const release = error instanceof ReleaseIntegrityError ? error : undefined
  const expected = independent?.expected ?? assertion?.expected ?? cli?.expected ?? (security?.length ? '通过现役静态安全规则；规则命中不等同已证实漏洞' : undefined)
  const actual = independent?.actual ?? assertion?.actual ?? failed?.actual ?? (cli ? {stdout:cli.actual,exit_code:cli.exit_code,stderr:cli.stderr} : security?.length ? security : summary)
  const basis = category==='security_policy'?'static_policy':kind==='runtime'?'host_runtime':category==='test_adapter'?'adapter_contract':explicitAssertion?'assertion':'unresolved'
  const next_action=category==='environment'?{tool:'inspect_software_environment',arguments:{}}
    :category==='security_policy'&&security?.[0]?.file?{tool:'read_file',arguments:{path:security[0].file}}
    :category==='product_assertion'&&explicitAssertion?{tool:'read_production_context',arguments:{topic:'features',...(cli?{feature_ids:cli.covers}:{})}}
    :category==='test_adapter'?{tool:'read_production_context',arguments:{topic:'verification-gui'}}
    :{tool:'read_production_context',arguments:{topic:'diagnostics'}}
  return { category, classification_basis:basis,
    observation:{status:result.status,candidate_id:result.candidate?.id,source:result.candidate?.source.digest,expected,actual},
    diagnosis:{certainty:explicitAssertion||security?.length||kind==='runtime'?'supported':category==='test_adapter'?'suspected':'unknown',basis,root_cause_confirmed:false,
      note:explicitAssertion?'仅确认实际结果不符合登记断言；先核对预期来源，不等于确认业务实现根因。':category==='security_policy'?'仅确认静态规则命中，不据此宣称漏洞可利用。':'原因未闭合；按当前现场检查，不把检查失败直接等同产品缺陷。'},
    code: contradictoryWait && category === 'test_adapter' ? 'TEST_WAIT_STATE_CONTRADICTION' : summary.match(/\b[A-Z][A-Z_]{4,}\b/)?.[0] ?? (category === 'security_policy'?'STATIC_POLICY_BLOCKED':category === 'product_assertion' ? 'PRODUCT_CHECK_FAILED' : 'VERIFICATION_INCOMPLETE'),
    step: independent?.id??failed?.id??cli?.name, expected, actual,
    paths: release?.differences.map(item => item.path) ?? (error instanceof NativeTestContractError ? error.paths.slice(0, 24) : []),
    allowed_changes: category==='security_policy'?['核对命中规则及具体数据来源；修正应用写法，不关闭规则或宣称已证实漏洞']:category === 'unknown'?['先核对实际界面、进程和日志；原因尚未确定，不修改业务输入或断言'] : category === 'test_adapter' ? ['测试定位的静态字面量', '有界等待时间和导航等待选项；业务输入、目标页面和断言保持冻结'] : category === 'product_assertion' ? ['先核对断言预期的确认来源，再修应用实现；断言不等同业务根因，不得降低已确认预期'] : ['宿主证据目录和执行环境；不得绕过完整性校验'],
    next_tool:next_action.tool,next_action,
    next: category==='unknown'?'根因尚未确定，先读diagnostics核对进程和日志；涉及GUI时再inspect_app，不把命令行失败送到GUI工具。不放宽预期或超时掩盖问题。':category==='environment'?'先检查实际运行环境，确认缺失的runtime后再准备；不猜参数、不修改业务预期。':release ? '将测试输出写入上下文 evidenceDir；相对截图路径自动落入该目录。不要在成品增加验收痕迹清理逻辑。业务或依赖改变需重新生成候选并实测。' : category === 'test_adapter' ? '使用inspect_app核对实际UI后修正定位或等待适配，再verify_app(script)；若冻结规则拒绝改动，保留契约错误并核对适配范围，不改产品迎合脚本，不改输入和断言。' : '先核对具体证据和确认预期，原因明确后再修复并重新验收。' }
}
