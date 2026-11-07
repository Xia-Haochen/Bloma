import {createHash,randomUUID} from 'node:crypto'
import {readFileSync,openSync,closeSync,writeFileSync,renameSync,unlinkSync,existsSync} from 'node:fs'
import {isAbsolute,resolve} from 'node:path'

interface Rates {input_rmb_per_million:number;output_rmb_per_million:number;cache_rmb_per_million:number}
interface Entry {id:string;host:string;model:string;at?:string;status:string;charged_micro_rmb:number;reserved_micro_rmb:number;usage?:{input_tokens?:number;output_tokens?:number;cache_read_input_tokens?:number;cache_creation_input_tokens?:number}}
export interface ReportedPricingCheckpoint {
  id:string;host:string;model:string;applied_at:string;covered_request_ids:string[];
  entries_sha256:string;original_micro_rmb:number;settled_micro_rmb:number;
  evidence_path:string;evidence_sha256:string
}
interface Evidence {version:1;source:'reviewed_provider_pricing';host:string;model:string;reviewed_at:string;valid_from:string;valid_until:string;rates:Rates;reference:{url:string;path:string;sha256:string};covered_request_ids:string[]}
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const fail=():never=>{throw Error('MONETARY_REPORTED_PRICING_INVALID')}
const entryHash=(rows:Entry[])=>hash(JSON.stringify(rows.map(e=>[e.id,e.host,e.model,e.at,e.status,e.charged_micro_rmb,e.reserved_micro_rmb,e.usage])))
function calculate(proof:Evidence,entries:Entry[],appliedAt:string){
  const at=Date.parse(appliedAt),from=Date.parse(proof.valid_from),until=Date.parse(proof.valid_until),reviewed=Date.parse(proof.reviewed_at)
  if(proof.version!==1||proof.source!=='reviewed_provider_pricing'||!proof.host||!proof.model
    ||![at,from,until,reviewed].every(Number.isFinite)||from>at||at>=until||reviewed>at||at-reviewed>86400000
    ||!proof.reference?.url?.startsWith('https://')||!isAbsolute(proof.reference.path)||hash(readFileSync(proof.reference.path))!==proof.reference.sha256
    ||!Array.isArray(proof.covered_request_ids)||!proof.covered_request_ids.length||new Set(proof.covered_request_ids).size!==proof.covered_request_ids.length)fail()
  const rates=proof.rates
  if(!rates||[rates.input_rmb_per_million,rates.output_rmb_per_million,rates.cache_rmb_per_million].some(v=>!Number.isFinite(v)||v<0)
    ||rates.output_rmb_per_million<=0||rates.cache_rmb_per_million>rates.input_rmb_per_million)fail()
  const byId=new Map(entries.map(e=>[e.id,e]))
  if(byId.size!==entries.length)fail()
  const rows=proof.covered_request_ids.map(id=>byId.get(id)??fail())
  let original=0,settled=0
  for(const row of rows){
    const start=Date.parse(row.at??''),u=row.usage
    if(row.host!==proof.host||row.model!==proof.model||row.status!=='reported'||!Number.isFinite(start)||start<from||start>at
      ||!integer(row.charged_micro_rmb)||!u||!integer(u.input_tokens)||!integer(u.output_tokens)
      ||[u.cache_read_input_tokens,u.cache_creation_input_tokens].some(v=>v!==undefined&&!integer(v)))fail()
    const charge=Math.ceil((u!.input_tokens!+(u!.cache_creation_input_tokens??0))*rates.input_rmb_per_million)
      +Math.ceil((u!.cache_read_input_tokens??0)*rates.cache_rmb_per_million)+Math.ceil(u!.output_tokens!*rates.output_rmb_per_million)
    if(!integer(charge)||charge>row.charged_micro_rmb)fail()
    original+=row.charged_micro_rmb;settled+=charge
  }
  return{original,settled,entries_sha256:entryHash(rows)}
}

