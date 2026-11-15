import type {DeliveryBlock} from './delivery-qualification'
import { guiFindingOutcome, cliCaseOutcome } from './verification-evidence'
import type { SoftwareVerification } from './verification'
import { qualityHash, completedQualityReview, qualityFailureBaseline, sameIdentity, type Identity, type Ledger, type QualityFinding } from './quality-ledger'

export const importantFinding = (f: QualityFinding) => ['critical','high'].includes(f.severity) || f.review_kind === 'visual' && f.severity === 'medium'
export const sameQualityScope = (a: Identity, b: Identity) => a.target === b.target && a.environment === b.environment
/** The same accepted binding is used by planning and settlement. No name guessing. */
export function findingCaseBinding(f: QualityFinding, current: Identity, rules: string) {
  const baseline=qualityFailureBaseline(f)
  const binding=f.retest&&sameQualityScope(f.retest.identity,current)?f.retest:baseline??f.checks.at(-1)
  return binding&&binding.rules===rules&&(baseline||sameQualityScope(binding.identity,current))
    && (binding===f.retest||('grounded' in binding&&binding.grounded))?binding:undefined
}
export function investigationObligation(f: QualityFinding,current:Identity,rules:string) {
  const binding=findingCaseBinding(f,current,rules)
  return {finding_id:f.id,identity:current,trigger:f.trigger,steps:f.reproduction,expected:f.expected_source,
    unknowns:f.unknowns,binding:binding?{case_name:binding.case_name,rules:binding.rules}:null,
    missing:binding?'current_execution':'independently_confirmed_case',
    action:binding?'execute_registered_case':'implement_targeted_case_preserving_trigger_and_expectation'}
}
/** A source edit does not dispose of a suspicion. A current observed case can
 * resolve it without pretending the original candidate ever failed a test. */
export function findingNeedsInvestigation(f: QualityFinding, current: Identity, rules: string, independentRules?: string) {
  return !qualityFailureBaseline(f)
    && ['suspected','not_reproduced','confirmed','closed'].includes(f.disposition)
    && !(f.requires_execution===false && f.reviewed?.basis && sameIdentity(f.reviewed.identity,current))
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
  // Coverage judges test adequacy, not whether these suspicions have a case.
  // Keep the latest interruption authoritative; never fall back to an older PASS.
  const latestReview=ledger.reviews.filter(r=>(r.kind??'code')===reviewKind&&['candidate','binding'].includes(r.purpose??'candidate')&&sameIdentity(r.identity,current)).at(-1)
  const freshReview=Boolean(latestReview?.status==='complete'&&(!latestReview.rules||latestReview.rules===rules)
    && (latestReview.purpose==='binding'&&reviewKind==='code'||!observationDigest||latestReview.observation?.digest===observationDigest))
  const bindingFindings=[...mustFix,...investigate.filter(importantFinding)].filter(f=>!f.independent&&!findingCaseBinding(f,current,rules))
  const boundPriority=priority&&findingCaseBinding(priority,current,rules)
  const purpose=priority?'binding' as const:'candidate' as const
  let next = 'verify_app'
  if (pending.length) next = 'wait_for_delegations'
  else if (block?.code==='apply_correction') next = 'apply_test_correction'
  else if (mustFix.length && !contractChange) next = 'verify_app'
  else if(boundPriority) next='verify_app'
  else if (priority) next = freshReview && !contractChange ? 'inspect_app' : reviewKind==='visual' ? 'start_visual_review' : 'start_quality_review'
  else if (block?.code==='code_review') next = 'start_quality_review'
  else if (block?.code==='visual_review') next = 'start_visual_review'
  else if (block) next = 'inspect_app'
  return { halt: Boolean(block?.code==='independent' || block?.code==='visual_route' || block?.code==='correction_review'), purpose, identity: current, verification: 'not_issued', gate, next_tool: next,
    must_fix: mustFix.map(f => f.id), investigate: investigate.map(f => f.id), required_investigation: investigate.filter(importantFinding).map(f => f.id), binding_findings: bindingFindings.map(f=>f.id), deferred: deferred.map(f => f.id),
  }
}

