import { serializeRedactedJson } from '../../shared/redacted-json'
import { independentCaseOutcome } from './verification-evidence'
import { randomUUID } from 'node:crypto'
import { independentDesignVersion, readIndependentDesign, readIndependentPolicy } from './independent-design'
import type { IndependentVerification } from './independent-verification'
import type { SoftwareRelease } from './release-store'
import { qualityIdentity, qualityTargetIdentity, qualityHash, readQualityLedger, saveQualityLedger, type QualityFinding } from './quality-ledger'
import { redactSoftwareOutput } from './process-manager'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { assessIndependentCases, independentCategoryRequested, type IndependentCases, type IndependentSemantics } from './independent-semantics'
import { findProject } from '../project/project-service'
import { independentDesignMatchesPolicy } from './independent-policy'
import { readSoftwareRunState } from './run-state'
import { requirementCapabilities } from '../model/requirement-capabilities'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import type { IndependentDesignRecord } from './independent-design'
import { settleIndependentCorrection } from './independent-correction'
import { isDeepStrictEqual } from 'node:util'

export interface IndependentClarification {
  questions: string[]
  canRedesign: boolean
}

export function independentClarification(projectId: string, contract: IndependentCases, assessment: IndependentSemantics): IndependentClarification {
  const brief = readPrdBackplane(projectId)
  const policy = readIndependentPolicy(projectId)
  const questions: string[] = []
  // A model proposal cannot require a product decision for an unrequested case.
  for (const item of contract.cases) {
    if (!assessment.cases.some(row => row.id === item.id && row.status === 'disputed')) continue
    if (!item.coverage?.some(category => independentCategoryRequested(brief, item.feature, category))) continue
    const requirement = brief.requirements.find(row => row.id === item.feature)
    // Speech recognition has a platform test fixture, so a missing transcript
    // for a model-invented recording is a design issue, not a user decision.
    if (requirement && item.coverage?.length === 1 && item.coverage[0] === 'normal' && requirementCapabilities(requirement).has('speech')) continue
    for (const step of item.steps) {
      if (step.kind !== 'expect' || step.oracle?.kind !== 'unresolved') continue
      const decision = step.oracle.decision
      if (!decision || !requirement || !trustedAcceptance(brief, requirement)?.includes(decision.source)) continue
      const question = redactSoftwareOutput(step.oracle.question).replace(/\s+/g, ' ').trim().slice(0, 280)
      const choices = decision.options.map(option => redactSoftwareOutput(option).replace(/\s+/g, ' ').trim().slice(0, 160))
      const prompt = question + '\n可选方案：' + choices.join('；')
      if (question && !questions.includes(prompt)) questions.push(prompt)
    }
  }
  return { questions, canRedesign: !!policy?.enabled && 'funding' in policy }
}

export function independentClarificationText({ questions, canRedesign }: IndependentClarification): string {
  if (!questions.length) return '平台尚未完成独立测试设计，当前停在工程处理阶段。已有需求与工程默认值将用于修正案例。'
    + (canRedesign ? '继续时平台会带上具体失败原因重新处理。' : '当前独立模型配置需要检查运行条件。')
  const visible = questions.slice(0, 3)
  return ['开工前需要确认以下验收预期。请直接在这里回复，我会整理成任务单请你确认。',
    ...visible.map((question, index) => `${index + 1}. ${question}`),
    ...(questions.length > visible.length ? ['先确认以上几项，其余问题会在复核时继续处理。'] : []),
    ...(canRedesign ? ['如果这些行为不在你的需求里，可以回复「重新设计验收」。'] : []),
  ].join('\n\n')
}

/** Recover the active clarification from existing scope, design and run records. */
export function readIndependentClarification(projectId: string, sessionId: string): IndependentClarification | undefined {
  const project = findProject(projectId)
  if (project.current_stage !== 'blocked_for_user_decision' || project.desktop_phase
    || project.lean_operation_id === undefined || project.status !== 'active') return
  const run = readSoftwareRunState(projectId)
  if (run?.status !== 'waiting_user' || run.sessionId !== sessionId || run.operationId !== project.lean_operation_id) return
  const design = readIndependentDesign(projectId), brief = readPrdBackplane(projectId)
  if (design?.status !== 'frozen' || !design.contract || !brief.user_confirmed_at || design.operation !== run.operationId
    || design.scope !== prdScopeFingerprint(brief) || design.design_hash !== project.ux_confirmation?.design_hash) return
  const policy = readIndependentPolicy(projectId)
  if (!policy || !independentDesignMatchesPolicy(design, policy)) return
  const assessment = currentIndependentSemantics(projectId, design.contract)
  if (!assessment.ready) return independentClarification(projectId, design.contract, assessment)
}

