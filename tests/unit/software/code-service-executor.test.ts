import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { executeCodeService } from '../../../main/software/code-service-executor'
const roots: string[] = []
function fixture() { const root = mkdtempSync(join(tmpdir(),'bloma-code-worker-')); roots.push(root); writeFileSync(join(root,'value.ts'),'export const amount = 42\n'); writeFileSync(join(root,'use.ts'),'import { amount } from "./value"; export const result = amount\n'); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}) })
it('executes the production-built compiler worker, not a mocked synchronous backend', async () => {
 const root = fixture(), result = await executeCodeService(root,{kind:'definition',path:'use.ts',line:1,column:57})
 expect(result.ok,JSON.stringify(result)).toBe(true)
 if (result.ok) { expect(result.backend).toBe('typescript-language-service'); expect(result.items.some(item=>'location' in item&&item.location?.path==='value.ts')).toBe(true) }
 const missing = await executeCodeService(root,{kind:'definition',path:'none.py',line:1,column:1})
 expect(missing).toMatchObject({ok:false,error:{code:'PYTHON_BACKEND_UNAVAILABLE'}})
},30000)
it('hard-stops read-only work for cancellation/deadline, frees the slot, and lets the host event loop continue', async () => {
 const root = fixture(), abort = new AbortController(); let hostTicks=0
 const timer = setInterval(()=>hostTicks++,5)
 const pending = executeCodeService(root,{kind:'diagnostics',path:'use.ts'},{signal:abort.signal})
 const cancel = setTimeout(()=>abort.abort(),100)
 try { expect(await pending).toMatchObject({ok:false,error:{code:'CANCELLED'}}) } finally { clearInterval(timer); clearTimeout(cancel) }
 expect(hostTicks).toBeGreaterThan(0)
 expect(await executeCodeService(root,{kind:'symbol',path:'use.ts'},{timeoutMs:1})).toMatchObject({ok:false,error:{code:'DEADLINE_EXCEEDED'}})
 expect((await executeCodeService(root,{kind:'symbol',path:'use.ts'})).ok).toBe(true)
},30000)
it('does not start a third compiler or any already-cancelled query', async()=>{
 const root=fixture(), a=new AbortController(), b=new AbortController()
 const first=executeCodeService(root,{kind:'symbol',path:'use.ts'},{signal:a.signal}),second=executeCodeService(root,{kind:'symbol',path:'use.ts'},{signal:b.signal})
 expect(await executeCodeService(root,{kind:'symbol',path:'use.ts'})).toMatchObject({ok:false,error:{code:'CODE_SERVICE_BUSY'}})
 a.abort();b.abort();await Promise.all([first,second])
 expect(await executeCodeService(root,{kind:'symbol',path:'use.ts'},{signal:a.signal})).toMatchObject({ok:false,error:{code:'CANCELLED'}})
},30000)
