import type {DeliveryBlock} from './delivery-qualification'
import { guiFindingOutcome, cliCaseOutcome } from './verification-evidence'
import type { SoftwareVerification } from './verification'
import { completedQualityReview, qualityFailureBaseline, sameIdentity, type Identity, type Ledger, type QualityFinding } from './quality-ledger'

export const importantFinding = (f: QualityFinding) => ['critical','high'].includes(f.severity) || f.review_kind === 'visual' && f.severity === 'medium'
export const sameQualityScope = (a: Identity, b: Identity) => a.target === b.target && a.environment === b.environment
/** A source edit does not dispose of a suspicion. A current observed case can
 * resolve it without pretending the original candidate ever failed a test. */
export function findingNeedsInvestigation(f: QualityFinding, current: Identity, rules: string, independentRules?: string) {
  return !qualityFailureBaseline(f)
    && ['suspected','not_reproduced','confirmed','closed'].includes(f.disposition)
    && !(f.reviewed && sameIdentity(f.reviewed.identity,current))
    && !((f.independent || f.checks.at(-1)?.grounded) && f.disposition === 'not_reproduced' && f.checks.at(-1)?.outcome === 'passed'
      && sameIdentity(f.checks.at(-1)!.identity, current) && f.checks.at(-1)!.rules === (f.independent?independentRules:rules))
}

export function findingNeedsClosure(f: QualityFinding, current: Identity, rules: string, independentRules?: string) {
  return f.disposition !== 'superseded'
    && Boolean(qualityFailureBaseline(f))
    && !(f.disposition === 'closed' && f.checks.at(-1)?.outcome === 'passed'
      && sameIdentity(f.checks.at(-1)!.identity, current)
      && f.checks.at(-1)!.rules === (f.independent ? independentRules : rules))
}

/** Read-only work ordering. This never issues a release receipt or closes a finding. */
export function qualityCloseout(ledger: Ledger, current: Identity, block: DeliveryBlock | undefined, rules: string, independentRules?: string, observationDigest?:string) {
  const gate=block?.message
  const mustFix = ledger.findings.filter(f => findingNeedsClosure(f, current, rules, independentRules))
  const investigate = ledger.findings.filter(f => findingNeedsInvestigation(f, current, rules, independentRules))
  const deferred = ledger.findings.filter(f => sameIdentity(f.identity, current)
    && (f.disposition === 'suggestion' || f.disposition === 'disputed'))
  const pending = ledger.reviews.filter(r => sameIdentity(r.identity, current) && ['pending', 'submitted'].includes(r.status))
  const contractChange=mustFix.find(f=>qualityFailureBaseline(f)?.rules!==(f.independent?independentRules:rules) && !(f.retest&&sameIdentity(f.retest.identity,current)&&f.retest.rules===rules))
  const priority = contractChange??investigate.find(importantFinding)
  const reviewKind=priority?.review_kind??'code'
  const latestReview=completedQualityReview(ledger,reviewKind,current)
  const freshReview=Boolean(latestReview&&(!observationDigest||latestReview.observation?.digest===observationDigest))
  let next = 'verify_app'
  if (pending.length) next = 'wait_for_delegations'
  else if (block?.code==='apply_correction') next = 'apply_test_correction'
  else if (mustFix.length && !contractChange) next = 'verify_app'
  else if (priority) next = freshReview && !contractChange ? 'inspect_app' : reviewKind==='visual' ? 'start_visual_review' : 'start_quality_review'
  else if (block?.code==='code_review') next = 'start_quality_review'
  else if (block?.code==='visual_review') next = 'start_visual_review'
  else if (block) next = 'inspect_app'
  return { halt: Boolean(block?.code==='independent' || block?.code==='visual_route' || block?.code==='correction_review'), identity: current, verification: 'not_issued', gate, next_tool: next,
    must_fix: mustFix.map(f => f.id), investigate: investigate.map(f => f.id), required_investigation: investigate.filter(importantFinding).map(f => f.id), deferred: deferred.map(f => f.id),
  }
}

/** The durable ledger remains complete. Default model input is a current work
 * queue; historical details are read explicitly by finding ID. */
export function qualityWorkQueue(ledger: Ledger, current: Identity, block: DeliveryBlock | undefined, rules: string, independentRules?: string) {
  const closeout = qualityCloseout(ledger, current, block, rules, independentRules)
  const ids = new Set([...closeout.must_fix, ...closeout.required_investigation])
  return { status: block || ids.size ? 'needs_work' : 'ready',
    summary: closeout.must_fix.length ? '实际检查仍有未解决的问题，请按具体观察修复。' : closeout.required_investigation.length ? '以下行为仍缺少足以判断的证据，请核对实际表现。' : block?.code==='intent' ? block.message : block ? '还有宿主验收条件尚未满足，现有产物和证据保留。' : '当前质量条件已齐备，由宿主继续交付。',
    problems: ledger.findings.filter(f=>ids.has(f.id)).map(f=>({id:f.id,requirement:f.requirement,expected:f.expected_source,trigger:f.trigger,location:f.location,
      observation:f.checks.at(-1)?.observation??f.evidence,observation_version:sameIdentity(f.checks.at(-1)?.identity??f.identity,current)?'current':'previous',missing:f.unknowns||f.reproduction,
      task:closeout.must_fix.includes(f.id)?'修正当前行为，保留原预期。':'提供针对该触发条件的实际观察；普通案例通过不足以排除疑点。'})),
    deferred: closeout.deferred,
    history: { reviews: ledger.reviews.length, findings: ledger.findings.length, details: 'read_quality_findings(finding_id)' } }

}

export function observedQualityFinding(result: SoftwareVerification, finding: QualityFinding, caseName: string): 'passed' | 'failed' | 'unverified' {
  const host = result.core?.host_gui
  const gui = host?.case_results?.filter(c => c.name === caseName && c.feature === finding.requirement)
  if (gui?.length) return guiFindingOutcome(host!, caseName, finding.requirement)
  const cli = result.core?.host_cli?.cases.filter(c => c.name === caseName && c.covers.includes(finding.requirement))
  if (cli?.length === 1) return cliCaseOutcome(cli[0])
  return 'unverified'
}