export function independentChallengeVersion(projectId: string) {
  return qualityHash(readQualityLedger(projectId).findings.filter(f => f.independent && f.challenge).map(f => [f.id, f.independent, f.challenge]))
}
export function currentIndependentSemantics(projectId: string, contract: IndependentCases): IndependentSemantics {
  const design=readIndependentDesign(projectId)
  if(design)settleIndependentCorrection(projectId,design)
  const challenged = readQualityLedger(projectId).findings.filter(f => f.independent?.design_digest === design?.digest && f.challenge && !f.challenge.resolution)
  return assessIndependentCases(readPrdBackplane(projectId),contract,challenged.map(f=>({
    case_id:f.independent!.case_id,reason:f.challenge!.reason,evidence:f.challenge!.evidence,
  })))
}
export async function recordIndependentDisputes(projectId: string, assessment: IndependentSemantics, signal?: AbortSignal) {
  const design = readIndependentDesign(projectId)
  if (design?.status !== 'frozen' || !design.digest) throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  signal?.throwIfAborted()
  const version = independentDesignVersion(projectId), ledger = readQualityLedger(projectId), brief = readPrdBackplane(projectId)
  // These are pre-implementation design disputes. Bind them to the frozen
  // design without requiring an application entry or inventing runtime evidence.
  const identity = {source:design.digest,target:qualityTargetIdentity(projectId),environment:qualityHash({phase:'independent-design',version})}
  const disputes = [...assessment.cases.filter(c => c.status === 'disputed').map(c => ({ id: c.id, feature: c.feature, issues: c.issues })),
    ...assessment.coverage.filter(c => ['missing', 'unresolved'].includes(c.status)).map(c => ({ id: `coverage:${c.feature}:${c.category}`, feature: c.feature, issues: [c.reason ?? `缺少${c.category}覆盖说明`] }))]
  for (const row of disputes) {
    if (ledger.findings.some(f => f.independent?.design_version === version && f.independent?.case_id === row.id)) continue
    const requirement = brief.requirements.find(r => r.id === row.feature)
    ledger.findings.push({ id: randomUUID(), review: `independent:${design.digest}:${row.id}`, identity, requirement: row.feature, expected_source: requirement && trustedAcceptance(brief, requirement) || '', category: 'independent_expectation', severity: 'medium',
      location: `B:${row.id}`, trigger: '实现前核对独立预期', evidence: row.issues.join('；'), reproduction: row.id, unknowns: row.issues.join('；'), disposition: 'disputed', checks: [], independent: { design_version: version, design_digest: design.digest, case_id: row.id } })
  }
  signal?.throwIfAborted()
  saveQualityLedger(projectId, ledger)
}
/** Raising a dispute blocks reuse; it never excludes a valid failure or grants
 * authority to edit B. A new confirmed target/design is a separate host action. */
export async function challengeIndependentCase(projectId: string, input: Record<string, unknown>, signal?: AbortSignal) {
  if (Object.keys(input).some(k => !['case_id', 'reason', 'evidence'].includes(k)) || ['case_id', 'reason', 'evidence'].some(k => typeof input[k] !== 'string' || !(input[k] as string).trim() || (input[k] as string).length > 2000)) throw Error('INDEPENDENT_CHALLENGE_INVALID')
  const design = readIndependentDesign(projectId), item = design?.contract?.cases.find(c => c.id === input.case_id)
  if (design?.status !== 'frozen' || !item) throw Error('INDEPENDENT_CHALLENGE_CASE_UNKNOWN')
  const base = assessIndependentCases(readPrdBackplane(projectId), design.contract!), assessment = { ...base, ready: false, cases: base.cases.map(c => c.id === item.id ? { ...c, status: 'disputed' as const, issues: [`实现者提出争议：${input.reason}`] } : c) }
  await recordIndependentDisputes(projectId, assessment, signal)
  const ledger = readQualityLedger(projectId), version = independentDesignVersion(projectId), finding = ledger.findings.find(f => f.independent?.design_version === version && f.independent?.case_id === item.id)!
  finding.challenge = { at: new Date().toISOString(), reason: String(input.reason), evidence: String(input.evidence), source: 'implementer_claim' }; saveQualityLedger(projectId, ledger)
  return finding
}

/** B writes proposals. Only actual host observations create confirmation or
 * closure. An invalid oracle is a design dispute, never a product failure. */
