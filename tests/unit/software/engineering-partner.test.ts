import { beforeEach, expect, it, vi } from 'vitest'
const h=vi.hoisted(()=>({start:vi.fn(),resume:vi.fn(),record:{status:'running',resultSummary:'independent evidence'}}))
vi.mock('../../../main/agent/delegation/agent-collaboration',()=>({
  startDelegation:h.start,continueDelegation:h.resume,findDelegation:()=>h.record,getDelegationSummary:()=>({status:h.record.status,result_summary:h.record.resultSummary}),
}))
import { createEngineeringPartner } from '../../../main/software/engineering-partner'
const ctx=()=>({sessionId:'parent',signal:new AbortController().signal}) as any
beforeEach(()=>{vi.clearAllMocks();h.record.status='running';h.start.mockReturnValue({delegation_id:'peer'});h.resume.mockImplementation(()=>{h.record.status='running';return{delegation_id:'peer'}})})
it('coalesces new failures, delivers advice once, and consults unchanged closeout only once',()=>{
  let version='v1';const peer=createEngineeringPartner(true,()=>version),context=ctx()
  peer.begin(context);expect(h.start).toHaveBeenCalledTimes(1)
  const failures=[{name:'verify_app',turn:1,status:'error' as const,failureKey:'observed-failure'}]
  peer.observe(context,failures);peer.observe(context,failures);expect(h.resume).not.toHaveBeenCalled()
  h.record.status='completed';expect(peer.take(context)).toContain('非用户新需求');expect(peer.take(context)).toBeUndefined()
  peer.observe(context,[]);expect(h.resume).toHaveBeenCalledTimes(1)
  h.record.status='completed';peer.take(context);peer.observe(context,failures);expect(h.resume).toHaveBeenCalledTimes(1)
  peer.closeout(context);expect(h.resume).toHaveBeenCalledTimes(2)
  h.record.status='completed';peer.take(context);peer.closeout(context);expect(h.resume).toHaveBeenCalledTimes(2)
  version='v2';peer.closeout(context);expect(h.resume).toHaveBeenCalledTimes(3)
})
it('does not introduce calls when disabled or turn consultation startup failure into product failure',()=>{
  const context=ctx(),off=createEngineeringPartner(false)
  off.begin(context);off.closeout(context);off.observe(context,[]);expect(h.start).not.toHaveBeenCalled()
  h.start.mockImplementation(()=>{throw Error('consultation unavailable')})
  const peer=createEngineeringPartner(true);expect(()=>peer.begin(context)).not.toThrow()
  expect(peer.take(context)).toContain('未启动');expect(peer.take(context)).toBeUndefined()
})

it('routes new development observations for agent judgment even when the tool itself returned successfully',()=>{
  let observation='one';const peer=createEngineeringPartner(true,()=> 'version',()=>observation),context=ctx()
  peer.begin(context);h.record.status='completed';peer.take(context)
  const calls=[{name:'inspect_app',turn:1,status:'ok' as const}]
  peer.observe(context,calls);expect(h.resume).toHaveBeenCalledTimes(1)
  h.record.status='completed';peer.take(context);peer.observe(context,calls);expect(h.resume).toHaveBeenCalledTimes(1)
  observation='two';peer.observe(context,calls);expect(h.resume).toHaveBeenCalledTimes(2)
})
it('does not repeatedly block closeout when material collection is unavailable',()=>{
  const peer=createEngineeringPartner(true,()=>{throw Error('source too large')}),context=ctx()
  peer.begin(context);h.record.status='completed';peer.take(context)
  peer.closeout(context);expect(peer.take(context)).toContain('未启动')
  peer.closeout(context);expect(peer.take(context)).toBeUndefined()
})