/** The durable ledger remains complete. Default model input is a current work
 * queue; historical details are read explicitly by finding ID. */
export function qualityWorkQueue(ledger: Ledger, current: Identity, block: DeliveryBlock | undefined, rules: string, independentRules?: string) {
  const closeout = qualityCloseout(ledger, current, block, rules, independentRules)
  const ids = new Set([...closeout.must_fix, ...closeout.required_investigation])
  return { status: block || ids.size ? 'needs_work' : 'ready',
    summary: closeout.must_fix.length ? '实际检查仍有未解决的问题，请按具体观察修复。' : closeout.required_investigation.length ? '以下行为仍缺少足以判断的证据，请核对实际表现。' : ['intent','engineering'].includes(block?.code ?? '') ? block!.message : block ? '还有宿主验收条件尚未满足，现有产物和证据保留。' : '当前质量条件已齐备，由宿主继续交付。',
    problems: ledger.findings.filter(f=>ids.has(f.id)).map(f=>({id:f.id,requirement:f.requirement,expected:f.expected_source,trigger:f.trigger,location:f.location,investigation:investigationObligation(f,current,rules),
      observation:f.checks.at(-1)?.observation??f.evidence,observation_version:sameIdentity(f.checks.at(-1)?.identity??f.identity,current)?'current':'previous',missing:f.unknowns||f.reproduction,
      task:closeout.must_fix.includes(f.id)?'修正当前行为，保留原预期。':findingCaseBinding(f,current,rules)?'宿主执行已独立确认的案例和必要回归。':'补齐覆盖所列连续触发步骤的测试，保留原预期及前置约束；由独立审阅确认案例绑定后宿主执行。临时观察或旧套件通过不能结算。'})),
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

/** Only host-produced typed execution facts request a fresh independent judgment. */
export function currentEngineeringFailures(advice:unknown){
 const updates=(advice as {updates?:unknown[]}|undefined)?.updates
 if(!Array.isArray(updates))return []
 const failures=updates.flatMap(value=>{
  const facts=(value as {workspace_facts?:any})?.workspace_facts
  if(facts?.input_intact!==true||facts?.source_changed!==false||facts?.target_changed!==false||!Array.isArray(facts.recent_runs))return []
  return facts.recent_runs.filter((r:any)=>r.input_intact===true&&Number.isInteger(r.exit_code)&&r.exit_code!==0&&/^[a-f0-9]{64}$/.test(r.record_sha256)).map((r:any)=>({record_sha256:r.record_sha256 as string,exit_code:r.exit_code as number}))
 })
 return [...new Map(failures.map(f=>[f.record_sha256,f])).values()].sort((a,b)=>a.record_sha256.localeCompare(b.record_sha256))
}
export function unreviewedNegativeObservation(ledger:Ledger,observation:Ledger['reviews'][number]['observation']){
 const negative=(value:NonNullable<typeof observation>)=>({source:value.source,execution_failed:Boolean(value.execution_failed),engineering_failures:value.engineering_failures??[],
  steps:value.steps.filter(s=>(s as {passed?:boolean})?.passed===false),logs:value.logs.filter(l=>['renderer.error','renderer.startup_error','script.failed','action.failed','state.save_failed'].includes(String((l as {kind?:string})?.kind)))})
 if(!observation)return false
 const facts=negative(observation)
 if(!facts.execution_failed&&!facts.engineering_failures.length&&!facts.steps.length&&!facts.logs.length)return false
 const latest=ledger.reviews.filter(r=>(r.kind??'code')==='code'&&(r.purpose??'candidate')==='candidate').at(-1)
 return latest?.status!=='complete'||!latest.observation||qualityHash(negative(latest.observation))!==qualityHash(facts)
}
