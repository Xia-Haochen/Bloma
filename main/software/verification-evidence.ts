import type { GuiAcceptanceResult } from '../desktop/gui-acceptance'
import type { IndependentCaseResult, IndependentVerification } from './independent-verification'
import type { LeanCliResult } from '../desktop/lean-cli-check'

/** Interpret host observations once; never issue delivery receipts or infer a
 * product root cause from an adapter error. */
export function guiCaseEvidence(host: GuiAcceptanceResult, name: string) {
  const matches = (host.steps??[]).filter(step => step.id === name || step.actual && typeof step.actual === 'object'
    && (step.actual as {test?:string}).test === name)
  const step = matches.find(step => !step.passed) ?? matches[0]
  const assertion = (step?.actual as {assertion?:{expected?:unknown;actual?:unknown}} | undefined)?.assertion
  return { step, assertion, explicitAssertion: Boolean(assertion && (assertion.expected !== undefined || assertion.actual !== undefined)) }
}
export function guiFindingOutcome(host: GuiAcceptanceResult, name: string, feature: string): 'passed'|'failed'|'unverified' {
  const rows = host.case_results?.filter(row => row.name === name && row.feature === feature)
  if (rows?.length !== 1 || host.source_unchanged === false || ['runtime','bootstrap'].includes(host.failure_kind ?? '')) return 'unverified'
  const row = rows[0]
  if (row.status === 'passed') return row.assertions > 0 && host.native_evidence?.interactions !== 0 ? 'passed' : 'unverified'
  if (row.status === 'failed' && (host.method !== 'node:test' || guiCaseEvidence(host,name).explicitAssertion)) return 'failed'
  return 'unverified'
}
export function cliCaseOutcome(row: LeanCliResult['cases'][number]): 'passed'|'failed'|'unverified' {
  return !Number.isInteger(row.exit_code) ? 'unverified' : row.passed ? 'passed' : 'failed'
}
export function independentCaseOutcome(row: IndependentCaseResult): 'passed'|'failed'|'unverified' {
  return row.status === 'passed' ? 'passed' : row.status === 'failed'
    && ['product_assertion','product_runtime'].includes(row.kind) ? 'failed' : 'unverified'
}
export function independentFailureEvidence(result?: IndependentVerification) {
  const row = result?.case_results?.find(row => independentCaseOutcome(row) === 'failed')
    ?? result?.case_results?.find(row => row.status !== 'passed')
  const step = row?.steps.find(step => !step.passed), diagnostic = result?.diagnostic
  const matching = diagnostic && (!row || diagnostic.id === row.id || diagnostic.id.startsWith(row.id+'-')) ? diagnostic : undefined
  return { row, id: step?.id ?? row?.id ?? matching?.id,
    expected: matching?.expected ?? row?.expected_source, actual: matching?.actual ?? step?.actual ?? row?.error }
}
