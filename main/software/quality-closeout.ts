import type { SoftwareVerification } from './verification'
import { sameIdentity, type Identity, type Ledger, type QualityFinding } from './quality-ledger'

export function findingNeedsClosure(f: QualityFinding, current: Identity, rules: string, independentRules?: string) {
  return f.disposition !== 'superseded'
    && (['critical', 'high'].includes(f.severity) || f.review_kind === 'visual' && f.severity === 'medium')
    && f.checks.some(c => c.outcome === 'failed')
    && !(f.disposition === 'closed' && f.checks.at(-1)?.outcome === 'passed'
      && sameIdentity(f.checks.at(-1)!.identity, current)
      && f.checks.at(-1)!.rules === (f.independent ? independentRules : rules))
}

/** Read-only work ordering. This never issues a release receipt or closes a finding. */
export function qualityCloseout(ledger: Ledger, current: Identity, gate: string | undefined, rules: string, independentRules?: string) {
  const mustFix = ledger.findings.filter(f => findingNeedsClosure(f, current, rules, independentRules))
  const investigate = ledger.findings.filter(f => sameIdentity(f.identity, current) && f.disposition === 'suspected')
  const deferred = ledger.findings.filter(f => sameIdentity(f.identity, current)
    && (f.disposition === 'suggestion' || f.disposition === 'disputed'))
  const pending = ledger.reviews.filter(r => sameIdentity(r.identity, current) && ['pending', 'submitted'].includes(r.status))
  const priority = investigate.find(f => ['critical','high'].includes(f.severity) || f.review_kind === 'visual' && f.severity === 'medium')
  const next = pending.length ? 'wait_for_delegations' : mustFix.length || priority ? 'check_quality_finding'
    : gate?.startsWith('QUALITY_REVIEW_REQUIRED') ? 'start_quality_review'
    : gate?.startsWith('QUALITY_VISUAL_REVIEW_REQUIRED') ? 'start_visual_review'
    : gate ? 'inspect_app' : 'verify_app'
  return { identity: current, verification: 'not_issued', gate, next_tool: next,
    must_fix: mustFix.map(f => f.id), investigate: investigate.map(f => f.id), deferred: deferred.map(f => f.id),
    policy: '先复现重要疑点、修复并同案例复测，再集中审阅稳定候选。suggestion/disputed不自动扩充本轮范围；低优先疑点保留记录，不为清空意见反复改动。审阅齐备后verify_app，通过后结束制作，由宿主核对并发布。任何源码变化都不能复用旧候选证据。' }
}

export function observedQualityFinding(result: SoftwareVerification, finding: QualityFinding, caseName: string): 'passed' | 'failed' | 'unverified' {
  const host = result.core?.host_gui
  const gui = host?.case_results?.filter(c => c.name === caseName && c.feature === finding.requirement)
  if (gui?.length === 1 && gui[0].assertions > 0 && ['passed', 'failed'].includes(gui[0].status)) {
    if (host?.failure_kind === 'runtime' || host?.source_unchanged === false) return 'unverified'
    if (gui[0].status === 'failed' && host?.method === 'node:test') {
      const step = host.steps.find(step => !step.passed && step.actual && typeof step.actual === 'object'
        && (step.actual as { test?: string }).test === caseName)
      const assertion = (step?.actual as { assertion?: { expected?: unknown; actual?: unknown } } | undefined)?.assertion
      if (!assertion || assertion.expected === undefined && assertion.actual === undefined) return 'unverified'
    }
    return gui[0].status as 'passed' | 'failed'
  }
  const cli = result.core?.host_cli?.cases.filter(c => c.name === caseName && c.covers.includes(finding.requirement))
  if (cli?.length === 1 && cli[0].exit_code !== null) return cli[0].passed ? 'passed' : 'failed'
  return 'unverified'
}
