import { expect, it } from 'vitest'
import { composesPriorEntry } from '../../../main/software/stage-contracts'
const composed = `import prior from './stage1.mjs'; import next from './new.mjs'; export default async function(ctx){await prior(ctx);await next(ctx);}`
it('accepts only direct unchanged-context composition, including a bounded chain',()=>{
  expect(composesPriorEntry(composed,'tests/stage2.mjs','tests/stage1.mjs')).toBe(true)
  expect(composesPriorEntry(`import previous from './stage2.mjs';export default async(ctx)=>{await previous(ctx);}`,'tests/stage3.mjs','tests/stage1.mjs',p=>p==='tests/stage2.mjs'?composed:undefined)).toBe(true)
})
it('rejects skipped old entry, branches, context rewriting, alias mutation and cycles',()=>{
  for(const source of [composed.replace('await prior(ctx);await next(ctx);','await next(ctx);await prior(ctx);'),composed.replace('await prior(ctx);',''),composed.replace('await prior(ctx);','if(false)await prior(ctx);'),
    composed.replace('prior(ctx)','prior({...ctx})'),composed.replace('await prior(ctx);','prior=next;await prior(ctx);'),
    composed.replace('await prior(ctx);','return;await prior(ctx);')])expect(composesPriorEntry(source,'tests/stage2.mjs','tests/stage1.mjs')).toBe(false)
  const cyclic=`import previous from './stage2.mjs';export default async(ctx)=>{await previous(ctx);}`
  expect(composesPriorEntry(cyclic,'tests/stage2.mjs','tests/stage1.mjs',()=>cyclic)).toBe(false)
})
