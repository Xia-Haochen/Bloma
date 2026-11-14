import {frozenNativeGuiRoot,validateNativeGuiTests,type NativeGuiTests} from './native-gui-tests'
import {readProjectStages} from './project-stages'
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
export type ReviewPurpose = 'candidate' | 'binding' | 'coverage' | 'exploration'
export type ReviewKind = 'code' | 'visual'
export interface Review { purpose?: ReviewPurpose; rules?: string; id: string; kind?: ReviewKind; identity: Identity; status: 'pending' | 'submitted' | 'complete' | 'interrupted'; child?: string; delegation?: string; at: string
  exploration?: { trace: import('./interaction-exploration').InteractionTrace[]; digest: string; actions: number; limitations: string }
  engineering?: import('./engineering-design').EngineeringReview
  observation?: {digest:string;source?:string;image_hash?:string;execution_failed?:boolean;engineering_failures?:Array<{record_sha256:string;exit_code:number}>;ui:unknown;steps:unknown[];logs:unknown[]}
  resolutions?: Array<{finding_id:string;evidence:string;case_name?:string;basis?:'static_misread'|'not_applicable'}>
  run_id?: string; failure_code?: string
  source_manifest?: import('./quality-review-context').ReviewSourceManifest
  intent_observations?: import('./intent-review').IntentObservation[]; visual?: VisualMaterial; image?: PastedImageRef; visual_delivery?: { at: string; image_hash: string; request_hash: string }; visual_observations?: unknown[]
  visual_error?: 'MODEL_IMAGE_INPUT_UNSUPPORTED'; visual_route?: string }
export interface QualityFinding {
  origin?: 'interaction'; exploration_key?: string
  id: string; review: string; identity: Identity; requirement: string; expected_source: string; category: string
  review_kind?: ReviewKind; visual_material_hash?: string
  independent?: { design_version: string; design_digest: string; case_id: string }
  retest?: { identity: Identity; review: string; evidence: string; case_name: string; rules: string }
  requires_execution?: boolean
  reviewed?: { identity: Identity; review: string; evidence: string; basis?: 'static_misread'|'not_applicable' }
  challenge?: { at: string; reason: string; evidence: string; source: 'implementer_claim'; resolution?:{review:string;action:'correct'|'retain';reason:string} }
  severity: 'critical' | 'high' | 'medium' | 'low'; location: string; trigger: string; evidence: string; reproduction: string; unknowns: string
  disposition: 'suspected' | 'disputed' | 'suggestion' | 'not_reproduced' | 'confirmed' | 'closed' | 'superseded'
  checks: Array<{ grounded?: boolean; at: string; identity: Identity; case_name: string; rules: string; outcome: 'failed' | 'passed' | 'unverified'; report?: string; candidate?: string; observation: string }>
}
export interface Ledger { version: 1; reviews: Review[]; findings: QualityFinding[]; collaboration?: CollaborationSelection[] }
import {qualityHash,qualityLedgerPath,readQualityLedger,saveQualityLedger} from './quality-store'
export {qualityHash,qualityLedgerPath,readQualityLedger,saveQualityLedger} from './quality-store'
export const sameIdentity = (a: Identity, b: Identity) => qualityHash(a) === qualityHash(b)
export async function qualityIdentity(projectId: string, signal?: AbortSignal): Promise<Identity> {
  const brief = readPrdBackplane(projectId)
  if (!brief.user_confirmed_at) throw Error('QUALITY_TARGET_NOT_CONFIRMED')
  readConfirmedUxBinding(projectId, brief)
  const {input_identity}=await (await import('./verification')).verificationInputs(projectId,'quality-identity',signal)
  return qualityIdentityForInputs(projectId,input_identity)
}
/** Derive quality identity from already validated execution dependencies. */
export function qualityTargetIdentity(projectId:string) {
  const project=findProject(projectId),brief=readPrdBackplane(projectId)
  return qualityHash([prdScopeFingerprint(brief),brief.user_confirmed_at,project.ux_confirmation])
}
export function qualityIdentityForInputs(projectId:string,inputs:{source:string;environment:string;rules:string}):Identity {
  return {source:inputs.source,target:qualityTargetIdentity(projectId),environment:qualityHash([inputs.environment,inputs.rules])}
}


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

export function completedQualityReview(ledger:Ledger,kind:ReviewKind,current:Identity){
  const latest=ledger.reviews.filter(r=>(r.kind??'code')===kind&&(r.purpose??'candidate')==='candidate').at(-1)
  return latest?.status==='complete'&&sameIdentity(latest.identity,current)?latest:undefined
}

/** Read-only projection of frozen contracts; no duplicate assertions are stored. */
export function registeredQualityCases(projectId:string,includeStages=false):Array<{name:string;requirements:string[];file:string}> {
  const rows:Array<{name:string;requirements:string[];file:string}>=[]
  for(const file of [guiSuitePath(projectId),cliSuitePath(projectId)]){
    if(!existsSync(file))continue
    const suite=JSON.parse(readFileSync(file,'utf8'))
    for(const c of suite.native_tests?.cases??suite.cases??[]) rows.push({name:c.name,requirements:c.covers??[c.feature],file})
    for(const [name,requirements] of Object.entries(suite.acceptance_refs??{}))rows.push({name,requirements:requirements as string[],file})
  }
  if(includeStages){
    const native=readProjectStages(projectId).attempts.filter(a=>a.scope===prdScopeFingerprint(readPrdBackplane(projectId))).at(-1)?.native
    for(const c of native?.cases??[])if(!rows.some(r=>r.name===c.name&&r.requirements.includes(c.feature)))rows.push({name:c.name,requirements:[c.feature],file:native!.layout==='project'?native!.entry:native!.directory+'/'+native!.entry})
  }
  return rows
}
export function qualityCoverageRulesVersion(projectId:string){
 const stage=readProjectStages(projectId).attempts.filter(a=>a.scope===prdScopeFingerprint(readPrdBackplane(projectId))).at(-1)
 return qualityHash([qualityRulesVersion(projectId),stage?.native.digest])
}

/** File capabilities derived from registered immutable contracts, never caller paths. */
export function qualityTestSources(projectId:string,includeStages=false){
 const files=new Map<string,{key:string;path:string;sha256:string;size:number}>()
 const nativeFiles=(native:NativeGuiTests)=>{
   validateNativeGuiTests(native)
   const root=frozenNativeGuiRoot(projectId,native,findProject(projectId).root_path)
   for(const f of native.files){const key=native.digest+'/'+f.path;files.set(key,{key,path:join(root,f.path),sha256:f.sha256,size:f.size})}
 }
 for(const [kind,path]of [['gui',guiSuitePath(projectId)],['cli',cliSuitePath(projectId)]]){
  if(!existsSync(path))continue
  const bytes=readFileSync(path),suite=JSON.parse(bytes.toString('utf8'))
  files.set(kind,{key:kind,path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length})
  if(suite.native_tests)nativeFiles(suite.native_tests)
 }
 if(includeStages){const stage=readProjectStages(projectId).attempts.filter(a=>a.scope===prdScopeFingerprint(readPrdBackplane(projectId))).at(-1);if(stage)nativeFiles(stage.native)}
 return [...files.values()]
}
