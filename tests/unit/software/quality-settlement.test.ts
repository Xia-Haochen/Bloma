import {beforeEach,expect,it,vi} from 'vitest'
import {settleObservedQuality} from '../../../main/software/quality-settlement'
import campus from '../../fixtures/delivery-convergence-20261109.json'
const state=vi.hoisted(()=>({ledger:{version:1,reviews:[],findings:[]} as any,save:vi.fn()}))
vi.mock('../../../main/software/quality-ledger',()=>({applicableQualityLedger:()=>state.ledger,qualityFailureBaseline:(f:any)=>f.checks.filter((c:any)=>c.outcome==='failed'&&(f.independent||c.grounded)).at(-1),qualityIdentity:async()=>({source:'new',target:'goal',environment:'env'}),qualityRulesVersion:()=> 'rules',readQualityLedger:()=>state.ledger,saveQualityLedger:state.save,sameIdentity:(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b)}))
vi.mock('../../../main/software/process-manager',()=>({redactSoftwareOutput:(s:string)=>s}))
const result=()=>({status:'passed',candidate:{id:'candidate',source:{digest:'new'}},core:{host_cli:{cases:[{name:'sum',covers:['F-001'],passed:true,exit_code:0}]}}} as any)
it('closes an actually repaired bound defect while unrelated acceptance preparation is pending',async()=>{
 const r=result()
 r.status='unverified'
 r.independent={status:'unverified',error:'another feature needs a service'}
 await settleObservedQuality('p',r)
 expect(state.ledger.findings[0].disposition).toBe('closed')
 expect(state.ledger.findings[0].checks.at(-1)).toMatchObject({outcome:'passed',case_name:'sum',candidate:'candidate'})
})
beforeEach(()=>{state.save.mockClear();state.ledger={version:1,reviews:[],findings:[{id:'finding',requirement:'F-001',disposition:'confirmed',checks:[{identity:{source:'old',target:'goal',environment:'env'},rules:'rules',case_name:'sum',grounded:true,outcome:'failed'}]}]}})
it('preserves real campus suspicions when the old registered suite passes without a scenario binding',async()=>{
 state.ledger.findings=structuredClone(campus.findings)
 const before=JSON.stringify(state.ledger)
 await settleObservedQuality('p',result())
 expect(JSON.stringify(state.ledger)).toBe(before)
 expect(state.ledger.findings.filter((f:any)=>f.severity==='high').map((f:any)=>f.checks.length)).toEqual([0,0])
 expect(state.save).not.toHaveBeenCalled()
 expect(campus.requests.find(r=>r.sequence===121)?.tools).toEqual(expect.arrayContaining([expect.objectContaining({feedback:expect.objectContaining({verification:'passed'})})]))
 expect(campus.requests.filter(r=>[124,128].includes(r.sequence)).every(r=>r.partner_handoff)).toBe(true)
 expect(campus.requests.filter(r=>[194,195].includes(r.sequence)).map(r=>r.physical_started)).toEqual([0,0])
})
it.each(['rules','unbound','missing','duplicate','incomplete','independent','disputed'])('does not settle %s evidence',async kind=>{
 const f=state.ledger.findings[0],r=result()
 if(kind==='rules')f.checks[0].rules='changed'
 if(kind==='goal')f.checks[0].identity.target='other'
 if(kind==='environment')f.checks[0].identity.environment='other'
 if(kind==='unbound')f.checks=[]
 if(kind==='missing')r.core.host_cli.cases=[]
 if(kind==='duplicate')r.core.host_cli.cases.push({...r.core.host_cli.cases[0]})
 if(kind==='incomplete'){r.status='unverified';r.core.host_cli.cases[0].exit_code=null}
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


it('settles each independently bound same-case finding once and leaves a similar unbound trigger open',async()=>{
 const baseline=state.ledger.findings[0]
 const binding={identity:{source:'new',target:'goal',environment:'env'},review:'independent',case_name:'sum',rules:'rules',evidence:'exact trigger and preserved expectation'}
 state.ledger.findings=[baseline,{id:'copy',requirement:'F-001',disposition:'suspected',checks:[],retest:binding},{id:'other-copy',requirement:'F-001',disposition:'suspected',checks:[],retest:binding},{id:'different-path',requirement:'F-001',disposition:'suspected',checks:[]}]
 await settleObservedQuality('p',result());await settleObservedQuality('p',result())
 expect(state.ledger.findings.map((f:any)=>f.disposition)).toEqual(['closed','not_reproduced','not_reproduced','suspected'])
 expect(state.ledger.findings.map((f:any)=>f.checks.length)).toEqual([2,1,1,0])
 expect(baseline.checks[0].outcome).toBe('failed');expect(state.save).toHaveBeenCalledTimes(1)
})
it.each(['gui','cli'])('only retains the bound requirement in %s settlement observations',async kind=>{
 const r=result()
 if(kind==='cli')r.core.host_cli.cases.push({name:'sum',covers:['F-999'],passed:true,exit_code:0,stdout:'foreign record'})
 else r.core={host_gui:{case_results:[{name:'sum',feature:'F-001',assertions:1,status:'passed'},{name:'sum',feature:'F-999',assertions:1,status:'passed',detail:'foreign record'}]}}
 await settleObservedQuality('p',r)
 const observation=JSON.parse(state.ledger.findings[0].checks.at(-1).observation)
 expect(observation[kind]).toHaveLength(1);expect(JSON.stringify(observation)).not.toContain('F-999')
})
it('does not reuse an old-rule check just because candidate and outcome match',async()=>{
 const f=state.ledger.findings[0]
 f.checks.push({identity:{source:'new',target:'goal',environment:'env'},rules:'old-rules',case_name:'sum',grounded:true,outcome:'passed',candidate:'candidate'})
 f.retest={identity:{source:'new',target:'goal',environment:'env'},rules:'rules',case_name:'sum',review:'new-binding',evidence:'current contract'}
 await settleObservedQuality('p',result())
 expect(f.checks).toHaveLength(3);expect(f.checks.at(-1).rules).toBe('rules');expect(state.save).toHaveBeenCalledTimes(1)
})
