import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it,vi} from 'vitest'
import {remainingSoftwareRequests,SOFTWARE_EXECUTION_REQUEST_CAPACITY} from '../../main/software/execution-limits'
import {createRequestBudget} from '../../main/platform/llm/request-budget'

it('continues after 512 recorded requests using shared capacity, while the original money guard still stops overspend',async()=>{
  const home=mkdtempSync(join(tmpdir(),'bloma-trial-window-'))
  try{
    const path=join(home,'policy.json')
    writeFileSync(path,JSON.stringify({version:1,models:[{host:'test.invalid',model:'test',cap_rmb:.0002,context_tokens:100,input_rmb_per_million:0,output_rmb_per_million:1,cache_rmb_per_million:0}]}))
    vi.stubEnv('BLOMA_MONETARY_POLICY',path);vi.stubEnv('BLOMA_DISPATCH_EXPERIMENT','0')
    const carried=512,remaining=remainingSoftwareRequests(carried)
    expect(remaining).toBe(SOFTWARE_EXECUTION_REQUEST_CAPACITY-carried)
    const budget=createRequestBudget({}, {requests:remaining,outputTokens:100,rmb:.0002})
    const query=budget.wrap(async function*(_prompt,options){
      options.requestGuard!({url:'https://test.invalid/messages',body:JSON.stringify({model:'test',max_tokens:100,messages:[]})})
      options.onTransportAttempt?.('started')
      yield {type:'result' as const,subtype:'success',usage:{input_tokens:0,output_tokens:100}}
    })
    const run=async()=>{for await(const _ of query('',{env:{},sessionId:'s',maxTokens:100,signal:new AbortController().signal})) {}}
    await run();await run();await expect(run()).rejects.toThrow('MONETARY_OPERATION_EXHAUSTED')
    expect(carried+budget.snapshot().physical_requests).toBe(514)
    expect(budget.snapshot().upper_rmb).toBe(.0002)
    expect(remainingSoftwareRequests(SOFTWARE_EXECUTION_REQUEST_CAPACITY)).toBe(0)
    expect(()=>remainingSoftwareRequests(-1)).toThrow('COUNT_INVALID')
  }finally{vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true})}
})
