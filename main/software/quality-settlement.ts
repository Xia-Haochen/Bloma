import { redactSoftwareOutput } from './process-manager'
import { qualityIdentity, qualityRulesVersion, readQualityLedger, saveQualityLedger, sameIdentity } from './quality-ledger'
import { observedQualityFinding, sameQualityScope } from './quality-closeout'
import type { SoftwareVerification } from './verification'

/** Called only by the verifier after validating its execution inputs. Reuse the
 * original case binding, never guess reproduction coverage from a feature ID. */
export async function settleObservedQuality(projectId: string, result: SoftwareVerification, signal?: AbortSignal) {
  if (!result.candidate || !['passed','failed'].includes(result.status)) return
  const current = await qualityIdentity(projectId, signal), rules = qualityRulesVersion(projectId)
  if (current.source !== result.candidate.source.digest) throw Error('QUALITY_SETTLEMENT_SOURCE_CHANGED')
  const ledger = readQualityLedger(projectId)
  let changed = false
  for (const finding of ledger.findings) {
    if (finding.independent || ['suggestion','disputed','superseded'].includes(finding.disposition)) continue
    const baseline = finding.checks.find(c => c.outcome === 'failed'), binding = baseline ?? finding.checks.at(-1)
    if (!binding || binding.rules !== rules || !sameQualityScope(binding.identity, current)) continue
    const outcome = observedQualityFinding(result, finding, binding.case_name)
    if (outcome === 'unverified' || outcome === 'passed' && result.status !== 'passed') continue
    const last = finding.checks.at(-1)
    if (last?.candidate === result.candidate.id && last.outcome === outcome && sameIdentity(last.identity, current)) continue
    finding.checks.push({ at: new Date().toISOString(), identity: current, rules, case_name: binding.case_name,
      outcome, candidate: result.candidate.id, report: result.report_path,
      observation: redactSoftwareOutput(JSON.stringify({ source: 'host_verification', status: result.status, case_name: binding.case_name, outcome,
        gui: result.core?.host_gui?.case_results?.filter(c => c.name === binding.case_name),
        cli: result.core?.host_cli?.cases.filter(c => c.name === binding.case_name) })) })
    finding.disposition = outcome === 'failed' ? 'confirmed' : baseline ? 'closed' : 'not_reproduced'
    changed = true
  }
  signal?.throwIfAborted()
  if (changed) saveQualityLedger(projectId, ledger)
}