/** Operator-reviewed tariff evidence is separate from admission rates. Only
 * finished reported calls may be repriced; unknown reservations stay untouched.
 * Hash checks bind evidence, not an automatic certification of a pricing page. */
export function reportedPricingCredit(checkpoint:ReportedPricingCheckpoint,entries:Entry[],covered:Set<string>){
  const bytes=readFileSync(checkpoint.evidence_path)
  if(hash(bytes)!==checkpoint.evidence_sha256)throw Error('MONETARY_PRICING_EVIDENCE_CHANGED')
  const proof=JSON.parse(bytes.toString('utf8')) as Evidence,result=calculate(proof,entries,checkpoint.applied_at)
  if(checkpoint.host!==proof.host||checkpoint.model!==proof.model||JSON.stringify(checkpoint.covered_request_ids)!==JSON.stringify(proof.covered_request_ids)
    ||checkpoint.entries_sha256!==result.entries_sha256||checkpoint.original_micro_rmb!==result.original||checkpoint.settled_micro_rmb!==result.settled
    ||checkpoint.covered_request_ids.some(id=>covered.has(id)))fail()
  checkpoint.covered_request_ids.forEach(id=>covered.add(id))
  return result.original-result.settled
}

/** Host/operator entry point, never an Agent tool. It keeps the policy and every
 * original entry byte-for-byte equivalent as JSON values and appends evidence. */
export function reconcileReportedPricing(policyPath:string,evidencePath:string){
  evidencePath=resolve(evidencePath)
  const lock=policyPath+'.lock',fd=openSync(lock,'wx'),statePath=policyPath+'.state.json',temp=statePath+'.'+randomUUID()+'.tmp'
  try{
    const policyBytes=readFileSync(policyPath),policy=JSON.parse(policyBytes.toString('utf8').replace(/^\uFEFF/,''))
    const state=JSON.parse(readFileSync(statePath,'utf8')),bytes=readFileSync(evidencePath),proof=JSON.parse(bytes.toString('utf8')) as Evidence
    if(policy.version!==1||!Array.isArray(policy.models)||state.version!==1||state.policy_hash!==hash(policyBytes)||!Array.isArray(state.entries)
      ||state.entries.some((e:Entry)=>!integer(e.charged_micro_rmb)||!integer(e.reserved_micro_rmb)||!policy.models.some((r:{host:string;model:string})=>r.host===e.host&&r.model===e.model)))fail()
    if(state.entries.some((e:Entry)=>e.status==='reserved'))throw Error('MONETARY_RECONCILIATION_IN_FLIGHT')
    const rate=policy.models?.find((r:Rates&{host:string;model:string})=>r.host===proof.host&&r.model===proof.model)
    if(!rate||!proof.rates||(['input_rmb_per_million','output_rmb_per_million','cache_rmb_per_million'] as const).some(k=>proof.rates[k]>rate[k]))fail()
    const covered=new Set<string>((state.balance_checkpoints??[]).flatMap((c:{covered_request_ids:string[]})=>c.covered_request_ids))
    for(const c of state.reported_pricing_checkpoints??[])reportedPricingCredit(c,state.entries,covered)
    const applied_at=new Date().toISOString(),result=calculate(proof,state.entries,applied_at)
    const checkpoint:ReportedPricingCheckpoint={id:randomUUID(),host:proof.host,model:proof.model,applied_at,
      covered_request_ids:proof.covered_request_ids,entries_sha256:result.entries_sha256,original_micro_rmb:result.original,settled_micro_rmb:result.settled,evidence_path:evidencePath,evidence_sha256:hash(bytes)}
    reportedPricingCredit(checkpoint,state.entries,covered)
    state.reported_pricing_checkpoints=[...(state.reported_pricing_checkpoints??[]),checkpoint]
    writeFileSync(temp,JSON.stringify(state,null,2),{flag:'wx'});renameSync(temp,statePath)
    return checkpoint
  }finally{if(existsSync(temp))unlinkSync(temp);closeSync(fd);unlinkSync(lock)}
}
