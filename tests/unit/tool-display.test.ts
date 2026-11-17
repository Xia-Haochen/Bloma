import { Buffer } from 'node:buffer'
import { describe,it,expect } from 'vitest'
import { committedChange } from '../../main/agent/tools/change-display'
import { safeToolDisplay } from '../../shared/tool-display'
describe('committed-byte UI projection',()=>{
 it('reconstructs an exact replacement for insertion, deletion, CRLF, Unicode and separated edits',()=>{
  const cases=[['a\n','\na\n'],['a\n','helloa\n'],['abc\ndef\n','abc\n'],['ab\r\ncd\r\n','ax\r\ncy\r\n'],['😀界\na\nb\n','😀界\nx\ny\n'],['','new'],['same','same']]
  let seed=7;const random=()=>{seed=(seed*16807)%2147483647;return seed},chars=['a','b','\n','\r','😀','界','\t']
  for(let n=0;n<120;n++){const a=Array.from({length:random()%30},()=>chars[random()%chars.length]).join('');const b=a.slice(0,random()%(a.length+1))+chars[random()%chars.length]+a.slice(random()%(a.length+1));cases.push([a,b])}
  for(const [a,b] of cases){const before=Buffer.from(a!),after=Buffer.from(b!),old=before.toString(),next=after.toString(),change=committedChange('src/a.ts',before,after,s=>s)
   expect(change.omitted).toBe(false);let start=0;for(let line=1;line<(change.line??1);line++)start=old.indexOf('\n',start)+1
   expect(old.slice(start,start+(change.removed??'').length)).toBe(change.removed)
   expect(old.slice(0,start)+change.added+old.slice(start+(change.removed??'').length)).toBe(next)
  }
 })
 it('redacts whole logical text before clipping and explicitly reports a missing/oversized original',()=>{
  const secret='0123456789_SECRET_VALUE_ABCDEFG',line='z'.repeat(1780)+'token='+secret+'\n'
  const change=committedChange('src/a.ts',Buffer.from(line),Buffer.from('changed\n'),s=>s.replace('token='+secret,'token=[REDACTED]'))
  expect(JSON.stringify(change)).not.toContain('0123456789');expect(change.removed).toContain('[REDACTED]')
  expect(committedChange('a.ts',undefined,Buffer.from('value'),s=>s)).toMatchObject({omitted:true,created:false})
  expect(committedChange('a.ts',null,Buffer.from('value'),s=>s)).toMatchObject({created:true,added:'value'})
 })
 it('rejects arbitrary display HTML objects, traversal, forged versions and over-budget aggregates',()=>{
  const file=committedChange('a.ts',null,Buffer.from('new'),s=>s)
  expect(safeToolDisplay({version:1,kind:'changes',files:[file]})).toBeTruthy()
  for(const path of ['../secret','C:/secret','/secret'])expect(safeToolDisplay({version:1,kind:'changes',files:[{...file,path}]})).toBeUndefined()
  expect(safeToolDisplay({version:1,kind:'changes',files:[{...file,after:'FAKE'}]})).toBeUndefined()
  expect(safeToolDisplay({version:1,kind:'changes',files:Array.from({length:8},()=>({...file,removed:'x'.repeat(1800),added:'y'.repeat(1800)}))})).toBeUndefined()
  expect(safeToolDisplay({version:1,kind:'html',html:'<script>alert(1)</script>'})).toBeUndefined()
 })
})
