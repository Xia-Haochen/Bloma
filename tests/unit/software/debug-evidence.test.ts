import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { applicationDiagnostic, compareDebugData, diagnosticPage, snapshotDebugData } from '../../../main/software/debug-evidence'
const homes:string[]=[]
const root=()=>{const p=mkdtempSync(join(tmpdir(),'bloma-debug-evidence-'));homes.push(p);return p}
const signal=()=>new AbortController().signal
const source='a'.repeat(64)
afterEach(()=>{for(const p of homes.splice(0))rmSync(p,{recursive:true,force:true,maxRetries:5,retryDelay:150})})
it('only accepts small application-reported IPC/storage markers, never host-owned receipt fields or PASS',()=>{
 expect(applicationDiagnostic('ordinary log')).toBeUndefined()
 expect(applicationDiagnostic('BLOMA_DIAGNOSTIC '+JSON.stringify({kind:'ipc',phase:'failed',trace_id:'app-1',code:'ENOENT',message:'token=PRIVATE_VALUE'}))).toMatchObject({kind:'application.ipc.failed',trace_id:'app-1',code:'ENOENT'})
 for(const extra of [{source:'fake'},{seq:1},{action:'save'},{kind:'PASS'},{phase:'verified'}])expect(()=>applicationDiagnostic('BLOMA_DIAGNOSTIC '+JSON.stringify({kind:'ipc',phase:'failed',trace_id:'app-1',...extra}))).toThrow()
 expect(()=>applicationDiagnostic('BLOMA_DIAGNOSTIC '+'x'.repeat(5000))).toThrow('TOO_LARGE')
})
it('has stable literal query pages, candidate/time/process filters, sequence gaps and bounded historical results',()=>{
 const rows=Array.from({length:90},(_,i)=>({seq:i+11,at:'2026-11-11T21:00:00.000Z',version:2,source,operation_id:'host-1',trace_id:i%2?'other':'app-1',process_id:'p',kind:'application.ipc.failed',message:'x'.repeat(500)}))
 const first=diagnosticPage(rows,100,0,{trace_id:'app-1',source,from:'2026-11-11T20:00:00Z',process_id:'p',operation_id:'host-1',limit:3})
 expect(first.observations.map(x=>x.seq)).toEqual([11,13,15]);expect(first.diagnostic_page).toMatchObject({more:true,next_seq:15,history_gap:true})
 const next=diagnosticPage(rows,100,first.diagnostic_page.next_seq,{trace_id:'app-1',limit:2});expect(next.observations.map(x=>x.seq)).toEqual([17,19])
 expect(diagnosticPage(rows,100,0,{source:'b'.repeat(64)}).observations).toHaveLength(0)
 const bounded=diagnosticPage(rows,100,0,{kind:'application',limit:80});expect(Buffer.byteLength(JSON.stringify(bounded.observations))).toBeLessThanOrEqual(12000)
 for(const q of [{version:0},{unknown:'x'},{from:'yesterday'},{limit:81}])expect(()=>diagnosticPage(rows,100,0,q)).toThrow('QUERY_INVALID')
 expect(()=>diagnosticPage(rows,100,101)).toThrow('CURSOR_INVALID')
})
it('compares complete own data bytes, including binary, non-ASCII and __proto__ filenames without reading bodies into evidence',async()=>{
 const data=root();writeFileSync(join(data,'__proto__'),'old');writeFileSync(join(data,'Ω.bin'),Buffer.from([0,255,10]))
 const before=await snapshotDebugData(data,signal());expect(before.complete,before.gaps.join()).toBe(true)
 writeFileSync(join(data,'__proto__'),'new');mkdirSync(join(data,'nested'));writeFileSync(join(data,'nested','saved.json'),'sensitive-body')
 const after=await snapshotDebugData(data,signal()),delta=compareDebugData(before,after)
 expect(delta).toMatchObject({complete:true,changed:2,unobserved:0});expect(delta.before_digest).not.toBe(delta.after_digest)
 expect(delta.changes.map(c=>c.path)).toContain('__proto__');expect(JSON.stringify(delta)).not.toContain('sensitive-body')
 expect(compareDebugData(after,await snapshotDebugData(data,signal()))).toMatchObject({complete:true,changed:0})
})
it('reports quota/cancellation/link and missing directory gaps, never incomplete absence as a deletion or unchanged certificate',async()=>{
 const data=root(),foreign=root();writeFileSync(join(data,'note'),'body');writeFileSync(join(foreign,'outside-secret'),'private')
 const full=await snapshotDebugData(data,signal()),partial=await snapshotDebugData(data,signal(),{files:0,bytes:0,fileBytes:0,ms:1500})
 expect(partial.complete).toBe(false);expect(partial.digest).toBeUndefined();expect(compareDebugData(full,partial)).toMatchObject({complete:false,changed:0,unobserved:1})
 symlinkSync(foreign,join(data,'escape'),process.platform==='win32'?'junction':'dir')
 const link=await snapshotDebugData(data,signal());expect(link.complete).toBe(false);expect(link.gaps).toContain('DATA_LINK_UNOBSERVED');expect(JSON.stringify(link)).not.toContain('outside-secret')
 const controller=new AbortController();controller.abort();expect((await snapshotDebugData(data,controller.signal)).gaps).toContain('DATA_OBSERVATION_CANCELLED')
 expect((await snapshotDebugData(join(data,'missing'),signal())).complete).toBe(false)
})
it('yields while hashing a bounded multi-file dataset instead of blocking the host loop',async()=>{
 const data=root();for(let i=0;i<64;i++)writeFileSync(join(data,`${i}.bin`),Buffer.alloc(8192,i))
 let ticks=0;const timer=setInterval(()=>ticks++,1)
 try{expect((await snapshotDebugData(data,signal())).complete).toBe(true);expect(ticks).toBeGreaterThan(0)}finally{clearInterval(timer)}
})

it('excludes only explicitly declared host profiles, not application files, and records the changed scope',async()=>{
 const data=root();mkdirSync(join(data,'electron-profile'));writeFileSync(join(data,'electron-profile','Cache.bin'),Buffer.alloc(1024*1024+1));writeFileSync(join(data,'actual-note'),'actual body')
 const before=await snapshotDebugData(data,signal(),undefined,['electron-profile']);expect(before.complete).toBe(true);expect(before.excluded).toEqual(['electron-profile'])
 writeFileSync(join(data,'electron-profile','Cache.bin'),'changed cache')
 const after=await snapshotDebugData(data,signal(),undefined,['electron-profile']);expect(compareDebugData(before,after)).toMatchObject({complete:true,changed:0,excluded:{before:['electron-profile'],after:['electron-profile']}})
 const broader=await snapshotDebugData(data,signal());const changedScope=compareDebugData(after,broader)
 expect(changedScope.complete).toBe(false);expect(changedScope.gaps).toContain('DATA_SCOPE_CHANGED');expect(changedScope.unobserved).toBe(1)
 expect(Object.keys(before.files)).toEqual(['actual-note'])
})

it('does not leak an environment secret through structured trace_id or code fields',()=>{
 const key='TEST_DIAGNOSTIC_SECRET',previous=process.env[key],secret='SecretTraceValue_123456789';process.env[key]=secret
 try{const value=applicationDiagnostic('BLOMA_DIAGNOSTIC '+JSON.stringify({kind:'ipc',phase:'failed',trace_id:secret,code:secret,message:secret}));expect(JSON.stringify(value)).not.toContain(secret);expect(value?.trace_id).toBeUndefined()}finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous}
})
