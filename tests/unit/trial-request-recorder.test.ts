import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {createTrialRequestRecorder} from '../../scripts/trial-request-recorder'
it('records actual sends, associates tool IDs and excludes credentials and hidden reasoning',async()=>{
  const root=mkdtempSync(join(tmpdir(),'trial-trace-'))
  try{
    const recorder=createTrialRequestRecorder(root,v=>JSON.stringify(v).replaceAll('SECRET','[redacted]'),()=>({current_stage:'building'}),{input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:.04})
    const run=recorder.wrap(async function*(_p,o){o.requestGuard?.({url:'https://example.invalid',body:'{"model":"test","max_tokens":100}'});o.onTransportAttempt?.('started');yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'owned',name:'read_file',input:{path:'x'}}]}};yield{type:'result',subtype:'success',usage:{input_tokens:5,output_tokens:2}}},'run')
    for await(const _ of run('SECRET',{env:{},sessionId:'s',signal:new AbortController().signal,messages:[{role:'assistant',content:[{type:'thinking',thinking:'DO_NOT_LOG'} as never]}]})){}
    recorder.event('tool_call_completed',{tool_call_id:'owned',status:'ok'})
    const raw=readFileSync(join(root,'requests/00001.json'),'utf8'),row=JSON.parse(raw)
    expect(raw).not.toContain('SECRET');expect(readFileSync(join(root,'requests/00001-input.json'),'utf8')).not.toContain('DO_NOT_LOG')
    expect(row.transports.filter((r:any)=>r.state==='started')).toHaveLength(1);expect(row.tool_events).toHaveLength(1);expect(row.reported_price_micro_rmb).toBe(26)
  }finally{rmSync(root,{recursive:true,force:true})}
})
