import type { Identity, Ledger } from './quality-ledger'
import { createHash } from 'node:crypto'

export interface ReviewSourceManifest { digest: string; files: Array<{path:string;sha256:string;size:number}> }
export function repeatedReviewFailure(ledger: Ledger, current: Identity, runId: string | undefined): string | undefined {
  if(!runId)return
  for(const kind of ['code','visual']){
    const recent=ledger.reviews.filter(r=>r.purpose!=='exploration'&&r.run_id===runId&&(r.kind??'code')===kind).slice(-2)
    if(recent.length===2&&recent.every(r=>r.status==='interrupted'&&r.failure_code&&r.failure_code===recent[0].failure_code
      &&r.identity.source===current.source&&r.identity.target===current.target&&r.identity.environment===current.environment))return `${kind}:${recent[0].failure_code}`
  }
}
export function compactReviewManifest(inventory: ReviewSourceManifest): ReviewSourceManifest | undefined {
  const files=inventory.files.filter(f=>!f.path.startsWith('node_modules/')&&!f.path.startsWith('.venv/')).map(f=>({...f}))
  if(files.length>256)return undefined
  for(const directory of ['node_modules/','.venv/']){
    const dependencies=inventory.files.filter(f=>f.path.startsWith(directory))
    if(dependencies.length)files.push({path:directory+'**',sha256:createHash('sha256').update(JSON.stringify(dependencies)).digest('hex'),size:dependencies.reduce((n,f)=>n+f.size,0)})
  }
  return{digest:inventory.digest,files}
}
/** Evidence-backed focus only. A new candidate still needs a fresh review and
 * its normal host checks; a small diff never issues or reuses a PASS. */
export function reviewChangeContext(ledger: Ledger, current: Identity, manifest: ReviewSourceManifest | undefined, reviewId: string) {
  const prior=ledger.reviews.filter(r=>r.id!==reviewId&&(r.kind??'code')==='code'&&r.status==='complete'&&(r.purpose??'candidate')==='candidate'
    &&r.identity.target===current.target&&r.identity.environment===current.environment&&r.source_manifest?.digest===r.identity.source).at(-1)
  if(!manifest||manifest.digest!==current.source||!prior?.source_manifest)return{mode:'full',reason:'没有同目标/环境且具备完整文件清单的已完成审阅',verification:'not_issued'}
  const before=new Map(prior.source_manifest.files.map(f=>[f.path,f.sha256])),after=new Map(manifest.files.map(f=>[f.path,f.sha256]))
  const changes=[...new Set([...before.keys(),...after.keys()])].filter(path=>before.get(path)!==after.get(path)).sort()
    .map(path=>({path,change:!before.has(path)?'added':!after.has(path)?'deleted':'changed'}))
  if(changes.some(c=>c.path.endsWith('/**')))return{mode:'full',reason:'依赖字节变化，不能仅按应用文件差异缩小审阅',changes,verification:'not_issued'}
  return{mode:'changes_with_prior_review',previous_review:prior.id,previous_source:prior.identity.source,changes:changes.slice(0,128),changed_count:changes.length,
    previous_findings:ledger.findings.filter(f=>f.review===prior.id).map(f=>({id:f.id,requirement:f.requirement,severity:f.severity,disposition:f.disposition,location:f.location,trigger:f.trigger})),
    verification:'not_issued',instruction:'优先核对变化文件、相关调用链及旧疑点；依赖影响不明或此前未覆盖时扩大阅读。上次意见不是当前通过证明，必须对当前候选重新提交。'}
}

/** Exact file-byte and request-span aliases only. Paths and hashes remain visible. */
export function reviewReadIdentity(manifest:ReviewSourceManifest|undefined,path:string,input:Record<string,unknown>){
 const file=manifest?.files.find(f=>f.path===path)
 if(!file||path.endsWith('/**'))return
 const {path:_path,...range}=input
 return{key:JSON.stringify([manifest!.digest,file.sha256,range]),sha256:file.sha256,
   aliases:manifest!.files.filter(f=>f.sha256===file.sha256&&f.size===file.size).map(f=>f.path)}
}
