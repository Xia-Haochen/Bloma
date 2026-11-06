import { trustedAcceptance } from '../project/requirement-contract'
import { guiSuitePath } from '../desktop/gui-acceptance'
import { cliSuitePath } from '../desktop/lean-cli-check'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { prdScopeFingerprint } from '../project/requirement-contract'
import type { VisualMaterial } from './visual-review-material'
import type { PastedImageRef } from '../../shared/types'
import type { CollaborationSelection } from './collaboration-selection'

export type Identity = { source: string; target: string; environment: string }
export type ReviewKind = 'code' | 'visual'
export interface Review { id: string; kind?: ReviewKind; identity: Identity; status: 'pending' | 'submitted' | 'complete' | 'interrupted'; child?: string; delegation?: string; at: string
  resolutions?: Array<{finding_id:string;evidence:string;case_name?:string}>
  run_id?: string; failure_code?: string
  source_manifest?: import('./quality-review-context').ReviewSourceManifest
  intent_observations?: import('./intent-review').IntentObservation[]; visual?: VisualMaterial; image?: PastedImageRef; visual_delivery?: { at: string; image_hash: string; request_hash: string }; visual_observations?: unknown[]
  visual_error?: 'MODEL_IMAGE_INPUT_UNSUPPORTED'; visual_route?: string }
export interface QualityFinding {
  id: string; review: string; identity: Identity; requirement: string; expected_source: string; category: string
  review_kind?: ReviewKind; visual_material_hash?: string
  independent?: { design_version: string; design_digest: string; case_id: string }
  retest?: { identity: Identity; review: string; evidence: string; case_name: string; rules: string }
  reviewed?: { identity: Identity; review: string; evidence: string }
  challenge?: { at: string; reason: string; evidence: string; source: 'implementer_claim' }
  severity: 'critical' | 'high' | 'medium' | 'low'; location: string; trigger: string; evidence: string; reproduction: string; unknowns: string
  disposition: 'suspected' | 'disputed' | 'suggestion' | 'not_reproduced' | 'confirmed' | 'closed' | 'superseded'
  checks: Array<{ grounded?: boolean; at: string; identity: Identity; case_name: string; rules: string; outcome: 'failed' | 'passed' | 'unverified'; report?: string; candidate?: string; observation: string }>
}
export interface Ledger { version: 1; reviews: Review[]; findings: QualityFinding[]; collaboration?: CollaborationSelection[] }
export const qualityHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sameIdentity = (a: Identity, b: Identity) => qualityHash(a) === qualityHash(b)
export function qualityLedgerPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('QUALITY_PROJECT_INVALID')
  return join(getPromaHome(), 'software-quality', `${projectId}.json`)
}
export function readQualityLedger(projectId: string): Ledger {
  const path = qualityLedgerPath(projectId)
  if (!existsSync(path)) return { version: 1, reviews: [], findings: [] }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Ledger
  if (value.version !== 1 || !Array.isArray(value.reviews) || !Array.isArray(value.findings) || value.collaboration!==undefined&&!Array.isArray(value.collaboration)) throw Error('QUALITY_LEDGER_INVALID')
  return value // Corrupt evidence must fail closed, never silently reset history.
}
export async function qualityIdentity(projectId: string, signal?: AbortSignal): Promise<Identity> {
  const brief = readPrdBackplane(projectId)
  if (!brief.user_confirmed_at) throw Error('QUALITY_TARGET_NOT_CONFIRMED')
  readConfirmedUxBinding(projectId, brief)
  const {input_identity}=await (await import('./verification')).verificationInputs(projectId,'quality-identity',signal)
  return qualityIdentityForInputs(projectId,input_identity)
}
/** Derive quality identity from already validated execution dependencies. */
export function qualityIdentityForInputs(projectId:string,inputs:{source:string;environment:string;rules:string}):Identity {
  const project=findProject(projectId),brief=readPrdBackplane(projectId)
  return {source:inputs.source,target:qualityHash([prdScopeFingerprint(brief),brief.user_confirmed_at,project.ux_confirmation]),environment:qualityHash([inputs.environment,inputs.rules,project.lean_operation_id])}
}
export const saveQualityLedger = (projectId: string, ledger: Ledger) => writeTextFileAtomic(qualityLedgerPath(projectId), JSON.stringify(ledger, null, 2))

export function qualityRulesVersion(projectId: string) {
  return qualityHash([guiSuitePath(projectId), cliSuitePath(projectId)].map(path => existsSync(path) ? readFileSync(path).toString('base64') : null))
}

/** Scope is derived from the current confirmed requirement, not from old run IDs.
 * History stays intact; a removed/changed requirement is not a repaired defect. */
export function applicableQualityLedger(projectId: string): Ledger {
  const ledger=readQualityLedger(projectId),brief=readPrdBackplane(projectId)
  return {...ledger,findings:ledger.findings.filter(f=>{
    if(f.requirement==='unscoped'||['suggestion','disputed'].includes(f.disposition))return true
    const requirement=brief.requirements.find(r=>r.id===f.requirement)
    return Boolean(requirement && trustedAcceptance(brief,requirement)===f.expected_source)
  })}
}

/** Raw execution failures are not automatically proof of a reviewer's trigger. */
export function qualityFailureBaseline(finding: QualityFinding) {
  return finding.checks.filter(c=>c.outcome==='failed'&&(finding.independent||c.grounded===true)).at(-1)
}
