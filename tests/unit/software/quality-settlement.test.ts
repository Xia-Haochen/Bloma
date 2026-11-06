import {beforeEach,expect,it,vi} from 'vitest'
import {settleObservedQuality} from '../../../main/software/quality-settlement'
const state=vi.hoisted(()=>({ledger:{version:1,reviews:[],findings:[]} as any,save:vi.fn()}))
vi.mock('../../../main/software/quality-ledger',()=>({applicableQualityLedger:()=>state.ledger,qualityFailureBaseline:(f:any)=>f.checks.filter((c:any)=>c.outcome==='failed'&&(f.independent||c.grounded)).at(-1),qualityIdentity:async()=>({source:'new',target:'goal',environment:'env'}),qualityRulesVersion:()=> 'rules',readQualityLedger:()=>state.ledger,saveQualityLedger:state.save,sameIdentity:(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b)}))
vi.mock('../../../main/software/process-manager',()=>({redactSoftwareOutput:(s:string)=>s}))
const result=()=>({status:'passed',candidate:{id:'candidate',source:{digest:'new'}},core:{host_cli:{cases:[{name:'sum',covers:['F-001'],passed:true,exit_code:0}]}}} as any)
beforeEach(()=>{state.save.mockClear();state.ledger={version:1,reviews:[],findings:[{id:'finding',requirement:'F-001',disposition:'confirmed',checks:[{identity:{source:'old',target:'goal',environment:'env'},rules:'rules',case_name:'sum',grounded:true,outcome:'failed'}]}]}})
it.each(['rules','unbound','missing','duplicate','incomplete','independent','disputed'])('does not settle %s evidence',async kind=>{
 const f=state.ledger.findings[0],r=result()
 if(kind==='rules')f.checks[0].rules='changed'
 if(kind==='goal')f.checks[0].identity.target='other'
 if(kind==='environment')f.checks[0].identity.environment='other'
 if(kind==='unbound')f.checks=[]
 if(kind==='missing')r.core.host_cli.cases=[]
 if(kind==='duplicate')r.core.host_cli.cases.push({...r.core.host_cli.cases[0]})
 if(kind==='incomplete')r.status='unverified'
 if(kind==='independent')f.independent={case_id:'sum'}
 if(kind==='disputed')f.disposition='disputed'
 const before=JSON.stringify(state.ledger)
 await settleObservedQuality('p',r)
 expect(state.save).not.toHaveBeenCalled();expect(JSON.stringify(state.ledger)).toBe(before)
})
it('settles once for the same candidate and refuses a changed source',async()=>{
 await settleObservedQuality('p',result());await settleObservedQuality('p',result())
 expect(state.save).toHaveBeenCalledTimes(1);expect(state.ledger.findings[0].checks).toHaveLength(2)
 const r=result();r.candidate.source.digest='foreign'
 await expect(settleObservedQuality('p',r)).rejects.toThrow('SOURCE_CHANGED')
})
it('cancellation cannot save a settlement',async()=>{
 const c=new AbortController();c.abort()
 await expect(settleObservedQuality('p',result(),c.signal)).rejects.toThrow()
 expect(state.save).not.toHaveBeenCalled()
})

it('retests an applicable grounded case after environment changes without erasing its original evidence',async()=>{
 state.ledger.findings[0].checks[0].identity.environment='previous-runtime'
 await settleObservedQuality('p',result())
 expect(state.ledger.findings[0].disposition).toBe('closed')
 expect(state.ledger.findings[0].checks[0].identity.environment).toBe('previous-runtime')
})
