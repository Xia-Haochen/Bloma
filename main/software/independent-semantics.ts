import { deriveExpected } from './independent-oracles'
import { createHash } from 'node:crypto'
import type { PrdBackplane } from '../model/prd-backplane'
import { requirementEvidenceHash, trustedAcceptance } from '../project/requirement-contract'
import { requirementCapabilities } from '../model/requirement-capabilities'

export const INDEPENDENT_CATEGORIES = ['normal', 'multi_object', 'exception', 'cancel', 'reopen'] as const
export type IndependentCategory = typeof INDEPENDENT_CATEGORIES[number]
export type IndependentOracle = { kind: 'derived'; version: 1; rule_id: string; steps: number[] } | { kind: 'input'; step: number } | { kind: 'literal'; quote: string; feature?: string }
  | { kind: 'nonempty'; quote: string } | { kind: 'observed'; step: number }
  | { kind: 'unresolved'; question: string; decision?: { source: string; options: string[] } }
export type IndependentStep = ({ kind: 'fill'; control: string; value: string } | { kind: 'click'; control: string; intent?: 'submit' | 'cancel' }
  | { kind: 'expect'; control: string; equals: string; property?: 'text' | 'value'; oracle?: IndependentOracle }
  | { kind: 'expect_audio'; control: string; quote: string; text_control?: string }
  | { kind: 'restart' } | { kind: 'speech_probe' } | { kind: 'speech_input'; control: string; sample?: 'voice' | 'silence' }) & { subject?: string }
