import { deriveExpected } from './independent-oracles'
import { createHash } from 'node:crypto'
import type { PrdBackplane } from '../model/prd-backplane'
import { requirementEvidenceHash, trustedAcceptance } from '../project/requirement-contract'
import { requirementCapabilities } from '../model/requirement-capabilities'

export const INDEPENDENT_CATEGORIES = ['normal', 'multi_object', 'exception', 'cancel', 'reopen'] as const
export type IndependentCategory = typeof INDEPENDENT_CATEGORIES[number]
export type IndependentOracle = { kind: 'derived'; version: 1; rule_id: string; steps: number[] } | { kind: 'input'; step: number } | { kind: 'literal'; quote: string; feature?: string } | { kind: 'unresolved'; question: string }
export type IndependentStep = ({ kind: 'fill'; control: string; value: string } | { kind: 'click'; control: string; intent?: 'submit' | 'cancel' }
  | { kind: 'expect'; control: string; equals: string; property?: 'text' | 'value'; oracle?: IndependentOracle }
  | { kind: 'restart' } | { kind: 'speech_probe' }) & { subject?: string }
export interface IndependentCase { id: string; feature: string; steps: IndependentStep[]
  basis?: { requirement_hash: string; expected_source: string }; related?:Array<{feature:string;requirement_hash:string;expected_source:string}>; coverage?: IndependentCategory[] }
export interface IndependentCases { cases: IndependentCase[]; coverage_notes?: Array<{ feature: string; category: IndependentCategory; disposition: 'not_applicable' | 'unresolved'; reason: string; source: string }> }
export interface IndependentSemantics { version: 1; digest: string; cases: Array<{ id: string; feature: string; status: 'grounded' | 'disputed'; issues: string[] }>
  coverage: Array<{ feature: string; category: IndependentCategory; status: 'declared_cases' | 'declared_not_applicable' | 'unresolved' | 'missing'; cases: string[]; reason?: string }>; ready: boolean }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
/** Conservative positive signals only, not a natural-language scope proof.
 * Explicit exclusions stay exclusions; an uncertain category remains declared. */
function explicitlyRequested(source: string, category: IndependentCategory) {
  const patterns: Record<IndependentCategory, RegExp> = { normal: /./, multi_object: /多对象|两(?:条|个|件|项)(?:记录|对象|物品|资料)|修改A.*B|A与B|A和B/, exception: /异常|无效|非法|错误|空(?:白|名称|输入|值)|失败|超库存/, cancel: /取消|撤销编辑|放弃.*编辑/, reopen: /重开|重新打开|重启|退出后.*(?:保留|恢复)/ }
  return source.split(/[；;。!?！？\n]/).some(clause => !/不(?:要求|需要|支持|做)|无需|无须|不在范围|范围外/.test(clause) && patterns[category].test(clause))
}

export function independentCategoryRequested(brief: PrdBackplane, feature: string, category: IndependentCategory): boolean {
  const requirement = brief.requirements.find(row => row.id === feature)
  return !!requirement && explicitlyRequested([
    requirement.description, trustedAcceptance(brief, requirement), ...(requirement.behavior_assertions ?? []),
  ].join('；'), category)
}

/** Contains only a stable code and a schema path, never model response text. */
export class IndependentCaseFormatError extends Error {}

