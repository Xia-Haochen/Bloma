import { createHash } from 'node:crypto'
import type { ToolFileChange } from '../../../shared/tool-display'
const hash = (value:Buffer)=>createHash('sha256').update(value).digest('hex')
/** One exact contiguous replacement hunk, not an inferred/minimal line diff.
 * Full logical text is redacted BEFORE clipping, so a prefix cutoff cannot
 * expose the tail of a credential. Omitted data stays explicitly omitted. */
export function committedChange(path:string,before:Buffer|null|undefined,after:Buffer,redact:(s:string)=>string):ToolFileChange {
 const base:ToolFileChange={path,after:hash(after),created:before===null,omitted:before===undefined}
 if(before===undefined)return base
 if(before)base.before=hash(before)
 const old=before?.toString('utf8')??'',next=after.toString('utf8')
 if((before&&!before.equals(Buffer.from(old)))||!after.equals(Buffer.from(next))){base.omitted=true;return base}
 let start=0,endOld=old.length,endNew=next.length
 while(start<endOld&&start<endNew&&old[start]===next[start])start++
 if(start===endOld&&start===endNew)return {...base,line:1,removed:'',added:''}
 while(start>0&&old[start-1]!=='\n')start--
 while(endOld>start&&endNew>start&&old[endOld-1]===next[endNew-1]){endOld--;endNew--}
 // Include the rest of a changed line (including CRLF), never claim line numbers
 // for a substring in the middle of a line or split a surrogate pair.
 if((endOld>0&&old[endOld-1]!=='\n')||(endNew>0&&next[endNew-1]!=='\n')){
  const newline=old.indexOf('\n',endOld),extra=newline<0?old.length-endOld:newline-endOld+1
  endOld+=extra;endNew+=extra
 }
 let line=1;for(let i=0;i<start;i++)if(old[i]==='\n')line++
 const removed=redact(old.slice(start,endOld)),added=redact(next.slice(start,endNew))
 const clip=(s:string)=>s.length<=1800?s:s.slice(0,/^[\uDC00-\uDFFF]$/.test(s[1800]??'')?1799:1800)
 return {...base,line,removed:clip(removed),added:clip(added),omitted:removed.length>1800||added.length>1800}
}
