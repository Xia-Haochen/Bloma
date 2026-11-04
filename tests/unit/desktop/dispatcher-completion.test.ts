import { describe, expect, it, vi } from 'vitest'
import { guardDispatcherCompletion } from '../../../main/desktop/production-completion'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { DelegationRecord } from '../../../main/agent/delegation/agent-collaboration'

const ctx = (): ToolContext => ({ projectId: 'p', sessionId: 'parent', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
function record(): DelegationRecord {
  return { delegationId: 'd', parentSessionId: 'parent', childSessionId: 'c', projectId: 'p', role: 'implement', goal: 'work',
    status: 'running', abort: new AbortController(), startedAt: 0, completion: Promise.resolve(), resolveCompletion: () => {},
    askSignal: { promise: new Promise(() => {}), resolve: () => {} } }
}
describe('dispatcher end response with active work', () => {
  it('awaits the child without cancelling it or deciding advancement on behalf of the model', async () => {
    const child = record(), abort = vi.spyOn(child.abort, 'abort')
    const wait = vi.fn(async () => { child.status = 'completed'; child.loopStatus = 'completed'; return [] })
    const feedback = await guardDispatcherCompletion(ctx(), 1000, { list: () => [child], wait,
      summary: r => ({ delegation_id: r.delegationId, role: r.role, status: r.status, goal: r.goal, started_at: 0 }) })
    expect(wait).toHaveBeenCalledTimes(1); expect(abort).not.toHaveBeenCalled()
    expect(feedback).toContain('"status":"completed"')
    expect(feedback).toContain('请依据实际结果处理剩余工作')
    expect(feedback).not.toContain('推进标记')
    expect(await guardDispatcherCompletion(ctx(), 1000, { list: () => [child], wait, summary: () => { throw Error('not called') } })).toBeUndefined()
  })
  it('surfaces pending questions without busy waiting or inventing an answer', async () => {
    const child = record(); child.pendingQuestion = '请选择'
    const wait = vi.fn(async () => [])
    const feedback = await guardDispatcherCompletion(ctx(), 1000, { list: () => [child], wait,
      summary: r => ({ delegation_id: r.delegationId, role: r.role, status: r.status, goal: r.goal, started_at: 0, pending_question: r.pendingQuestion }) })
    expect(wait).not.toHaveBeenCalled(); expect(feedback).toContain('请选择')
  })
  it('consumes only completed host-accepted review handoffs, retaining other work and pending questions',async()=>{
    const child=record();child.role='review'
    const accepted=vi.fn((id:string,session:string)=>id==='d'&&session==='c')
    const summary=(r:DelegationRecord)=>({delegation_id:r.delegationId,role:r.role,status:r.status,goal:r.goal,started_at:0,pending_question:r.pendingQuestion})
    const wait=vi.fn(async()=>{child.status='completed';return[]})
    expect(await guardDispatcherCompletion(ctx(),1000,{list:()=>[child],wait,summary},accepted)).toBeUndefined()
    child.status='running';child.pendingQuestion='需要确认'
    expect(await guardDispatcherCompletion(ctx(),1000,{list:()=>[child],wait,summary},accepted)).toContain('需要确认')
    child.pendingQuestion=undefined;child.status='running'
    const other={...record(),delegationId:'other',childSessionId:'other-child'}
    const feedback=await guardDispatcherCompletion(ctx(),1000,{list:()=>[child,other],wait:async()=>{child.status='completed';other.status='completed';return[]},summary},accepted)
    expect(feedback).toContain('"delegation_id":"other"');expect(feedback).not.toContain('"delegation_id":"d"')
    child.status='running'
    const failed=await guardDispatcherCompletion(ctx(),1000,{list:()=>[child],wait:async()=>{child.status='failed';return[]},summary},accepted)
    expect(failed).toContain('"status":"failed"')
    child.status='running';other.status='failed'
    expect(await guardDispatcherCompletion(ctx(),1000,{list:()=>[child,other],wait,summary},accepted)).toBeUndefined()
  })
  it('propagates cancellation and reports an exhausted wait deadline', async () => {
    const child = record(), parent = ctx(), abort = new AbortController(); parent.signal = abort.signal
    const wait = vi.fn(async () => { abort.abort(); return [] })
    await expect(guardDispatcherCompletion(parent, 1000, { list: () => [child], wait, summary: () => { throw Error('not called') } })).rejects.toThrow()
    await expect(guardDispatcherCompletion(ctx(), 0, { list: () => [child], wait, summary: () => { throw Error('not called') } })).rejects.toThrow('DISPATCHER_CHILD_COMPLETION_TIMEOUT')
  })
})
