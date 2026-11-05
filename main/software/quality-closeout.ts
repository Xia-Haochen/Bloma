import { guiFindingOutcome, cliCaseOutcome } from './verification-evidence'
import type { SoftwareVerification } from './verification'
import { sameIdentity, type Identity, type Ledger, type QualityFinding } from './quality-ledger'

export const importantFinding = (f: QualityFinding) => ['critical','high'].includes(f.severity) || f.review_kind === 'visual' && f.severity === 'medium'
export const sameQualityScope = (a: Identity, b: Identity) => a.target === b.target && a.environment === b.environment
/** A source edit does not dispose of a suspicion. A current observed case can
 * resolve it without pretending the original candidate ever failed a test. */
export function findingNeedsInvestigation(f: QualityFinding, current: Identity, rules: string, independentRules?: string) {
  return sameQualityScope(f.identity, current) && !f.checks.some(c => c.outcome === 'failed')
    && ['suspected','not_reproduced'].includes(f.disposition)
    && !(f.disposition === 'not_reproduced' && f.checks.at(-1)?.outcome === 'passed'
      && sameIdentity(f.checks.at(-1)!.identity, current) && f.checks.at(-1)!.rules === (f.independent ? independentRules : rules))
}

export function findingNeedsClosure(f: QualityFinding, current: Identity, rules: string, independentRules?: string) {
  return f.disposition !== 'superseded'
    && f.checks.some(c => c.outcome === 'failed')
    && !(f.disposition === 'closed' && f.checks.at(-1)?.outcome === 'passed'
      && sameIdentity(f.checks.at(-1)!.identity, current)
      && f.checks.at(-1)!.rules === (f.independent ? independentRules : rules))
}

/** Read-only work ordering. This never issues a release receipt or closes a finding. */
export function qualityCloseout(ledger: Ledger, current: Identity, gate: string | undefined, rules: string, independentRules?: string) {
  const mustFix = ledger.findings.filter(f => findingNeedsClosure(f, current, rules, independentRules))
  const investigate = ledger.findings.filter(f => findingNeedsInvestigation(f, current, rules, independentRules))
  const deferred = ledger.findings.filter(f => sameIdentity(f.identity, current)
    && (f.disposition === 'suggestion' || f.disposition === 'disputed'))
  const pending = ledger.reviews.filter(r => sameIdentity(r.identity, current) && ['pending', 'submitted'].includes(r.status))
  const priority = investigate.find(importantFinding)
  const next = pending.length ? 'wait_for_delegations' : mustFix.length || priority ? 'check_quality_finding'
    : gate?.startsWith('TEST_CORRECTION_APPLY_REQUIRED') ? 'apply_test_correction'
    : gate?.startsWith('QUALITY_REVIEW_REQUIRED') ? 'start_quality_review'
    : gate?.startsWith('QUALITY_VISUAL_REVIEW_REQUIRED') ? 'start_visual_review'
    : gate ? 'inspect_app' : 'verify_app'
  return { identity: current, verification: 'not_issued', gate, next_tool: next,
    must_fix: mustFix.map(f => f.id), investigate: investigate.map(f => f.id), required_investigation: investigate.filter(importantFinding).map(f => f.id), deferred: deferred.map(f => f.id),
    policy: '先复现重要疑点、修复并同案例复测，再集中审阅稳定候选。suggestion/disputed不自动扩充本轮范围；低优先疑点保留记录，不为清空意见反复改动。审阅齐备后verify_app，通过后结束制作，由宿主核对并发布。任何源码变化都不能复用旧候选证据。' }
}

/** The durable ledger remains complete. Default model input is a current work
 * queue; historical details are read explicitly by finding ID. */
export function qualityWorkQueue(ledger: Ledger, current: Identity, gate: string | undefined, rules: string, independentRules?: string) {
  const closeout = qualityCloseout(ledger, current, gate, rules, independentRules)
  const ids = new Set([...closeout.must_fix, ...closeout.required_investigation])
  return { closeout, findings: ledger.findings.filter(f => ids.has(f.id)),
    reviews: (['code','visual'] as const).map(kind => ledger.reviews.filter(r => (r.kind ?? 'code') === kind).at(-1)).filter(Boolean).map(r => ({ id:r!.id,kind:r!.kind??'code',identity:r!.identity,status:r!.status,failure_code:r!.failure_code })),
    history: { reviews: ledger.reviews.length, findings: ledger.findings.length, deferred: ledger.findings.filter(f => ['suggestion','disputed'].includes(f.disposition)).map(f => ({id:f.id,disposition:f.disposition})), details: 'read_quality_findings(finding_id); full audit retained on host' } }
}

export function observedQualityFinding(result: SoftwareVerification, finding: QualityFinding, caseName: string): 'passed' | 'failed' | 'unverified' {
  const host = result.core?.host_gui
  const gui = host?.case_results?.filter(c => c.name === caseName && c.feature === finding.requirement)
  if (gui?.length) return guiFindingOutcome(host!, caseName, finding.requirement)
  const cli = result.core?.host_cli?.cases.filter(c => c.name === caseName && c.covers.includes(finding.requirement))
  if (cli?.length === 1) return cliCaseOutcome(cli[0])
  return 'unverified'
}
