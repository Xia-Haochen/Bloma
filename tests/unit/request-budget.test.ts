import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequestBudget } from '../../main/platform/llm/request-budget'
import {trialOutputCap} from '../../scripts/trial-output-cap'
import { streamSSE, setSseRetryWaitBudgetForTests } from '../../main/platform/upstream/providers/sse-reader'
import { ANTHROPIC_SSE_ADAPTER } from '../../main/platform/upstream/providers/anthropic-sse-adapter'
import { MonetaryBudgetError, readMonetaryBudget } from '../../main/platform/llm/monetary-budget'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'

describe('operation request budget', () => {
  const oldPolicy = process.env.BLOMA_MONETARY_POLICY, oldEpoch = process.env.BLOMA_MONETARY_EPOCH_DIR
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bloma-operation-budget-'))
    process.env.BLOMA_MONETARY_EPOCH_DIR = join(dir, 'epochs')
    process.env.BLOMA_MONETARY_POLICY = join(dir, 'policy.json')
    writeFileSync(process.env.BLOMA_MONETARY_POLICY, JSON.stringify({ version: 1, models: [{ host: 'test.invalid', model: 'test', cap_rmb: 5,
      context_tokens: 10000, input_rmb_per_million: 2, output_rmb_per_million: 8, cache_rmb_per_million: .04 }] }))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    if (oldPolicy === undefined) delete process.env.BLOMA_MONETARY_POLICY; else process.env.BLOMA_MONETARY_POLICY = oldPolicy
    if (oldEpoch === undefined) delete process.env.BLOMA_MONETARY_EPOCH_DIR; else process.env.BLOMA_MONETARY_EPOCH_DIR = oldEpoch
    setSseRetryWaitBudgetForTests(); rmSync(dir, { recursive: true, force: true })
  })
  const options = (): SDKQueryOptions => ({ env: {}, sessionId: 'budget', signal: new AbortController().signal, maxTokens: 100 })
  const drain = async (query: SDKQuery) => { for await (const _ of query('test', options())) {} }
  const request = { url: 'https://test.invalid/messages', headers: {}, body: JSON.stringify({ model: 'test', max_tokens: 100, messages: [] }) }
  it('settles both monetary reservations on a verified DeepSeek balance rejection', async () => {
    const policy = process.env.BLOMA_MONETARY_POLICY!
    writeFileSync(policy, JSON.stringify({version:1,models:[{host:'api.deepseek.com',model:'test',cap_rmb:5,
      context_tokens:10000,input_rmb_per_million:2,output_rmb_per_million:8,cache_rmb_per_million:.04}]}))
    const budget = createRequestBudget({}, {requests:3,outputTokens:100,rmb:5})
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{type:'insufficient_balance_error',message:'Insufficient Balance'}}), {status:402}))
    const query: SDKQuery = async function* (_prompt, opts) {
      await streamSSE({
        request:{...request,url:'https://api.deepseek.com/v1/messages'}, adapter:ANTHROPIC_SSE_ADAPTER, onEvent:()=>{},
        requestGuard:opts.requestGuard, onAttempt:opts.onTransportAttempt, monetaryPolicyPath:opts.monetaryPolicyPath, fetchFn,
      })
    }
    await expect(drain(budget.wrap(query))).rejects.toMatchObject({status:402,generationRejected:true})
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.snapshot()).toMatchObject({physical_requests:1,upper_rmb:0,unreported_requests:0})
    expect(readMonetaryBudget(policy)[0]).toMatchObject({accounted_upper_rmb:0,remaining_rmb:5})
  })
  it('fits a later request to the remaining operation allowance without releasing previous charges or the full image input reserve',async()=>{
    const rate={context_tokens:10000,input_rmb_per_million:2,output_rmb_per_million:8}
    const budget=createRequestBudget({}, {requests:3,outputTokens:10000,rmb:.1})
    const first:SDKQuery=async function*(_p,opt){opt.requestGuard!({...request,body:JSON.stringify({model:'test',max_tokens:10000,messages:[]})});yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:5000}}}
    await drain(budget.wrap(first))
    const spent=budget.snapshot().upper_rmb!
    expect(spent).toBe(.04002)
    const cap=trialOutputCap(.1-spent,10000,rate)
    let sent=false
    const second:SDKQuery=async function*(_p,opt){opt.requestGuard!({...request,body:JSON.stringify({model:'test',max_tokens:opt.maxTokens,messages:[{type:'image'}]})});sent=true;yield{type:'result',subtype:'success',usage:{input_tokens:10000,output_tokens:10}}}
    for await(const _ of budget.wrap(second)('test',{...options(),maxTokens:cap})){}
    expect(sent).toBe(true);expect(cap).toBeLessThan(10000)
    expect(Math.ceil(rate.context_tokens*rate.input_rmb_per_million)+Math.ceil(cap*rate.output_rmb_per_million)).toBeLessThanOrEqual(Math.floor((.1-spent)*1e6))
    expect(budget.snapshot().upper_rmb).toBeGreaterThan(spent);expect(budget.snapshot().upper_rmb).toBeLessThanOrEqual(.1)
  })
  it('admits an exact micro-RMB boundary after many receipts and rejects the next micro-RMB',async()=>{
    writeFileSync(process.env.BLOMA_MONETARY_POLICY!,JSON.stringify({version:1,models:[{host:'test.invalid',model:'test',cap_rmb:5,context_tokens:100,input_rmb_per_million:0,output_rmb_per_million:1,cache_rmb_per_million:0}]}))
    const budget=createRequestBudget({}, {requests:20,outputTokens:100,rmb:.00001})
    const one:SDKQuery=async function*(_p,opt){opt.requestGuard!({...request,body:JSON.stringify({model:'test',max_tokens:1,messages:[]})});yield{type:'result',subtype:'success',usage:{input_tokens:0,output_tokens:1}}}
    for(let n=0;n<10;n++)await drain(budget.wrap(one))
    expect(budget.snapshot().upper_rmb).toBe(.00001)
    await expect(drain(budget.wrap(one))).rejects.toThrow('MONETARY_OPERATION_EXHAUSTED')
  })
  it('preserves the typed pre-transport refusal through the SSE guard wrapper',async()=>{
    const fetchFn=vi.fn()
    await expect(streamSSE({request,adapter:ANTHROPIC_SSE_ADAPTER,onEvent:()=>{},fetchFn,requestGuard:()=>{throw new MonetaryBudgetError('MONETARY_OPERATION_EXHAUSTED')}})).rejects.toBeInstanceOf(MonetaryBudgetError)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('explicitly uncapped experiments skip shared and operation RMB policies but retain request admission', async () => {
    vi.stubEnv('BLOMA_DISPATCH_EXPERIMENT', '1')
    vi.stubEnv('BLOMA_EXPERIMENT_UNLIMITED_MONETARY', '1')
    const budget = createRequestBudget({ ANTHROPIC_BASE_URL: 'https://test.invalid', ANTHROPIC_MODEL: 'test' }, { requests: 1, outputTokens: 100, rmb: .000001 })
    const query: SDKQuery = async function* (_prompt, opt) {
      expect(opt.monetaryPolicyPath).toBe('')
      opt.requestGuard!(request)
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
    }
    await drain(budget.wrap(query))
    expect(budget.snapshot().monetary_control).toBe('uncapped_experiment')
    await expect(drain(budget.wrap(query))).rejects.toThrow('REQUEST_BUDGET_EXHAUSTED')
  })
  it('the unlimited flag cannot disable an ordinary operation outside experiment mode', async () => {
    vi.stubEnv('BLOMA_DISPATCH_EXPERIMENT', '0')
    vi.stubEnv('BLOMA_EXPERIMENT_UNLIMITED_MONETARY', '1')
    const budget = createRequestBudget({}, { requests: 1, outputTokens: 100, rmb: .000001 })
    const query: SDKQuery = async function* (_prompt, opt) { opt.requestGuard!(request); yield { type: 'result', subtype: 'success' } }
    await expect(drain(budget.wrap(query))).rejects.toThrow('MONETARY_OPERATION_EXHAUSTED')
  })
  it('admits the actual provider output ceiling of an experiment instead of rejecting a legacy auxiliary cap', async () => {
    vi.stubEnv('BLOMA_DISPATCH_EXPERIMENT', '1')
    vi.stubEnv('BLOMA_EXPERIMENT_UNLIMITED_MONETARY', '1')
    vi.stubEnv('BLOMA_EXPERIMENT_MAX_OUTPUT_TOKENS', '640000')
    const budget = createRequestBudget({}, { requests: 1, outputTokens: 16384, rmb: 5 })
    const query: SDKQuery = async function* (_prompt, opt) {
      opt.requestGuard!({ ...request, body: JSON.stringify({ model: 'test', max_tokens: 393216, messages: [] }) })
      yield { type: 'result', subtype: 'success' }
    }
    await drain(budget.wrap(query))
    expect(budget.snapshot().max_output_tokens).toBe(640000)
  })

  it('claims every SSE retry before fetch, and does not swallow the admission error', async () => {
    const budget = createRequestBudget({}, { requests: 1, outputTokens: 100, rmb: 5 })
    const fetchFn = vi.fn().mockResolvedValue(new Response('server failed', { status: 500 }))
    const query: SDKQuery = async function* (_prompt, opt) {
      await streamSSE({ request, adapter: ANTHROPIC_SSE_ADAPTER, onEvent: () => {}, fetchFn,
        requestGuard: opt.requestGuard, monetaryPolicyPath: opt.monetaryPolicyPath, onAttempt: opt.onTransportAttempt })
      yield { type: 'result', subtype: 'success' }
    }
    setSseRetryWaitBudgetForTests(1)
    await expect(drain(budget.wrap(query))).rejects.toThrow('REQUEST_BUDGET_EXHAUSTED')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(budget.snapshot().physical_requests).toBe(1)
  })
  it('reserves a full context for images; refuses a monetary overflow before transmission', async () => {
    const budget = createRequestBudget({}, { requests: 8, outputTokens: 100, rmb: .001 })
    const sent = vi.fn()
    const query: SDKQuery = async function* (_prompt, opt) {
      opt.requestGuard!({ ...request, body: JSON.stringify({ model: 'test', max_tokens: 100, messages: [{ content: [{ type: 'image', source: {} }] }] }) })
      sent(); yield { type: 'result', subtype: 'success' }
    }
    await expect(drain(budget.wrap(query))).rejects.toThrow('MONETARY_OPERATION_EXHAUSTED')
    expect(sent).not.toHaveBeenCalled()
  })
  it('settles reported usage, keeps failed-attempt reservations, and respects the output cap', async () => {
    const budget = createRequestBudget({}, { requests: 3, outputTokens: 100, rmb: 5 })
    const query: SDKQuery = async function* (_prompt, opt) {
      expect(opt.maxTokens).toBe(100)
      opt.requestGuard!(request); opt.onTransportAttempt?.('started')
      opt.requestGuard!(request); opt.onTransportAttempt?.('started')
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
    }
    await drain(budget.wrap(query))
    expect(budget.snapshot()).toMatchObject({ physical_requests: 2, monetary_control: 'verified_policy', unreported_requests: 1 })
    expect(budget.snapshot().upper_rmb).toBeGreaterThan(.0001)
  })
  it('an admitted request that never reaches transport is not reported as a physical API call', async () => {
    const budget = createRequestBudget({}, { requests: 2, outputTokens: 100, rmb: 5 })
    const query: SDKQuery = async function* (_prompt, opt) { opt.requestGuard!(request); throw new Error('shared policy rejected before HTTP') }
    await expect(drain(budget.wrap(query))).rejects.toThrow('shared policy rejected')
    expect(budget.snapshot()).toMatchObject({ admitted_requests: 1, physical_requests: 0, unreported_requests: 1 })
  })
  it('releases a typed shared admission refusal before transport without resetting attempt counts',async()=>{
    const budget=createRequestBudget({}, {requests:3,outputTokens:100,rmb:5})
    const denied:SDKQuery=async function*(_prompt,opt){opt.requestGuard!(request);throw new MonetaryBudgetError('MONETARY_BUDGET_EXHAUSTED')}
    await expect(drain(budget.wrap(denied))).rejects.toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(budget.snapshot()).toMatchObject({logical_queries:1,prepared_requests:1,admitted_requests:0,physical_requests:0,unsent_requests:1,unreported_requests:0,upper_rmb:0})
    const sent:SDKQuery=async function*(_prompt,opt){opt.requestGuard!(request);opt.onTransportAttempt?.('started');throw new MonetaryBudgetError('MONETARY_BUDGET_EXHAUSTED')}
    await expect(drain(budget.wrap(sent))).rejects.toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(budget.snapshot()).toMatchObject({logical_queries:2,prepared_requests:2,admitted_requests:1,physical_requests:1,unsent_requests:1,unreported_requests:1})
    expect(budget.snapshot().upper_rmb).toBeGreaterThan(0)
  })
})
