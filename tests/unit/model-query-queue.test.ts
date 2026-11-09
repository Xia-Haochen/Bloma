import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeModelQueries } from '../../main/agent/loop/query-queue'
import { createRequestBudget } from '../../main/platform/llm/request-budget'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'

const options = (signal = new AbortController().signal): SDKQueryOptions => ({env:{},sessionId:'queue',signal,maxTokens:100})
const drain = async (query:SDKQuery, prompt:string, opt=options()) => {for await(const _ of query(prompt,opt)) {}}
const latch = () => {let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
afterEach(()=>vi.unstubAllEnvs())

it('keeps FIFO ownership through cancelled waiters and refreshes facts at dispatch',async()=>{
  const entered=latch(),release=latch(),calls:string[]=[],facts:unknown[]=[]
  let remaining=10
  const raw:SDKQuery=async function*(prompt,opt){calls.push(prompt);facts.push(opt.messages);if(prompt==='first'){entered.resolve();await release.promise}yield {type:'result',subtype:'success'}}
  const query=serializeModelQueries(raw), first=drain(query,'first')
  await entered.promise
  const cancelled=new AbortController()
  const second=drain(query,'cancelled',options(cancelled.signal)).catch(e=>e)
  const third=drain(query,'third',{...options(),refreshMessages:()=>[{role:'user',content:String(remaining)}]})
  cancelled.abort();expect(await second).toBeInstanceOf(Error)
  await Promise.resolve();expect(calls).toEqual(['first'])
  remaining=7;release.resolve();await Promise.all([first,third])
  expect(calls).toEqual(['first','third']);expect(facts[1]).toEqual([{role:'user',content:'7'}])
})

it('releases a failed query without losing the next request',async()=>{
  const query=serializeModelQueries(async function*(prompt){if(prompt==='bad')throw Error('provider');yield {type:'result',subtype:'success'}})
  const failed=drain(query,'bad').catch(e=>e),next=drain(query,'next')
  expect(await failed).toMatchObject({message:'provider'});await next
})

it('settles shared full-image reservations before admitting the next role',async()=>{
  const root=mkdtempSync(join(tmpdir(),'bloma-query-queue-'))
  try{
    const path=join(root,'policy.json')
    writeFileSync(path,JSON.stringify({version:1,models:[{host:'test.invalid',model:'test',cap_rmb:3,context_tokens:1000000,input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:0}]}))
    vi.stubEnv('BLOMA_MONETARY_POLICY',path);vi.stubEnv('BLOMA_DISPATCH_EXPERIMENT','0')
    const budget=createRequestBudget({}, {requests:4,outputTokens:100,rmb:3})
    const started=latch(),release=latch();let count=0
    const raw:SDKQuery=async function*(_prompt,opt){
      opt.requestGuard!({url:'https://test.invalid/messages',body:JSON.stringify({model:'test',max_tokens:100,messages:[{content:[{type:'image',source:{}}]}]})})
      opt.onTransportAttempt?.('started');count++
      if(count===1){started.resolve();await release.promise}
      yield {type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
    }
    const query=serializeModelQueries(budget.wrap(raw)),first=drain(query,'maker')
    await started.promise;const second=drain(query,'peer');await Promise.resolve()
    expect(count).toBe(1);expect(budget.snapshot().upper_rmb).toBeGreaterThan(2)
    release.resolve();await Promise.all([first,second])
    expect(count).toBe(2);expect(budget.snapshot()).toMatchObject({physical_requests:2,unreported_requests:0,upper_rmb:0.0002})
  }finally{rmSync(root,{recursive:true,force:true})}
})

it('prioritizes waiting maker and necessary review requests without stealing the active reservation',async()=>{
 const entered=latch(),release=latch(),calls:string[]=[]
 const query=serializeModelQueries(async function*(prompt){calls.push(prompt);if(prompt==='active'){entered.resolve();await release.promise}yield{type:'result',subtype:'success'}},o=>o.sessionId==='maker'?0:1)
 const active=drain(query,'active');await entered.promise
 const peer=drain(query,'peer'),maker=drain(query,'maker',{...options(),sessionId:'maker'})
 expect(calls).toEqual(['active']);release.resolve();await Promise.all([active,peer,maker]);expect(calls).toEqual(['active','maker','peer'])
})
