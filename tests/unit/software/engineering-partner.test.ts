import { beforeEach, expect, it, vi } from 'vitest'
const h=vi.hoisted(()=>({start:vi.fn(),resume:vi.fn(),record:{status:'running',resultSummary:'independent evidence',loopStatus:undefined as string|undefined}}))
vi.mock('../../../main/agent/delegation/agent-collaboration',()=>({
  startDelegation:h.start,continueDelegation:h.resume,findDelegation:()=>h.record,getDelegationSummary:()=>({status:h.record.status,result_summary:h.record.resultSummary}),
}))
import { createEngineeringPartner } from '../../../main/software/engineering-partner'
const ctx=()=>({sessionId:'parent',signal:new AbortController().signal}) as any
beforeEach(()=>{vi.clearAllMocks();h.record.status='running';h.record.loopStatus=undefined;h.start.mockReturnValue({delegation_id:'peer',child_session_id:'child'});h.resume.mockImplementation(()=>{h.record.status='running';return{delegation_id:'peer',child_session_id:'child'}})})
it('starts once and delivers once; further investigation belongs to the existing maker delegation tools',()=>{
  const peer=createEngineeringPartner(true),context=ctx()
  peer.begin(context);peer.begin(context);expect(h.start).toHaveBeenCalledTimes(1)
  h.record.status='completed';expect(peer.take(context)).toContain('非用户新需求');expect(peer.take(context)).toBeUndefined()
  peer.begin(context);expect(h.start).toHaveBeenCalledTimes(1);expect(h.resume).not.toHaveBeenCalled()
})
it('does not introduce calls when disabled or turn consultation startup failure into product failure',()=>{
  const context=ctx(),off=createEngineeringPartner(false)
  off.begin(context);expect(h.start).not.toHaveBeenCalled()
  h.start.mockImplementation(()=>{throw Error('consultation unavailable')})
  const peer=createEngineeringPartner(true);expect(()=>peer.begin(context)).not.toThrow()
  expect(peer.take(context)).toContain('不可用');expect(peer.take(context)).toBeUndefined()
})

it('does not start an investigation when only handoffs are collected',()=>{
  const peer=createEngineeringPartner(true),context=ctx()
  expect(peer.take(context)).toBeUndefined();expect(peer.latest()).toBeUndefined()
  expect(h.start).not.toHaveBeenCalled()
})
it('hands back public findings while work is still running and keeps them out of task authority',()=>{
  const peer=createEngineeringPartner(true),context=ctx();peer.begin(context);peer.begin(context)
  expect(h.start).toHaveBeenCalledTimes(1)
  peer.receive('foreign',{turn:1,text:'foreign',truncated:false});expect(peer.latest()).toBeUndefined()
  peer.receive('child',{turn:1,text:'The desktop path needs one launch probe.',truncated:false},()=>({source_changed:true}))
  expect(peer.latest()).toMatchObject({verification:'not_issued',updates:[{text:'The desktop path needs one launch probe.',workspace_facts:{source_changed:true}}]})
  expect(peer.take(context)).toContain('阶段交接');expect(peer.latest()).toBeUndefined();expect(peer.take(context)).toBeUndefined()
  h.record.status='completed';h.record.loopStatus='turn_limit'
  expect(peer.take(context)).toBeUndefined()
})

it('routes explicitly delegated independent workspace messages even when automatic partnership is disabled',()=>{
  const peer=createEngineeringPartner(false,child=>child==='manual'),context=ctx()
  peer.begin(context);expect(h.start).not.toHaveBeenCalled()
  peer.receive('foreign',{turn:1,text:'ignore',truncated:false});expect(peer.latest()).toBeUndefined()
  peer.receive('manual',{turn:1,text:'A bounded independent observation.',truncated:false})
  expect(peer.latest()?.updates[0]).toMatchObject({session_id:'manual',text:'A bounded independent observation.'})
  expect(peer.take(context)).toContain('阶段交接');expect(peer.latest()).toBeUndefined()
})
