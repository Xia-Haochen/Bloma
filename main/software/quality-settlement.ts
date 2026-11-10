import { serializeRedactedJson } from '../../shared/redacted-json'
import { redactSoftwareOutput } from './process-manager'
import { applicableQualityLedger, qualityFailureBaseline, qualityIdentity, qualityRulesVersion, readQualityLedger, saveQualityLedger, sameIdentity } from './quality-ledger'
import { observedQualityFinding, findingCaseBinding } from './quality-closeout'
import type { SoftwareVerification } from './verification'

/** Called only by the verifier after validating its execution inputs. Reuse the
 * original case binding, never guess reproduction coverage from a feature ID. */
export async function settleObservedQuality(projectId: string, result: SoftwareVerification, signal?: AbortSignal, validatedIdentity?: import('./quality-ledger').Identity) {
  if (!result.candidate || !['passed','failed'].includes(result.status)) return
  const ledger = readQualityLedger(projectId)
  if(!ledger.findings.some(f=>!f.independent&&(f.checks.length||f.retest)&&!['suggestion','disputed','superseded'].includes(f.disposition)))return
  const current = validatedIdentity ?? await qualityIdentity(projectId, signal), rules = qualityRulesVersion(projectId)
  if (current.source !== result.candidate.source.digest) throw Error('QUALITY_SETTLEMENT_SOURCE_CHANGED')
  const applicable=new Set(applicableQualityLedger(projectId).findings.map(f=>f.id))
  let changed = false
  for (const finding of ledger.findings) {
    if (!applicable.has(finding.id) || finding.independent || ['suggestion','disputed','superseded'].includes(finding.disposition)) continue
    const baseline = qualityFailureBaseline(finding), binding = findingCaseBinding(finding,current,rules)
    if (!binding || binding.rules !== rules) continue
    const outcome = observedQualityFinding(result, finding, binding.case_name)
    if (outcome === 'unverified' || outcome === 'passed' && result.status !== 'passed') continue
    const last = finding.checks.at(-1)
    if (last?.grounded && last.candidate === result.candidate.id && last.outcome === outcome && last.rules === rules && last.case_name === binding.case_name && sameIdentity(last.identity, current)) continue
    finding.checks.push({ grounded:Boolean(finding.retest&&binding===finding.retest || baseline?.grounded), at: new Date().toISOString(), identity: current, rules, case_name: binding.case_name,
      outcome, candidate: result.candidate.id, report: result.report_path,
      observation: serializeRedactedJson({ source: 'host_verification', status: result.status, case_name: binding.case_name, outcome,
        gui: result.core?.host_gui?.case_results?.filter(c => c.name === binding.case_name && c.feature === finding.requirement),
        cli: result.core?.host_cli?.cases.filter(c => c.name === binding.case_name && c.covers.includes(finding.requirement)) },redactSoftwareOutput) })
    const grounded=finding.checks.at(-1)?.grounded
    finding.disposition = outcome === 'failed' && grounded ? 'confirmed' : baseline ? 'closed' : outcome==='passed'&&grounded?'not_reproduced':'suspected'
    changed = true
  }
  signal?.throwIfAborted()
  if (changed) saveQualityLedger(projectId, ledger)
}