export async function recordIndependentFindings(projectId: string, candidate: SoftwareRelease, result: IndependentVerification, canClose: boolean, signal?: AbortSignal) {
  if (result.status === 'disabled' || !result.case_results || !result.design_version || !result.design_digest) return
  const identity = await qualityIdentity(projectId, signal)
  if (identity.source !== candidate.source.digest || independentDesignVersion(projectId) !== result.design_version) throw Error('INDEPENDENT_FINDING_CANDIDATE_CHANGED')
  const ledger = readQualityLedger(projectId)
  const record = readIndependentDesign(projectId)
  const brief=readPrdBackplane(projectId)
  // Older hosts promoted setup/selector failures into suspected product
  // defects. Their observations remain history, but cannot require a separate
  // product investigation once the verifier itself reports the setup gap.
  for (const finding of ledger.findings) {
    if (!finding.independent || finding.category !== 'independent_behavior' || finding.challenge
      || finding.disposition === 'superseded' || !finding.checks.length) continue
    const setupOnly = finding.checks.every(check => {
      if (check.outcome !== 'unverified') return false
      try { return ['environment', 'adapter'].includes(JSON.parse(check.observation ?? '{}').case?.kind) }
      catch { return false }
    })
    if (setupOnly) {
      finding.disposition = 'superseded'
      finding.unknowns = '原记录只有验收环境或适配问题，当前待办以独立执行回执为准。'
    }
  }
  for (const finding of ledger.findings.filter(f => f.independent && f.independent.design_version !== result.design_version && f.disposition !== 'superseded')) {
    const requirement=brief.requirements.find(r=>r.id===finding.requirement)
    // A fresh B proposal cannot erase a reproduced defect under the same
    // confirmed expectation just by dropping or renaming its failing case.
    if(!requirement||trustedAcceptance(brief,requirement)!==finding.expected_source){finding.disposition = 'superseded'; finding.unknowns = '确认需求已移除或预期已改变；旧意见保留，不计为修复关闭。'}
  }
  for (const observed of result.case_results) {
    if (observed.kind === 'environment' || observed.kind === 'adapter') continue
    const mode=observed.environment?.mode??'isolated_local'
    // Keep independently reproduced environments in separate findings. A mode
    // change must neither erase an older failure nor make the new one unclosable.
    const sameEnvironment=(finding:QualityFinding)=>finding.checks.filter(c=>c.outcome==='failed').every(check=>{
      try {
        const environment=JSON.parse(check.observation??'{}').case?.environment
        return (environment?.mode??'isolated_local')===mode && (mode!=='controlled_service'||environment.configuration_digest===observed.environment?.configuration_digest)
      } catch {return false}
    })
    const currentCase=record?.contract?.cases.find(row=>row.id===observed.id)
    let finding = ledger.findings.find(f => {
      if(!f.independent||f.independent.case_id!==observed.id||f.disposition==='superseded'||!sameEnvironment(f))return false
      if(f.independent.design_version===result.design_version)return true
      if(!currentCase||f.identity.target!==identity.target||!/^[a-f0-9]{64}$/.test(f.independent.design_digest))return false
      const file=join(getPromaHome(),'software-independent-design',projectId,f.independent.design_digest+'.json')
      if(!existsSync(file))return false
      const old=JSON.parse(readFileSync(file,'utf8')) as IndependentDesignRecord
      return old.digest===qualityHash(old.contract)&&isDeepStrictEqual(old.contract?.cases.find(row=>row.id===observed.id),currentCase)
    })
    if (!finding && observed.status === 'passed') continue
    if (!finding) {
      finding = { id: randomUUID(), review: `independent:${result.design_digest}:${observed.id}`, identity, requirement: observed.feature,
        expected_source: observed.expected_source ?? '', category: observed.kind === 'semantic' ? 'independent_expectation' : 'independent_behavior',
        severity: observed.kind === 'semantic' ? 'medium' : 'high', location: `B:${observed.id}`, trigger: '执行冻结的独立业务案例', evidence: observed.error ?? observed.issues?.join('；') ?? '宿主实际断言结果',
        reproduction: observed.id, unknowns: observed.kind === 'semantic' ? observed.issues?.join('；') ?? '预期待澄清' : '', disposition: observed.kind === 'semantic' ? 'disputed' : 'suspected', checks: [],
        independent: { design_version: result.design_version, design_digest: result.design_digest, case_id: observed.id } } satisfies QualityFinding
      ledger.findings.push(finding)
    }
    const outcome = independentCaseOutcome(observed)
    const baseline = finding.checks.some(c => c.outcome === 'failed')
    finding.checks.push({ at: new Date().toISOString(), identity, case_name: observed.id, rules: result.design_version, outcome, report: result.report_path, candidate: candidate.id,
      observation: serializeRedactedJson({ case: observed, overall_passed: canClose, scope: mode==='controlled_service'?'frozen_independent_case_with_controlled_service':'frozen_independent_business_case' },redactSoftwareOutput) })
    if (outcome === 'failed') finding.disposition = 'confirmed'
    else if (outcome === 'passed' && baseline) finding.disposition = 'closed'
    else if (!baseline) finding.disposition = observed.kind === 'semantic' ? 'disputed' : outcome === 'passed' ? 'not_reproduced' : 'suspected'
    // Closure belongs to this exact case, environment and current candidate.
    // Other pending checks still block overall delivery, not this repaired defect.
  }
  saveQualityLedger(projectId, ledger)
}
