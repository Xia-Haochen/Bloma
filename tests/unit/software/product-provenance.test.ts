import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { componentSource, componentContract } from '../../../main/software/component-contracts'
const require=createRequire(import.meta.url)
const {createDataStore}=require(componentSource('product_store.cjs'))
const {createProvenance}=require(componentSource('product_provenance.cjs'))
it.each(['私人收藏的身份与豁免','史料整理的事实与推断'])('%s preserves corrections and invalidates transitive derived results across restart',domain=>{
  const directory=mkdtempSync(join(tmpdir(),'product-provenance-'))
  try{
    const store=createDataStore({dataDir:directory}),p=createProvenance({store})
    const first=p.source({id:'subject',expectedRevision:0,payload:{domain,name:'A',exception:true}})
    const captured=p.capture(['subject'])
    p.publish({id:'analysis',expectedRevision:0,kind:'inference',payload:'待核对结论',sources:captured})
    p.publish({id:'story',expectedRevision:0,kind:'creative',payload:'故事',sources:p.capture(['analysis'])})
    p.source({id:'subject',expectedRevision:first.revision,payload:{domain,name:'B',exception:true}})
    expect(p.current().map((r:any)=>r.id)).toEqual(['subject'])
    expect(p.read().records.story.data.status).toBe('stale')
    expect(()=>p.publish({id:'late',expectedRevision:0,kind:'inference',payload:'迟到结果',sources:captured})).toThrow('STALE')
    const reopened=createProvenance({store:createDataStore({dataDir:directory})})
    expect(reopened.current()[0].data.payload).toMatchObject({name:'B',exception:true})
    expect(()=>reopened.remove({id:'subject',expectedRevision:2})).toThrow('DEPENDENTS')
    reopened.remove({id:'subject',expectedRevision:2,cascade:true})
    expect(Object.keys(reopened.read().records)).toEqual([])
  }finally{rmSync(directory,{recursive:true,force:true})}
})
it('rejects cancellation, forged fact promotion, cyclic derivation and stale corrections without partial writes',()=>{
  const directory=mkdtempSync(join(tmpdir(),'product-provenance-'))
  try{
    const p=createProvenance({store:createDataStore({dataDir:directory})})
    p.source({id:'source',expectedRevision:0,payload:'用户事实'})
    const sources=p.capture(['source']),signal=AbortSignal.abort()
    expect(()=>p.publish({id:'result',expectedRevision:0,kind:'inference',payload:'cancelled',sources,signal})).toThrow()
    expect(()=>p.publish({id:'result',expectedRevision:0,kind:'fact',payload:'guess',sources})).toThrow('INVALID')
    p.publish({id:'result',expectedRevision:0,kind:'inference',payload:'guess',sources})
    expect(()=>p.publish({id:'result',expectedRevision:1,kind:'inference',payload:'cycle',sources:p.capture(['result'])})).toThrow('CYCLE')
    const before=p.read();expect(()=>p.source({id:'source',expectedRevision:0,payload:'overwrite'})).toThrow('STALE')
    expect(p.read()).toEqual(before)
    expect(componentContract('provenance')?.entry).toBe('createProvenance')
  }finally{rmSync(directory,{recursive:true,force:true})}
})
