import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDebugSession, closeDebugSession, actDebugSession, activeDebugSessionId, type DebugSnapshot } from '../../../main/software/debug-sessions'
import { diagnosticPage } from '../../../main/software/debug-evidence'
const original=process.env.PROMA_HOME
let home:string|undefined
const rows=Array.from({length:90},(_,i)=>({seq:i+1,at:new Date(1700000000000+i*100).toISOString(),version:1,kind:'console.log',message:'record '+i,source:'a'.repeat(64)}))
afterEach(()=>{if(original===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=original;if(home)rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});home=undefined})
function fixture(state:DebugSnapshot['state']){
 home=mkdtempSync(join(tmpdir(),'bloma-debug-recovery-'));process.env.PROMA_HOME=home
 const id=randomUUID(),directory=join(home,'software-debug-sessions');mkdirSync(directory)
 const file=join(directory,id+'.json'),snapshot={id,projectId:'history',sessionId:'owner',state,version:1,source:'a'.repeat(64),stale:false,steps:[],observations:rows,log_cursor:90,error:state==='failed'?'REAL_ORIGINAL_FAILURE':undefined,root_pid:process.pid}
 writeFileSync(file,JSON.stringify(snapshot));return{id,file,snapshot}
}
it.each(['closed','failed','ready','opening','interrupted'] as const)('keeps retained %s state truthful without PID adoption or old input replay',async(state)=>{
 const {id,file}=fixture(state),before=readFileSync(file,'utf8')
 const result=readDebugSession('history','owner',id,0,{})
 expect(result.state).toBe(['ready','opening'].includes(state)?'interrupted':state)
 expect(result.runtime_attached).toBe(false);expect(result.retained_snapshot).toBe(true);expect(result.stale).toBe(true)
 if(state==='failed')expect(result.error).toBe('REAL_ORIGINAL_FAILURE')
 if(state==='closed')expect(result.error).toBeUndefined()
 expect(activeDebugSessionId('history','owner')).toBeUndefined()
 await expect(actDebugSession({projectId:'history',sessionId:'owner',id,signal:new AbortController().signal,control:{ref:'old',kind:'click'}})).rejects.toThrow('DEBUG_SESSION_INTERRUPTED')
 if(['closed','failed'].includes(state))expect((await closeDebugSession('history','owner',id)).state).toBe(state)
 expect(readFileSync(file,'utf8')).toBe(before)
 expect(()=>readDebugSession('history','other-owner',id)).toThrow('DEBUG_SESSION_NOT_OWNED')
})
it('lets two independent readers reconnect and drain all retained rows once, with a real rolling gap and no global consumer cursor',()=>{
 const {id}=fixture('closed')
 const a:number[]=[],b:number[]=[]
 let ca=0,cb=0
 do{const page=readDebugSession('history','owner',id,ca,{});a.push(...page.observations.map(r=>r.seq));ca=page.diagnostic_page!.next_seq;if(!page.diagnostic_page!.more)break}while(true)
 // B's first nonzero cursor must read the next prefix, not just the latest tail.
 cb=1;b.push(1)
 do{const page=readDebugSession('history','owner',id,cb);b.push(...page.observations.map(r=>r.seq));cb=page.diagnostic_page!.next_seq;if(!page.diagnostic_page!.more)break}while(true)
 expect(a).toEqual(rows.map(r=>r.seq));expect(b).toEqual(a);expect(new Set(a).size).toBe(a.length)
 expect(readDebugSession('history','owner',id,ca).observations).toEqual([])
 const retained=rows.slice(30),gap=diagnosticPage(retained,90,10,{})
 expect(gap.diagnostic_page.history_gap).toBe(true);expect(gap.observations[0]!.seq).toBe(31);expect(gap.diagnostic_page.next_seq).toBe(46)
 expect(()=>readDebugSession('history','owner',id,91)).toThrow('DEBUG_CURSOR_INVALID')
})
it('refuses duplicate/regressing sequences, invalid high watermarks and overlarge historical metadata instead of treating them as successful EOF',()=>{
 const {id,file,snapshot}=fixture('closed')
 for(const invalid of [{...snapshot,observations:[rows[0],rows[0]]},{...snapshot,log_cursor:2},{...snapshot,state:'PASS'},{...snapshot,source:'fake-revision'}]){
  writeFileSync(file,JSON.stringify(invalid));expect(()=>readDebugSession('history','owner',id)).toThrow('DEBUG_METADATA_INVALID')
 }
 writeFileSync(file,Buffer.alloc(2*1024*1024+1));expect(()=>readDebugSession('history','owner',id)).toThrow('DEBUG_METADATA_LIMIT_OR_LINK')
})

it('rejects a metadata directory redirected outside PROMA_HOME even if identity fields match',()=>{
 const {id,file,snapshot}=fixture('closed'),foreign=mkdtempSync(join(tmpdir(),'bloma-debug-foreign-'))
 try{writeFileSync(join(foreign,id+'.json'),JSON.stringify(snapshot));rmSync(join(home!,'software-debug-sessions'),{recursive:true});symlinkSync(foreign,join(home!,'software-debug-sessions'),'junction');expect(()=>readDebugSession('history','owner',id)).toThrow('DEBUG_METADATA_LIMIT_OR_LINK')}finally{rmSync(join(home!,'software-debug-sessions'),{recursive:true,force:true});rmSync(foreign,{recursive:true,force:true})}
})
