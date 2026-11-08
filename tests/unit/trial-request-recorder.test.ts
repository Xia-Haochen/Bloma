import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {createTrialRequestRecorder,serializeTrialRecord} from '../../scripts/trial-request-recorder'
import {redactSoftwareOutput} from '../../main/software/process-manager'
it('redacts nested command text without breaking the enclosing JSON',()=>{
  const input={trigger:JSON.stringify({result:{text:'COMMAND_REQUIRES_SEPARATE_AUTHORIZATION: refused'}}),message:'password="synthetic-secret"\ncookie: session=synthetic-cookie\nnext line',path:'C:\\test\\file'}
  const raw=serializeTrialRecord(input,redactSoftwareOutput)
  const parsed=JSON.parse(raw)
  expect(parsed.path).toBe(input.path)
  expect(parsed.trigger).toContain('[REDACTED]')
  expect(raw).not.toContain('synthetic-secret');expect(raw).not.toContain('synthetic-cookie')
  expect(parsed.message).toContain('next line')
})
it('retains unreadable old records and continues numbering with an explicit evidence gap',async()=>{
  const root=mkdtempSync(join(tmpdir(),'trial-trace-damaged-'))
  try{
    mkdirSync(join(root,'requests'))
    const damaged='{"trigger":"damaged [REDACTED]",\\"nested":true}'
    writeFileSync(join(root,'requests/00007.json'),damaged)
    const recorder=createTrialRequestRecorder(root,JSON.stringify,()=>({}))
    const run=recorder.wrap(async function*(){yield{type:'result',subtype:'success'}},'interact')
    for await(const _ of run('resume',{env:{},sessionId:'s',signal:new AbortController().signal})){}
    expect(readFileSync(join(root,'requests/00007.json'),'utf8')).toBe(damaged)
    expect(JSON.parse(readFileSync(join(root,'requests/00008.json'),'utf8')).sequence).toBe(8)
    expect(readFileSync(join(root,'timeline.md'),'utf8')).toContain('unreadable_record')
  }finally{rmSync(root,{recursive:true,force:true})}
})
it('records actual sends, associates tool IDs and excludes credentials and hidden reasoning',async()=>{
  const root=mkdtempSync(join(tmpdir(),'trial-trace-'))
  try{
    const recorder=createTrialRequestRecorder(root,v=>JSON.stringify(v).replaceAll('SECRET','[redacted]'),()=>({current_stage:'building'}),{input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:.04})
    const run=recorder.wrap(async function*(_p,o){o.requestGuard?.({url:'https://example.invalid',body:'{"model":"test","max_tokens":100}'});o.onTransportAttempt?.('started');yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'owned',name:'read_file',input:{path:'x'}}]}};yield{type:'result',subtype:'success',usage:{input_tokens:5,output_tokens:2}}},'run')
    for await(const _ of run('SECRET',{env:{},sessionId:'s',signal:new AbortController().signal,messages:[{role:'assistant',content:[{type:'thinking',thinking:'DO_NOT_LOG'} as never]}]})){}
    recorder.event('tool_call_completed',{tool_call_id:'owned',status:'ok'})
    recorder.event('thinking_delta',{text:'DO_NOT_LOG'})
    const raw=readFileSync(join(root,'requests/00001.json'),'utf8'),row=JSON.parse(raw)
    expect(raw).not.toContain('SECRET');expect(readFileSync(join(root,'requests/00001-input.json'),'utf8')).not.toContain('DO_NOT_LOG')
    expect(readFileSync(join(root,'timeline.md'),'utf8')).not.toContain('SECRET')
    expect(readFileSync(join(root,'events.jsonl'),'utf8')).not.toContain('DO_NOT_LOG')
    expect(row.transports.filter((r:any)=>r.state==='started')).toHaveLength(1);expect(row.tool_events).toHaveLength(1);expect(row.reported_price_micro_rmb).toBe(26)
  }finally{rmSync(root,{recursive:true,force:true})}
})
