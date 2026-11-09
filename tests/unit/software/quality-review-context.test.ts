import { expect, it } from 'vitest'
import { reviewReadIdentity, compactReviewManifest, reviewChangeContext } from '../../../main/software/quality-review-context'
import type { Ledger } from '../../../main/software/quality-ledger'
it('keeps desktop projects with many dependency files reviewable without hiding dependency changes',()=>{
  const files=[{path:'app.js',sha256:'app',size:10},...Array.from({length:600},(_,i)=>({path:`node_modules/lib/${i}.js`,sha256:String(i),size:10}))]
  const before=compactReviewManifest({digest:'old',files})!
  expect(before.files).toHaveLength(2)
  const ledger:Ledger={version:1,findings:[],reviews:[{id:'old',status:'complete',at:'',identity:{source:'old',target:'t',environment:'e'},source_manifest:before}]}
  const changed=structuredClone(files);changed[1].sha256='changed'
  expect(reviewChangeContext(ledger,{source:'new',target:'t',environment:'e'},compactReviewManifest({digest:'new',files:changed}),'new').mode).toBe('full')
})
it('focuses a fresh review on actual byte changes without converting previous findings into current evidence',()=>{
  const identity={source:'new',target:'target',environment:'env'}
  const ledger:Ledger={version:1,findings:[],reviews:[{id:'old',identity:{...identity,source:'old'},status:'complete',at:'',source_manifest:{digest:'old',files:[{path:'app.js',sha256:'a',size:10},{path:'audio.js',sha256:'b',size:10}]}}]}
  const manifest={digest:'new',files:[{path:'app.js',sha256:'changed',size:11},{path:'audio.js',sha256:'b',size:10}]}
  expect(reviewChangeContext(ledger,identity,manifest,'new')).toMatchObject({mode:'changes_with_prior_review',changes:[{path:'app.js',change:'changed'}],verification:'not_issued'})
  expect(reviewChangeContext(ledger,{...identity,target:'other'},manifest,'new').mode).toBe('full')
  ledger.reviews[0].status='interrupted';expect(reviewChangeContext(ledger,identity,manifest,'new').mode).toBe('full')
  ledger.reviews[0].status='complete';ledger.reviews[0].source_manifest!.digest='tampered'
  expect(reviewChangeContext(ledger,identity,manifest,'new').mode).toBe('full')
})

it('coalesces identical material aliases only for the same range and manifest',()=>{
 const m={digest:'source',files:[{path:'00_UX/confirmed.html',sha256:'same',size:9},{path:'00_UX/history/one.html',sha256:'same',size:9}]}
 const a=reviewReadIdentity(m,m.files[0].path,{path:m.files[0].path,offset:0})!
 const b=reviewReadIdentity(m,m.files[1].path,{path:m.files[1].path,offset:0})!
 expect(a.key).toBe(b.key);expect(a.aliases).toHaveLength(2)
 expect(reviewReadIdentity(m,m.files[0].path,{offset:1})!.key).not.toBe(a.key)
 expect(reviewReadIdentity({...m,digest:'new'},m.files[0].path,{offset:0})!.key).not.toBe(a.key)
})