export interface IndependentCase { id: string; feature: string; steps: IndependentStep[]
  service?: { requests: 'none' | 'response'; source: string }
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
    case 'observed':
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
    case 'nonempty':
      fields(['quote'])
      nonblank('quote')
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
      fields(['question'], ['decision'])
      nonblank('question')
      if (oracle.decision !== undefined) {
        const decision = oracle.decision as {source?: unknown; options?: unknown}
        if (!decision || typeof decision !== 'object' || !keys(decision, ['source','options'])
          || !text(decision.source) || !decision.source.trim() || !Array.isArray(decision.options)
          || decision.options.length < 2 || decision.options.length > 4 || decision.options.some(option => !text(option) || !option.trim())) {
          fail('.decision', '须给出确认资料的逐字来源和 2 至 4 个具有不同业务后果的选项')
        }
      }
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
  // These names are lookup keys, never executable selectors or filesystem paths.
  const logicalName = (input: unknown) => typeof input === 'string' && input.trim().length > 0
    && input.length <= 128 && !/[\u0000-\u001f\u007f]/.test(input)
  for (const [caseIndex, item] of value.cases.entries()) {
    const path = `cases[${caseIndex}]`
    if (!item || !keys(item, ['id', 'feature', 'steps', 'basis', 'coverage', 'related', 'service']) || !identifier(item.id) || !features.includes(item.feature)) {
      throw new IndependentCaseFormatError(`INDEPENDENT_CASE_INVALID: ${path} 的 id、feature 或字段不合法`)
    }
    const speechProbe = Array.isArray(item.steps) && item.steps.length === 1 && item.steps[0]?.kind === 'speech_probe'
    if(item.service !== undefined && (!item.service || typeof item.service !== 'object' || Array.isArray(item.service) || !keys(item.service,['requests','source']) ||
      !['none','response'].includes(item.service.requests) || !text(item.service.source) || !item.service.source.trim()))
      throw new IndependentCaseFormatError('INDEPENDENT_SERVICE_INVALID: '+path+'.service')
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > 32) {
      throw new IndependentCaseFormatError(`INDEPENDENT_CASE_INVALID: ${path}.steps 须为含 1 至 32 个步骤的数组`)
    }
    if (item.basis !== undefined && (!item.basis || !keys(item.basis, ['requirement_hash', 'expected_source']) || !text(item.basis.requirement_hash, 64) || !text(item.basis.expected_source))) throw new IndependentCaseFormatError(`INDEPENDENT_BASIS_INVALID: ${path}.basis`)
    if(item.related!==undefined&&(!Array.isArray(item.related)||item.related.length>8||new Set(item.related.map(r=>r?.feature)).size!==item.related.length||item.related.some(r=>!r||!keys(r,['feature','requirement_hash','expected_source'])||r.feature===item.feature||!features.includes(r.feature)||!text(r.requirement_hash,64)||!text(r.expected_source))))throw new IndependentCaseFormatError(`INDEPENDENT_RELATED_INVALID: ${path}.related`)
    if (item.coverage !== undefined && (!Array.isArray(item.coverage) || !item.coverage.length || new Set(item.coverage).size !== item.coverage.length || item.coverage.some(c => !INDEPENDENT_CATEGORIES.includes(c)))) throw new IndependentCaseFormatError(`INDEPENDENT_COVERAGE_INVALID: ${path}.coverage`)
    for (const [stepIndex, step] of item.steps.entries()) {
      const stepPath = `${path}.steps[${stepIndex}]`
      if (!step) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}`)
      const allowed = step.kind === 'expect_audio' ? ['kind', 'control', 'quote', 'text_control']
        : step.kind === 'fill' ? ['kind', 'control', 'value', 'subject'] : step.kind === 'expect' ? ['kind', 'control', 'equals', 'oracle', 'property', 'subject'] : step.kind === 'click' ? ['kind', 'control', 'subject', 'intent'] : step.kind === 'speech_input' ? ['kind', 'control', 'subject', 'sample'] : step.kind === 'restart' || speechProbe && step.kind === 'speech_probe' ? ['kind'] : []
      if (!allowed.length || !keys(step, allowed)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}`)
      if (step.kind === 'speech_input' && step.sample !== undefined && !['voice','silence'].includes(step.sample)) throw new IndependentCaseFormatError('INDEPENDENT_SPEECH_SAMPLE_INVALID: '+stepPath)
      if ('control' in step ? !logicalName(step.control) : step.kind !== 'restart' && step.kind !== 'speech_probe') throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.control 须为非空逻辑控件名，最多128字符，可用中文或空格，不含换行等控制字符`)
      if (step.kind === 'fill' && !text(step.value, 2000)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.value`)
      if (step.kind === 'expect' && !text(step.equals)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.equals`)
      if (step.kind === 'expect' && step.property !== undefined && !['text', 'value'].includes(step.property)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.property`)
      if (step.kind === 'expect_audio' && (!text(step.quote) || !step.quote.trim() ||
        step.text_control !== undefined && (!logicalName(step.text_control) || step.text_control === step.control))) {
        throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath} 需要朗读原文依据及独立的可选文字控件。`)
      }
      if (step.subject !== undefined && !logicalName(step.subject)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.subject 须为非空对象名，最多128字符，不含控制字符`)
      if (step.kind === 'click' && step.intent !== undefined && !['submit', 'cancel'].includes(step.intent)) throw new IndependentCaseFormatError(`INDEPENDENT_STEP_INVALID: ${stepPath}.intent`)
      if (step.kind === 'expect' && step.oracle !== undefined) {
        validateOracle(step.oracle, `${stepPath}.oracle`)
      }
    }
    if (!speechProbe) {
      if (!item.steps.some(step => step.kind === 'click' || step.kind === 'fill' || step.kind === 'speech_input')) {
        throw new IndependentCaseFormatError(`INDEPENDENT_CASE_INVALID: ${path}.steps 缺少操作，至少提供一个 kind 为 click 或 fill 的步骤`)
      }
      if (!item.steps.some(step => step.kind === 'expect' || step.kind === 'expect_audio')) {
        throw new IndependentCaseFormatError(`INDEPENDENT_CASE_INVALID: ${path}.steps 缺少断言，至少提供一个 kind 为 expect 的步骤`)
      }
    }
  }
  if (value.coverage_notes !== undefined && (!Array.isArray(value.coverage_notes) || value.coverage_notes.length > 64 || value.coverage_notes.some(note => !note
    || !keys(note, ['feature', 'category', 'disposition', 'reason', 'source']) || !features.includes(note.feature) || !INDEPENDENT_CATEGORIES.includes(note.category)
    || !['not_applicable', 'unresolved'].includes(note.disposition) || !text(note.reason, 1200) || !note.reason.trim() || !text(note.source)))) throw new IndependentCaseFormatError('INDEPENDENT_COVERAGE_NOTES_INVALID: coverage_notes')
  return value
}
export function assessIndependentCases(brief: PrdBackplane, contract: IndependentCases,
  challenges: Array<{case_id:string;reason:string;evidence:string}> = []): IndependentSemantics {
  const cases = contract.cases.map(item => {
    const requirement = brief.requirements.find(r => r.id === item.feature), expected = requirement && trustedAcceptance(brief, requirement), issues: string[] = []
    if(item.service && !expected?.includes(item.service.source))issues.push('服务请求预期缺少确认需求中的逐字来源')
    for(const challenge of challenges.filter(row=>row.case_id===item.id))issues.push(`实现者争议尚待核对：${challenge.reason}；证据：${challenge.evidence}`)
    if (!requirement || !expected || item.basis?.expected_source !== expected || item.basis.requirement_hash !== requirementEvidenceHash(brief, requirement)) issues.push('预期来源缺失或与当前确认需求不匹配')
    for(const related of item.related??[]){const linked=brief.requirements.find(r=>r.id===related.feature);if(!linked||trustedAcceptance(brief,linked)!==related.expected_source||requirementEvidenceHash(brief,linked)!==related.requirement_hash)issues.push('关联需求来源缺失或已变化')}
    if (!item.coverage?.length) issues.push('未声明本案例检查的业务错误面')
    if (item.steps.some(step => step.kind === 'speech_probe') &&
      (!requirement || !requirementCapabilities(requirement).has('speech') || item.coverage?.length !== 1 || item.coverage[0] !== 'normal')) {
      issues.push('宿主音频探针仅用于已确认语音识别需求的正常转写案例')
    }
    item.steps.forEach((step, index) => {
      if (step.kind === 'restart' && !item.steps.slice(index + 1).some(s => s.kind === 'expect' || s.kind === 'expect_audio')) issues.push('重开后缺少实际断言')
      if (step.kind === 'expect_audio') {
        if (!expected?.includes(step.quote) || !/语音|音频|朗读|播放|声音|听到|有声/.test(step.quote)) issues.push('音频观察缺少当前确认需求中的朗读或播放依据')
        if (!item.steps.slice(0, index).some(s => s.kind === 'speech_input' || s.kind === 'click')) issues.push('音频观察前须有实际触发操作')
      }
      if (step.kind !== 'expect') return
      const oracle = step.oracle
      if (!oracle || oracle.kind === 'unresolved') { issues.push(oracle?.kind === 'unresolved' ? `待澄清：${oracle.question}` : '断言未说明预期依据'); return }
      if (oracle.kind === 'literal') {
        const cited = oracle.feature && brief.requirements.find(row => row.id === oracle.feature)
        const sources = oracle.feature ? [cited ? trustedAcceptance(brief, cited) : undefined]
          : [expected, ...(item.related ?? []).map(row => row.expected_source)]
        if (!sources.some(source => source?.includes(oracle.quote)) || step.equals !== oracle.quote) issues.push('固定预期不是确认资料中逐字引用的业务值')
      } else if (oracle.kind === 'nonempty') {
        if (!expected?.includes(oracle.quote)) issues.push('输出存在性检查缺少当前确认需求依据')
      } else if (oracle.kind === 'observed') {
        const source = item.steps[oracle.step]
        if (oracle.step >= index || source?.kind !== 'expect' || !source.oracle
          || ['unresolved','observed'].includes(source.oracle.kind)
          || source.control === step.control && !item.steps.slice(oracle.step + 1, index).some(s => ['restart','click','fill','speech_input'].includes(s.kind))) {
          issues.push('结果一致性须引用之前已检查的实际输出，并跨操作或不同控件比较')
        }
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
  'speech_input 的 sample 可为 voice 或 silence，缺省为 voice。静音输入用 sample:silence，宿主提供真正的零振幅 WAV；控件名称不决定输入数据。静音不发送请求的案例同时声明 service.requests:none。',
  '模型服务行为按案例声明 service:{requests:"none"|"response",source:"当前expected中的逐字依据"}。空输入、取消等明确要求不发送的案例用none，宿主仍准备服务并验证请求数为零；正常获取回复用response。配置值、错误提示、历史记录等确定性断言可以与服务回复检查同时存在。',
  '返回严格 JSON {cases:[{id,feature,basis:{requirement_hash,expected_source},coverage:[normal|multi_object|exception|cancel|reopen],steps}],coverage_notes:[{feature,category,disposition:not_applicable|unresolved,reason,source}]}。basis 逐字引用确认 expected 与 requirement_hash。',
  '普通 GUI 案例的 steps 必须同时有 click、fill 或 speech_input 操作，以及 expect 断言。即使预期需要澄清，也请保留触发该行为的操作，并在 expect 中用 unresolved。步骤用 kind 指定类型，control 是逻辑控件名。fill 携带 value，click 可带 intent: submit 或 cancel，expect 携带 equals 和 oracle，可用 restart 测试重新打开后的结果。',
  '完整的普通步骤数组示例：[{"kind":"fill","control":"name","value":"Alice"},{"kind":"click","control":"save"},{"kind":"expect","control":"result","equals":"Alice","oracle":{"kind":"input","step":0}}]。',
  '每个 expect 的 oracle 是一个 JSON 对象，必须含 kind。以下每行是完整步骤示例。只使用对应 oracle 示例中的字段，值须根据当前确认资料填写。',
  'B 负责设计测试输入、夹具、观察和断言。用户只决定产品目标与真正冲突的业务规则。提示文案、掩码、动态模型回复和历史内容不要求用户逐字提供；按已授权的工程默认值和实际数据关系验证。',
  '动态回复先检查已确认需求要求的输出存在，再记录实际结果。例：{"kind":"expect","control":"reply","equals":"","oracle":{"kind":"nonempty","quote":"AI角色的回复文本"}}，quote 必须来自该项 expected。此检查只证明有输出，语义质量仍由独立评审与实际效果证据承担。',
  '随后验证复制、历史或重开的一致性：{"kind":"expect","control":"history_reply","equals":"","oracle":{"kind":"observed","step":2}}。step 指向本案例先前已检查输出的步骤，从 0 开始。平台比较两次实际值，禁止要求用户预言随机回复。',
  'unresolved 默认表示 B 的测试设计缺口，由 B 修正。只有确实需要用户选择、且现有授权和默认值无法解决时，附 decision:{source:"确认资料的逐字原文",options:["选择一及业务后果","选择二及业务后果"]}。已授权工程决定的细节、测试能力不足、服务凭据与设备不可用均不能归为业务决定。',
  '{"kind":"expect","control":"result","equals":"Alice","oracle":{"kind":"input","step":0}}',
  'input 引用同对象之前的 fill。step 是从 0 开始的整数步骤序号，equals 等于该输入原值。',
  '{"kind":"expect","control":"result","equals":"已保存","oracle":{"kind":"literal","quote":"已保存"}}',
  'literal 逐字引用当前或关联需求已确认 expected 中的业务值，equals 必须等于 quote。',
  '跨功能复用已确认结果时，在 literal 中直接加来源 feature。例：{"kind":"expect","control":"target_input","property":"value","equals":"已确认的整理结果","oracle":{"kind":"literal","feature":"F-002","quote":"已确认的整理结果"}}。写入结果沿用清理样例，勿再次提问。普通文本用 property=text，输入框用 property=value。',
  '若需求的 capabilities 含 speech，正常语音转写案例用唯一一步 {"kind":"speech_probe"}，coverage 只填 ["normal"]。平台以固定音频验证产品实际识别入口，无需用户提供逐字转写。此证据仅覆盖转写算法，不能用来代替录音界面、清理或文本写入测试。',
  '语音触发后的回复、历史和多轮对话须实际提供输入：使用 {"kind":"speech_input","control":"音频文件输入"}，宿主从受保护资源把固定语音文件交给产品正常文件输入控件，之后等待新的用户发言与服务回复。该步骤证明文件语音业务链；实体麦克风仍由用户参与实测核对。点击麦克风不等于已经提供声音。observed 必须比较同一业务量，风格标识只能与先前观察到的风格标识比较，不能引用回复正文；每轮回复都须有本轮输入。',
  '若确认要求朗读或音频播放，在触发后用 {"kind":"expect_audio","control":"回复播放器","quote":"从本项 expected 逐字引用的朗读或播放要求"}。宿主检查实际 HTML audio 有非静音内容、播放推进且到达结尾；同时显示文字时加 text_control 指向回复文字控件，宿主在播放时取样。逻辑控件由实现者绑定，不要求用户指定播放状态文案。用 normal 表达连续多轮；multi_object 只用于不同对象修改后互不影响。',
  '整段需求描述不能为自选的输出值背书。不要把自选状态文案、生成式文本样例或界面草图上的文案当作已确认的精确预期。',
  '{"kind":"expect","control":"result","equals":"5","oracle":{"kind":"derived","version":1,"rule_id":"BR-001","steps":[0,1]}}',
  'derived 仅引用确认资料中带 verification.operation 的规则。version 为数字 1，rule_id 为确认的规则编号，steps 是之前同对象 fill 的从 0 开始且互不重复的整数序号。equals 须等于按该规则对这些输入的确定性计算结果。',
  '{"kind":"expect","control":"result","equals":"","oracle":{"kind":"unresolved","question":"输入“嗯，我下午三点到”时，清理后的完整文本应是什么？"}}',
  '精确文案未规定时，优先用输入回读或先观察再比较的关系断言。只有无法设计有依据的业务断言时才用 unresolved 并写明缺口；用户澄清仅适用于带 decision 的真实业务选择。示例内容不属于当前任务。',
  'required_coverage 是宿主根据当前确认资料要求覆盖的类别。每需求有 normal。多对象、异常、取消和重开仅在该需求明确要求时才设计对应案例，不必为未要求的行为补问题或固定文案。coverage_notes 如需填写，source 逐字复制该需求的 expected。multi_object 用于数据隔离：两个 subject 分别 fill 不同值、分别 expect，再修改其中一个并检查另一个保持；仅选择预置角色可放在 normal 中，先观察角色项的实际文本再用 observed 比较打开后的标题。取消操作标 intent:cancel 且其后断言，重开后必须断言。',
  'related 可引用本批其他需求的 {feature,requirement_hash,expected_source} 作为跨模块规则依据，引用必须逐字对应确认资料。关联引用本身不计入该需求覆盖，仍须其自己的正常案例。最多 12 案例，每案例 32 步，不得返回 PASS 或修改目标。',
].join('\n')
