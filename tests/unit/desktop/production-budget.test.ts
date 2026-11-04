import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProductionBudget } from '../../../main/desktop/production-budget'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/stages/orchestration-contracts'
import { leanBudget, withLeanRuntime } from '../../../main/desktop/lean-budget'
import { createProject } from '../../../main/project/project-service'
import { configureSoftwareExecutionLimits } from '../../../main/software/execution-limits'
import { MonetaryBudgetError } from '../../../main/platform/llm/monetary-budget'

beforeEach(() => vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-production-budget-'))))
afterEach(() => vi.unstubAllEnvs())
const options = (): SDKQueryOptions => ({ env: {}, signal: new AbortController().signal, sessionId: 's', maxTokens: 2048 })
async function drain(query: SDKQuery, opts = options()) { for await (const _message of query('', opts)) { /* consume */ } }
const ok: SDKQuery = async function* (_prompt, opts) {
  opts.requestGuard?.({ url: 'https://model.invalid', body: JSON.stringify({ max_tokens: opts.maxTokens }) })
  yield { type: 'result', subtype: 'success', usage: { output_tokens: 100 } }
}
const limits = { requests: 3, phaseRequests: 3, output: 8192, perResponse: 2048 }

describe('production admission is shared and durable', () => {
  it('does not consume output on a known monetary refusal before transport, but retains an uncertain physical attempt',async()=>{
    const budget=createProductionBudget('p','unsent','desktop-implement',limits)
    const blocked:SDKQuery=async function*(){throw new MonetaryBudgetError('MONETARY_BUDGET_EXHAUSTED')}
    await expect(drain(budget.wrap(blocked))).rejects.toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(budget.snapshot()).toMatchObject({requests:1,output:0})
    const unknown:SDKQuery=async function*(_prompt,opts){opts.onTransportAttempt?.('started');throw new MonetaryBudgetError('MONETARY_BUDGET_EXHAUSTED')}
    await expect(drain(budget.wrap(unknown))).rejects.toThrow()
    expect(budget.snapshot()).toMatchObject({requests:2,output:2048})
  })
  it('waits for a concurrent maximum reservation instead of repeatedly failing a new reviewer', async () => {
    const budget = createProductionBudget('p', 'shared-large', 'desktop-implement', { ...limits, perResponse: 8192 })
    let release!: () => void, childStarted = false
    const hold = new Promise<void>(done => { release = done })
    const parent = drain(budget.wrap(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }
      await hold; yield { type: 'result', subtype: 'success', usage: { output_tokens: 100 } }
    }), { ...options(), maxTokens: 8192 })
    await new Promise(done => setTimeout(done, 10))
    const child = drain(budget.wrap(async function* () { childStarted = true; yield { type:'result', subtype:'success', usage:{output_tokens:200} } }), { ...options(), maxTokens:8192, sessionId:'child' })
    await new Promise(done => setTimeout(done, 10)); expect(childStarted).toBe(false)
    expect(budget.snapshot().requests).toBe(1)
    release(); await Promise.all([parent,child])
    expect(childStarted).toBe(true); expect(budget.snapshot()).toMatchObject({ requests:2, output:300 })
  })
  it('keeps counters when an operator grants additional execution space within the same operation', async () => {
    const p=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'})
    await drain(leanBudget(p.project_id,'prepare').wrap(ok))
    configureSoftwareExecutionLimits(p.project_id,p.lean_operation_id??'initial',{requests:512,output:1048576,reason:'User-authorized continuation after a diagnosed admission defect; money policy unchanged'})
    expect(leanBudget(p.project_id,'desktop-implement').snapshot()).toMatchObject({requests:1,output:100,limits:{requests:512,output:1048576}})
    expect(()=>configureSoftwareExecutionLimits(p.project_id,'different',{requests:512,output:1048576,reason:'wrong operation'})).toThrow('OPERATION_CHANGED')
  })
  it('cancels a queued child without debiting it or releasing the active parent reservation',async()=>{
    const budget=createProductionBudget('p','cancel-wait','desktop-implement',{...limits,perResponse:8192})
    let release!:()=>void
    const hold=new Promise<void>(done=>{release=done})
    const parent=drain(budget.wrap(async function*(){await hold;yield{type:'result',subtype:'success',usage:{output_tokens:100}}}),{...options(),maxTokens:8192})
    const controller=new AbortController()
    const child=drain(budget.wrap(ok),{...options(),signal:controller.signal})
    const rejected=expect(child).rejects.toThrow()
    controller.abort();await rejected
    expect(budget.snapshot()).toMatchObject({requests:1,output:8192})
    release();await parent;expect(budget.snapshot()).toMatchObject({requests:1,output:100})
  })
  it('counts primary, child and restart against the same requirements budget', async () => {
    const parent = createProductionBudget('p', 'prd-v1', 'desktop-implement', limits)
    await drain(parent.wrap(ok)); await drain(parent.wrap(ok), { ...options(), sessionId: 'child' })
    const restarted = createProductionBudget('p', 'prd-v1', 'desktop-implement', limits)
    await drain(restarted.wrap(ok))
    await expect(drain(restarted.wrap(ok))).rejects.toThrow('HARNESS_REQUEST_BUDGET_EXHAUSTED')
    expect(restarted.snapshot()).toMatchObject({ requests: 3, output: 300 })
    await drain(createProductionBudget('p', 'prd-v2', 'desktop-implement', limits).wrap(ok))
  })
  it('counts physical retries and keeps unknown reservations', async () => {
    const budget = createProductionBudget('p', 'v', 'desktop-arch', limits)
    const retried: SDKQuery = async function* (_prompt, opts) {
      const request = { url: 'https://model.invalid', body: JSON.stringify({ max_tokens: opts.maxTokens }) }
      opts.requestGuard?.(request); opts.requestGuard?.(request)
      yield { type: 'result', subtype: 'success', usage: { output_tokens: 100 } }
    }
    await drain(budget.wrap(retried))
    expect(budget.snapshot()).toMatchObject({ requests: 2, output: 2148 })
  })
  it('bounds each response and total output, and refuses corrupt records', async () => {
    const budget = createProductionBudget('p', 'v', 'desktop-implement', { ...limits, output: 2048 })
    const unmeasured: SDKQuery = async function* (_prompt, opts) {
      expect(opts.maxTokens).toBe(2048)
      yield { type: 'result', subtype: 'success' }
    }
    await drain(budget.wrap(unmeasured), { ...options(), maxTokens: 640000 })
    await expect(drain(budget.wrap(ok))).rejects.toThrow('HARNESS_OUTPUT_BUDGET_EXHAUSTED')
    writeFileSync(budget.snapshot().file, 'broken')
    await expect(drain(budget.wrap(ok))).rejects.toThrow('HARNESS_BUDGET_UNREADABLE')
  })
  it('does not release cancelled reservations or charge an already cancelled invocation', async () => {
    const budget = createProductionBudget('p', 'v', 'desktop-implement', limits)
    const controller = new AbortController(); controller.abort()
    await expect(drain(budget.wrap(ok), { ...options(), signal: controller.signal })).rejects.toThrow()
    expect(budget.snapshot().requests).toBe(0)
  })
  it('retains a phase start across continuation and separates phases', () => {
    const a = createProductionBudget('p', 'v', 'desktop-arch', limits).phaseStartedAt()
    expect(createProductionBudget('p', 'v', 'desktop-arch', limits).phaseStartedAt()).toBe(a)
    expect(createProductionBudget('p', 'v', 'desktop-implement', limits).phaseStartedAt()).toBeGreaterThanOrEqual(a)
  })
  it('lean preparation, revision and execution share active runtime, including an interrupted interval', async () => {
    const p = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'lean-v1' })
    const prepare = leanBudget(p.project_id, 'prepare')
    prepare.recordRuntime(17)
    const execution = leanBudget(p.project_id, 'desktop-implement')
    expect(execution.snapshot().runtimeMs).toBe(17)
    const saved = execution.snapshot()
    writeFileSync(saved.file, JSON.stringify({ ...saved, runtimeStartedAt: Date.now() - 100 }))
    await withLeanRuntime(p.project_id, 'prepare', undefined, async () => {})
    expect(execution.snapshot().runtimeMs).toBeGreaterThanOrEqual(117)
    expect(execution.snapshot().runtimeStartedAt).toBeUndefined()
    const end = execution.snapshot()
    writeFileSync(end.file, JSON.stringify({ ...end, runtimeMs: 1800000 }))
    const work = vi.fn(async () => true)
    await expect(withLeanRuntime(p.project_id, 'desktop-implement', undefined, work)).rejects.toThrow('HARNESS_DEADLINE_EXCEEDED')
    expect(work).not.toHaveBeenCalled()
  })
})
