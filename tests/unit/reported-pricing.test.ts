import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {reserveModelRequest,readMonetaryBudget} from '../../main/platform/llm/monetary-budget'
import {reconcileReportedPricing} from '../../main/platform/llm/reported-pricing'
let root:string,policy:string,proofPath:string,reference:string
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const url='https://pricing.invalid/messages',body=JSON.stringify({model:'test',max_tokens:1000,messages:[]})
const state=()=>JSON.parse(readFileSync(policy+'.state.json','utf8'))
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'bloma-reported-pricing-'));policy=join(root,'policy.json');proofPath=join(root,'proof.json');reference=join(root,'pricing.html')
  vi.stubEnv('BLOMA_MONETARY_EPOCH_DIR',join(root,'epochs'))
  writeFileSync(policy,JSON.stringify({version:1,models:[{host:'pricing.invalid',model:'test',cap_rmb:5,context_tokens:1000000,input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:.04}]}))
  writeFileSync(reference,'Controlled operator-reviewed tariff fixture')
})
afterEach(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true})})
function proof(ids:string[],extra:Record<string,unknown>={}){
  const now=Date.now();const value={version:1,source:'reviewed_provider_pricing',host:'pricing.invalid',model:'test',reviewed_at:new Date(now).toISOString(),valid_from:new Date(now-86400000).toISOString(),valid_until:new Date(now+86400000).toISOString(),rates:{input_rmb_per_million:1,output_rmb_per_million:4,cache_rmb_per_million:.02},reference:{url:'https://pricing.invalid/rates',path:reference,sha256:sha(readFileSync(reference))},covered_request_ids:ids,...extra}
  writeFileSync(proofPath,JSON.stringify(value));return value
}
it('settles known usage at a reviewed tariff without changing entries, unknown reservations or the cap',()=>{
  reserveModelRequest(url,body,policy)!.settle({input_tokens:800000,output_tokens:1000},true)
  reserveModelRequest(url,body,policy)!.settle(undefined,false)
  const original=state().entries,policyBytes=readFileSync(policy,'utf8')
  expect(readMonetaryBudget(policy)[0].accounted_upper_rmb).toBe(3.616)
  expect(()=>reserveModelRequest(url,body,policy)).toThrow('MONETARY_BUDGET_EXHAUSTED')
  proof([original[0].id]);reconcileReportedPricing(policy,proofPath)
  expect(state().entries).toEqual(original);expect(readFileSync(policy,'utf8')).toBe(policyBytes)
  expect(readMonetaryBudget(policy)[0]).toMatchObject({accounted_upper_rmb:2.812,cap_rmb:5,reported_peak_rmb:1.608,reported_priced_rmb:.804})
  reserveModelRequest(url,body,policy)!.settle(undefined,false)
  expect(readMonetaryBudget(policy)[0].accounted_upper_rmb).toBe(4.82)
  expect(()=>reserveModelRequest(url,body,policy)).toThrow('MONETARY_BUDGET_EXHAUSTED')
  try{reserveModelRequest(url,body,policy)}catch(error){expect((error as {admission:unknown}).admission).toMatchObject({accounted_upper_rmb:4.82,reported_upper_rmb:.804,unresolved_reserve_rmb:4.016})}
  expect(state().entries.slice(0,2)).toEqual(original)
})
it('rejects unknown coverage, active requests and duplicated credits without changing the ledger',()=>{
  const ticket=reserveModelRequest(url,body,policy)!
  proof([state().entries[0].id]);const active=readFileSync(policy+'.state.json','utf8')
  expect(()=>reconcileReportedPricing(policy,proofPath)).toThrow('IN_FLIGHT');expect(readFileSync(policy+'.state.json','utf8')).toBe(active)
  ticket.settle(undefined,false);const unknown=readFileSync(policy+'.state.json','utf8')
  expect(()=>reconcileReportedPricing(policy,proofPath)).toThrow('PRICING_INVALID');expect(readFileSync(policy+'.state.json','utf8')).toBe(unknown)
  reserveModelRequest(url,body,policy)!.settle({input_tokens:10,output_tokens:10},true)
  proof([state().entries[1].id]);reconcileReportedPricing(policy,proofPath)
  const once=readFileSync(policy+'.state.json','utf8')
  expect(()=>reconcileReportedPricing(policy,proofPath)).toThrow('PRICING_INVALID');expect(readFileSync(policy+'.state.json','utf8')).toBe(once)
})
it.each(['wrong model','expired window','higher rate','missing timestamp'] as const)('rejects inapplicable evidence: %s',scenario=>{
  reserveModelRequest(url,body,policy)!.settle({input_tokens:100,output_tokens:10},true)
  if(scenario==='missing timestamp'){const s=state();delete s.entries[0].at;writeFileSync(policy+'.state.json',JSON.stringify(s))}
  proof([state().entries[0].id],scenario==='wrong model'?{model:'other'}:scenario==='expired window'?{valid_until:new Date(Date.now()-1000).toISOString()}:scenario==='higher rate'?{rates:{input_rmb_per_million:3,output_rmb_per_million:4,cache_rmb_per_million:.02}}:{})
  const before=readFileSync(policy+'.state.json','utf8')
  expect(()=>reconcileReportedPricing(policy,proofPath)).toThrow('PRICING_INVALID');expect(readFileSync(policy+'.state.json','utf8')).toBe(before)
})
it('detects changed pricing evidence and changed covered usage before new admission',()=>{
  reserveModelRequest(url,body,policy)!.settle({input_tokens:100,output_tokens:10},true)
  proof([state().entries[0].id]);reconcileReportedPricing(policy,proofPath)
  const proofBytes=readFileSync(proofPath);writeFileSync(proofPath,Buffer.concat([proofBytes,Buffer.from(' ')]))
  expect(()=>readMonetaryBudget(policy)).toThrow('PRICING_EVIDENCE_CHANGED');writeFileSync(proofPath,proofBytes)
  const original=readFileSync(reference);writeFileSync(reference,'changed')
  expect(()=>reserveModelRequest(url,body,policy)).toThrow('PRICING_INVALID')
  writeFileSync(reference,original);const s=state();s.entries[0].usage.output_tokens=1;writeFileSync(policy+'.state.json',JSON.stringify(s))
  expect(()=>readMonetaryBudget(policy)).toThrow('PRICING_INVALID')
})
it('never applies a tariff credit and a balance credit to the same request',()=>{
  reserveModelRequest(url,body,policy)!.settle({input_tokens:100,output_tokens:10},true)
  const id=state().entries[0].id;proof([id]);reconcileReportedPricing(policy,proofPath)
  const evidence=JSON.stringify({source:'direct_user_confirmation',host:'pricing.invalid',model:'test',start_balance_rmb:1,end_balance_lower_bound_rmb:1,external_changes:false,covered_request_ids:[id]})
  const file=join(root,'balance.json');writeFileSync(file,evidence)
  const s=state();s.balance_checkpoints=[{id:'balance',host:'pricing.invalid',model:'test',covered_request_ids:[id],spent_upper_micro_rmb:0,evidence_path:file,evidence_sha256:sha(evidence)}]
  writeFileSync(policy+'.state.json',JSON.stringify(s))
  expect(()=>readMonetaryBudget(policy)).toThrow('PRICING_INVALID')
})
it('retains historical settlement after the tariff window expires, without repricing future calls',()=>{
  reserveModelRequest(url,body,policy)!.settle({input_tokens:100,output_tokens:10},true)
  proof([state().entries[0].id]);reconcileReportedPricing(policy,proofPath)
  vi.useFakeTimers();vi.setSystemTime(Date.now()+3*86400000)
  try{
    expect(readMonetaryBudget(policy)[0].reported_priced_rmb).toBe(.00014)
    reserveModelRequest(url,body,policy)!.settle({input_tokens:100,output_tokens:10},true)
    expect(readMonetaryBudget(policy)[0].accounted_upper_rmb).toBe(.00042)
  }finally{vi.useRealTimers()}
})