function validateOracle(value: unknown, path: string): void {
  const fail = (field: string, message: string): never => {
    throw new IndependentCaseFormatError(`INDEPENDENT_ORACLE_INVALID: ${path}${field} ${message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('', '须为 JSON 对象')
  }
  const oracle = value as Record<string, unknown>
  const fields = (required: string[], optional: string[] = []) => {
    for (const field of required) {
      if (!Object.hasOwn(oracle, field)) fail(`.${field}`, '缺少必填字段')
    }
    if (!keys(oracle, ['kind', ...required, ...optional])) fail('', `仅允许字段 kind、${[...required, ...optional].join('、')}，请删除多余字段`)
  }
  const nonblank = (field: 'quote' | 'question') => {
    const value = oracle[field]
    if (!text(value) || !value.trim()) fail(`.${field}`, '须为非空字符串，最多 4000 字符')
  }
  const stepNumber = (index: unknown) => typeof index === 'number' && Number.isSafeInteger(index) && index >= 0

  switch (oracle.kind) {
    case 'input':
      fields(['step'])
      if (!stepNumber(oracle.step)) fail('.step', '须为从 0 开始的整数步骤序号')
      return
    case 'literal':
      fields(['quote'], ['feature'])
      nonblank('quote')
      if (Object.hasOwn(oracle, 'feature') && (typeof oracle.feature !== 'string' || !/^F-\d{3,}$/.test(oracle.feature))) {
        fail('.feature', '须为确认任务单中的功能编号，如 F-001')
      }
      return
    case 'derived': {
      fields(['version', 'rule_id', 'steps'])
      if (oracle.version !== 1) fail('.version', '须为数字 1')
      if (typeof oracle.rule_id !== 'string' || !/^BR-\d{3,}$/.test(oracle.rule_id)) fail('.rule_id', '须为已确认的规则编号，格式如 BR-001')
      const steps = oracle.steps
      if (!Array.isArray(steps) || !steps.length || steps.length > 32 || new Set(steps).size !== steps.length || !steps.every(stepNumber)) {
        fail('.steps', '须含 1 至 32 个互不重复的从 0 开始的整数步骤序号')
      }
      return
    }
    case 'unresolved':
      fields(['question'])
      nonblank('question')
      return
    default:
      fail('.kind', Object.hasOwn(oracle, 'kind')
        ? '须为 input、literal、derived 或 unresolved'
        : '缺少必填字段，须为 input、literal、derived 或 unresolved')
  }
}

/** Shape validation keeps all proposed business assertions intact. Semantic
 * disputes are assessed separately, never repaired by changing B's bytes. */
export function parseIndependentCases(textValue: string, features: string[]): IndependentCases {
  if (Buffer.byteLength(textValue) > 64 * 1024) throw new IndependentCaseFormatError('INDEPENDENT_CASES_TOO_LARGE')
  const raw = textValue.trim()
  const fenced = raw.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i)
  let value: IndependentCases
  try { value = JSON.parse(fenced?.[1] ?? raw) } catch {
    throw new IndependentCaseFormatError('INDEPENDENT_JSON_INVALID: 应返回一个完整 JSON 对象')
  }
  if (!value || !keys(value, ['cases', 'coverage_notes']) || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 12
    || new Set(value.cases.map(c => c?.id)).size !== value.cases.length) throw new IndependentCaseFormatError('INDEPENDENT_CASES_INVALID: cases')
  const identifier = (input: unknown) => typeof input === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input)
  for (const [caseIndex, item] of value.cases.entries()) {
    const path = `cases[${caseIndex}]`
    if (!item || !keys(item, ['id', 'feature', 'steps', 'basis', 'coverage', 'related']) || !identifier(item.id) || !features.includes(item.feature)) {
      throw new IndependentCaseFormatError(`INDEPENDENT_CASE_INVALID: ${path} 的 id、feature 或字段不合法`)
    }
    const speechProbe = Array.isArray(item.steps) && item.steps.length === 1 && item.steps[0]?.kind === 'speech_probe'
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > 32 || !speechProbe &&
      (!item.steps.some(s => s?.kind === 'expect') || !item.steps.some(s => s?.kind === 'click' || s?.kind === 'fill'))) {
      throw new IndependentCaseFormatError(`INDEPENDENT_CASE_INVALID: ${path}.steps 须包含操作和断言`)
    }
    if (item.basis !== undefined && (!item.basis || !keys(item.basis, ['requirement_hash', 'expected_source']) || !text(item.basis.requirement_hash, 64) || !text(item.basis.expected_source))) throw new IndependentCaseFormatError(`INDEPENDENT_BASIS_INVALID: ${path}.basis`)
    if(item.related!==undefined&&(!Array.isArray(item.related)||item.related.length>8||new Set(item.related.map(r=>r?.feature)).size!==item.related.length||item.related.some(r=>!r||!keys(r,['feature','requirement_hash','expected_source'])||r.feature===item.feature||!features.includes(r.feature)||!text(r.requirement_hash,64)||!text(r.expected_source))))throw new IndependentCaseFormatError(`INDEPENDENT_RELATED_INVALID: ${path}.related`)
    if (item.coverage !== undefined && (!Array.isArray(item.coverage) || !item.coverage.length || new Set(item.coverage).size !== item.coverage.length || item.coverage.some(c => !INDEPENDENT_CATEGORIES.includes(c)))) throw new IndependentCaseFormatError(`INDEPENDENT_COVERAGE_INVALID: ${path}.coverage`)
    for (const [stepIndex, step] of item.steps.entries()) {
      const stepPath = `${path}.steps[${stepIndex}]`
      if (!step) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}`)
      const allowed = step.kind === 'fill' ? ['kind', 'control', 'value', 'subject'] : step.kind === 'expect' ? ['kind', 'control', 'equals', 'oracle', 'property', 'subject'] : step.kind === 'click' ? ['kind', 'control', 'subject', 'intent'] : step.kind === 'restart' || speechProbe && step.kind === 'speech_probe' ? ['kind'] : []
      if (!allowed.length || !keys(step, allowed)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}`)
      if ('control' in step ? !identifier(step.control) : step.kind !== 'restart' && step.kind !== 'speech_probe') throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.control`)
      if (step.kind === 'fill' && !text(step.value, 2000)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.value`)
      if (step.kind === 'expect' && !text(step.equals)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.equals`)
      if (step.kind === 'expect' && step.property !== undefined && !['text', 'value'].includes(step.property)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.property`)
      if (step.subject !== undefined && !identifier(step.subject)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.subject`)
      if (step.kind === 'click' && step.intent !== undefined && !['submit', 'cancel'].includes(step.intent)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.intent`)
      if (step.kind === 'expect' && step.oracle !== undefined) {
        validateOracle(step.oracle, `${stepPath}.oracle`)
      }
    }
  }
  if (value.coverage_notes !== undefined && (!Array.isArray(value.coverage_notes) || value.coverage_notes.length > 64 || value.coverage_notes.some(note => !note
    || !keys(note, ['feature', 'category', 'disposition', 'reason', 'source']) || !features.includes(note.feature) || !INDEPENDENT_CATEGORIES.includes(note.category)
    || !['not_applicable', 'unresolved'].includes(note.disposition) || !text(note.reason, 1200) || !note.reason.trim() || !text(note.source)))) throw new IndependentCaseFormatError('INDEPENDENT_COVERAGE_NOTES_INVALID: coverage_notes')
  return value
}
export function assessIndependentCases(brief: PrdBackplane, contract: IndependentCases): IndependentSemantics {
  const cases = contract.cases.map(item => {
    const requirement = brief.requirements.find(r => r.id === item.feature), expected = requirement && trustedAcceptance(brief, requirement), issues: string[] = []
    if (!requirement || !expected || item.basis?.expected_source !== expected || item.basis.requirement_hash !== requirementEvidenceHash(brief, requirement)) issues.push('预期来源缺失或与当前确认需求不匹配')
    for(const related of item.related??[]){const linked=brief.requirements.find(r=>r.id===related.feature);if(!linked||trustedAcceptance(brief,linked)!==related.expected_source||requirementEvidenceHash(brief,linked)!==related.requirement_hash)issues.push('关联需求来源缺失或已变化')}
    if (!item.coverage?.length) issues.push('未声明本案例检查的业务错误面')
    if (item.steps.some(step => step.kind === 'speech_probe') &&
      (!requirement || !requirementCapabilities(requirement).has('speech') || item.coverage?.length !== 1 || item.coverage[0] !== 'normal')) {
      issues.push('宿主音频探针仅用于已确认语音识别需求的正常转写案例')
    }
    item.steps.forEach((step, index) => {
      if (step.kind === 'restart' && !item.steps.slice(index + 1).some(s => s.kind === 'expect')) issues.push('重开后缺少实际断言')
      if (step.kind !== 'expect') return
      const oracle = step.oracle
      if (!oracle || oracle.kind === 'unresolved') { issues.push(oracle?.kind === 'unresolved' ? `待澄清：${oracle.question}` : '断言未说明预期依据'); return }
      if (oracle.kind === 'literal') {
        const cited = oracle.feature && brief.requirements.find(row => row.id === oracle.feature)
        const sources = oracle.feature ? [cited ? trustedAcceptance(brief, cited) : undefined]
          : [expected, ...(item.related ?? []).map(row => row.expected_source)]
        if (!sources.some(source => source?.includes(oracle.quote)) || step.equals !== oracle.quote) issues.push('固定预期不是确认资料中逐字引用的业务值')
      } else if (oracle.kind === 'derived') {
        const rule = brief.requirements_model?.rules.find(r => r.id === oracle.rule_id)
        const inputs = oracle.steps.map(n => item.steps[n])
        if (!rule?.verification || rule.origin !== 'user' || !rule.feature_ids.includes(item.feature)
          || oracle.steps.some(n => n < 0 || n >= index)
          || inputs.some(s => s?.kind !== 'fill' || s.subject !== step.subject)) issues.push('派生预期缺少已确认运算规则或同对象的先前输入')
        else try { if (deriveExpected(rule.verification.operation, inputs.map(s => (s as {value:string}).value)) !== step.equals) issues.push('派生预期与宿主确定性计算不一致') }
        catch { issues.push('派生预期输入或运算不受支持') }
      } else {
        const source = item.steps[oracle.step]
        if (oracle.step < 0 || oracle.step >= index || source?.kind !== 'fill' || source.value !== step.equals || source.subject !== step.subject) issues.push('预期与所引用的先前输入或对象身份不一致')
      }
    })
    if (item.coverage?.includes('multi_object')) {
      const inputs = item.steps.filter((s): s is Extract<IndependentStep, { kind: 'fill' }> => s.kind === 'fill' && Boolean(s.subject))
      const subjects = new Set(inputs.map(s => s.subject))
      if (subjects.size < 2 || new Set(inputs.map(s => s.value)).size < 2 || [...subjects].some(subject => !item.steps.some(s => s.kind === 'expect' && s.subject === subject))) issues.push('多对象案例须有至少两个对象、不同输入及各自的实际断言')
      if (![...subjects].some(subject => new Set(inputs.filter(s => s.subject === subject).map(s => s.value)).size >= 2)) issues.push('多对象案例须再次修改其中一个对象，并观察其他对象是否保持')
    }
    if (item.coverage?.includes('reopen') && !item.steps.some(s => s.kind === 'restart')) issues.push('声明重开但没有真实重开步骤')
    if (item.coverage?.includes('cancel') && !item.steps.some((s, index) => s.kind === 'click' && s.intent === 'cancel' && item.steps.slice(index + 1).some(next => next.kind === 'expect'))) issues.push('声明取消但没有取消操作及后续断言')
    return { id: item.id, feature: item.feature, status: issues.length ? 'disputed' as const : 'grounded' as const, issues }
  })
  const coverage = brief.requirements.flatMap(requirement => INDEPENDENT_CATEGORIES.map(category => {
    const ids = contract.cases.filter(c => c.feature === requirement.id && c.coverage?.includes(category) && cases.find(s => s.id === c.id)?.status === 'grounded').map(c => c.id)
    const notes = contract.coverage_notes?.filter(n => n.feature === requirement.id && n.category === category) ?? []
    const valid = notes.length === 1 && notes[0].source === trustedAcceptance(brief, requirement)
    const requested = independentCategoryRequested(brief, requirement.id, category)
    const hasCase = contract.cases.some(item => item.feature === requirement.id && item.coverage?.includes(category))
    const outsideConfirmedScope = !requested && !hasCase && (!notes.length || valid)
    const status = ids.length && !notes.length ? 'declared_cases' as const : outsideConfirmedScope ? 'declared_not_applicable' as const
      : notes.length ? 'unresolved' as const : 'missing' as const
    return { feature: requirement.id, category, status, cases: ids, reason: requested&&notes[0]?.disposition==='not_applicable'?'确认资料明确提及该类行为，不能仅凭B的不适用声明跳过':notes[0]?.reason }
  }))
  return { version: 1, digest: hash({ contract, cases, coverage }), cases, coverage,
    ready: cases.every(c => c.status === 'grounded') && coverage.every(c => ['declared_cases', 'declared_not_applicable'].includes(c.status)) }
}
export const INDEPENDENT_SEMANTICS_INSTRUCTIONS = [
  '返回严格 JSON {cases:[{id,feature,basis:{requirement_hash,expected_source},coverage:[normal|multi_object|exception|cancel|reopen],steps}],coverage_notes:[{feature,category,disposition:not_applicable|unresolved,reason,source}]}。basis 逐字引用确认 expected 与 requirement_hash。',
  '步骤仅支持 fill（control、value、可选 subject）、click（control、可选 subject、可选 intent: submit 或 cancel）、expect（control、equals、可选 subject、oracle）、restart。每个步骤用 kind 指定类型。control 是逻辑控件名，不是选择器。',
  '每个 expect 的 oracle 是一个 JSON 对象，必须含 kind。以下每行是完整步骤示例。只使用对应 oracle 示例中的字段，值须根据当前确认资料填写。',
  '{"kind":"expect","control":"result","equals":"Alice","oracle":{"kind":"input","step":0}}',
  'input 引用同对象之前的 fill。step 是从 0 开始的整数步骤序号，equals 等于该输入原值。',
  '{"kind":"expect","control":"result","equals":"已保存","oracle":{"kind":"literal","quote":"已保存"}}',
  'literal 逐字引用当前或关联需求已确认 expected 中的业务值，equals 必须等于 quote。',
  '跨功能复用已确认结果时，在 literal 中直接加来源 feature。例：{"kind":"expect","control":"target_input","property":"value","equals":"已确认的整理结果","oracle":{"kind":"literal","feature":"F-002","quote":"已确认的整理结果"}}。写入结果沿用清理样例，勿再次提问。普通文本用 property=text，输入框用 property=value。',
  '若需求的 capabilities 含 speech，正常语音转写案例用唯一一步 {"kind":"speech_probe"}，coverage 只填 ["normal"]。平台以固定音频验证产品实际识别入口，无需用户提供逐字转写。此证据仅覆盖转写算法，不能用来代替录音界面、清理或文本写入测试。',
  '整段需求描述不能为自选的输出值背书。不要把自选状态文案、生成式文本样例或界面草图上的文案当作已确认的精确预期。',
  '{"kind":"expect","control":"result","equals":"5","oracle":{"kind":"derived","version":1,"rule_id":"BR-001","steps":[0,1]}}',
  'derived 仅引用确认资料中带 verification.operation 的规则。version 为数字 1，rule_id 为确认的规则编号，steps 是之前同对象 fill 的从 0 开始且互不重复的整数序号。equals 须等于按该规则对这些输入的确定性计算结果。',
  '{"kind":"expect","control":"result","equals":"","oracle":{"kind":"unresolved","question":"输入“嗯，我下午三点到”时，清理后的完整文本应是什么？"}}',
  '缺少可确认的预期值或规则时，用 unresolved。equals 填空字符串，question 给出一个具体输入并询问应观察到的结果。该步骤供用户澄清，不能作为通过依据。示例内容不属于当前任务，不能直接照搬。',
  '每需求有 normal。多对象、异常、取消和重开仅在该需求明确要求时才设计对应案例，不必为未要求的行为补问题或固定文案。coverage_notes 如需填写，source 逐字复制该需求的 expected。多对象须不同 subject 及不同值并各自断言。取消操作标 intent:cancel 且其后断言，重开后必须断言。',
  'related 可引用本批其他需求的 {feature,requirement_hash,expected_source} 作为跨模块规则依据，引用必须逐字对应确认资料。关联引用本身不计入该需求覆盖，仍须其自己的正常案例。最多 12 案例，每案例 32 步，不得返回 PASS 或修改目标。',
].join('\n')
