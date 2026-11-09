import {beforeEach,expect,it,vi} from 'vitest'
const h=vi.hoisted(()=>({start:vi.fn(),resume:vi.fn(),record:{status:'running',loopStatus:undefined as string|undefined,taskHandoff:undefined as {stop_reason?:string}|undefined,pendingQuestion:undefined as string|undefined,completion:undefined as Promise<void>|undefined}}))
vi.mock('../../../main/agent/delegation/agent-collaboration',()=>({startDelegation:h.start,continueDelegation:h.resume,findDelegation:()=>h.record}))
import {createEngineeringPartner} from '../../../main/software/engineering-partner'
const ctx=()=>({projectId:'project',sessionId:'parent',requestId:'run',signal:new AbortController().signal}) as any
const event=(id:string,name='inspect_app',output='seed=100027; actual room=normal')=>({phase:'completed' as const,turn:1,id,name,input:{seed:777001},output,isError:false})
beforeEach(()=>{vi.clearAllMocks();Object.assign(h.record,{status:'running',loopStatus:undefined,taskHandoff:undefined,pendingQuestion:undefined,completion:undefined});h.start.mockReturnValue({delegation_id:'peer',child_session_id:'child'});h.resume.mockImplementation(()=>{h.record.status='running';h.record.completion=undefined;return{delegation_id:'peer',child_session_id:'child'}})})

it('updates a running Agent with public claims and actual results without spawning another agent',async()=>{
  const peer=createEngineeringPartner(true,undefined,{source:()=> 'source-v2',facts:()=>({current_blocker:'execution evidence'})})
  peer.begin(ctx());peer.context('child');peer.observed('child',{turn:1,toolCalls:[]})
  peer.observeStatement({turn:2,text:'这次输入与正式测试相同。'});peer.observeTool(event('probe'))
  expect(h.start).toHaveBeenCalledTimes(1);expect(h.resume).not.toHaveBeenCalled()
  expect(await peer.beforeComplete('child')()).toContain('100027')
  const facts=peer.context('child')!
  expect(JSON.stringify(facts)).toContain('777001');expect(JSON.stringify(facts)).toContain('这次输入')
  expect(facts.observations.at(-1)?.source).toBe('source-v2')
  expect(peer.context('quality-child')).toBeUndefined()
  peer.observed('child',{turn:2,toolCalls:[]});h.record.status='completed'
  expect(peer.take(ctx())).toBeUndefined()
})

it('resumes the same Agent only for new meaningful evidence and never polls while idle',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx());peer.context('child');peer.observed('child',{turn:1,toolCalls:[]});h.record.status='completed'
  peer.take(ctx());peer.begin(ctx());expect(h.resume).not.toHaveBeenCalled()
  peer.observeStatement({turn:2,text:'收到建议，准备交给宿主。'});expect(h.resume).not.toHaveBeenCalled()
  peer.observeTool(event('read','read_file','source text'));expect(h.resume).toHaveBeenCalledTimes(1)
  peer.observeTool(event('probe'));expect(h.resume).toHaveBeenCalledTimes(1)
  expect(h.resume.mock.calls[0][1]).toBe('peer');expect(JSON.stringify(peer.context('child'))).toContain('actual room=normal')
  expect(h.start).toHaveBeenCalledTimes(1)
})
it('sees an actionable public plan before execution, and sees direct user steering as distinct from producer claims',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx());peer.context('child');peer.observed('child',{turn:1,toolCalls:[]});h.record.status='completed'
  peer.observeStatement({turn:2,text:'将修改冻结输入。'})
  peer.observeTool({phase:'started',turn:2,id:'write',name:'edit_file',input:{path:'test.mjs'}});expect(h.resume).not.toHaveBeenCalled()
  expect(peer.context('child')!.observations.at(-1)?.data).toMatchObject({phase:'started'})
  peer.observeUserRequest({turn:2,text:'只排查，不要改数据。'})
  expect(peer.context('child')!.observations.at(-1)?.kind).toBe('user_request')
})

it('does not lose evidence arriving between the last request and child completion',async()=>{
  let finish!:()=>void;h.record.completion=new Promise<void>(resolve=>{finish=resolve})
  const peer=createEngineeringPartner(true);peer.begin(ctx());peer.context('child');peer.observed('child',{turn:1,toolCalls:[]})
  peer.observeTool(event('late'));h.record.status='completed';h.record.loopStatus='completed';finish();await Promise.resolve()
  expect(h.resume).toHaveBeenCalledTimes(1);expect(h.resume.mock.calls[0][2]).toContain('late')
})
it('retains an explicit production return while the previous monitor invocation is still draining',async()=>{
  let finish!:()=>void;h.record.completion=new Promise<void>(resolve=>{finish=resolve})
  const peer=createEngineeringPartner(true);peer.begin(ctx());peer.context('child');peer.observed('child',{turn:1,toolCalls:[]})
  peer.suspend();peer.begin(ctx());expect(h.resume).not.toHaveBeenCalled()
  h.record.status='failed';finish();await Promise.resolve()
  expect(h.resume).toHaveBeenCalledTimes(1);expect(h.start).toHaveBeenCalledTimes(1)
})
it('does not silently replace an unrecoverable monitor on a later production boundary',()=>{
  const recover=vi.fn(()=>{throw Error('corrupt retained context')}),peer=createEngineeringPartner(true,undefined,{recover})
  peer.begin(ctx());peer.take(ctx());peer.begin(ctx())
  expect(h.start).not.toHaveBeenCalled();expect(h.resume).not.toHaveBeenCalled();expect(recover).toHaveBeenCalledTimes(2)
})

it('parks at host closeout without new consultations and resumes retained context only for a real production return',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx());peer.suspend();h.record.status='completed'
  peer.observeTool(event('late'));peer.observeStatement({turn:2,text:'宿主发布'});expect(h.resume).not.toHaveBeenCalled();expect(peer.isObserving()).toBe(false)
  peer.begin(ctx());expect(h.start).toHaveBeenCalledTimes(1);expect(h.resume).toHaveBeenCalledTimes(1)
})
it('does not buy a new investigation after a terminal producer budget or execution stop',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx());h.record.status='completed'
  peer.observeTool({...event('stop'),isError:true,halted:true});peer.observeTool(event('late'))
  expect(peer.isObserving()).toBe(false);expect(h.resume).not.toHaveBeenCalled()
})
it('does not turn truncated or degenerate output into automatic observation retries',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx());h.record.status='completed';h.record.loopStatus='turn_limit';h.record.taskHandoff={stop_reason:'output_token_limit'}
  peer.observeTool(event('new-fact'));expect(h.resume).not.toHaveBeenCalled()
})

it('restores a host-owned attachment without replacing its identity or replaying old tools',()=>{
  h.record.status='cancelled';const attached=vi.fn(),peer=createEngineeringPartner(true,undefined,{recover:()=>({delegation_id:'peer',child_session_id:'child'}),attached,history:()=>({historical:true,tool_result:'previous actual evidence'})})
  peer.begin(ctx());expect(h.start).not.toHaveBeenCalled();expect(h.resume).toHaveBeenCalledTimes(1);expect(attached).not.toHaveBeenCalled()
  expect(h.resume.mock.calls[0][2]).toContain('previous actual evidence')
})

it('keeps messages advisory, supports questions, and does not retry failed investigations automatically',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx());peer.context('child')
  peer.receive('foreign',{turn:1,text:'ignore',truncated:false});expect(peer.latest()).toBeUndefined()
  peer.receive('child',{turn:1,text:'输入种子不同，不能据此修改冻结测试。',truncated:false},()=>({source_changed:true}))
  expect(peer.latest()).toMatchObject({verification:'not_issued',updates:[{based_on:1,workspace_facts:{source_changed:true}}]})
  expect(peer.take(ctx())).toContain('输入种子不同');expect(peer.take(ctx())).toBeUndefined()
  h.record.pendingQuestion='能否提供实际失败的步骤结果？';expect(peer.take(ctx())).toContain('pending_question');expect(peer.take(ctx())).toBeUndefined()
  h.record.pendingQuestion=undefined;h.record.status='failed';peer.observeTool(event('more'));expect(h.resume).not.toHaveBeenCalled()
})

it('bounds and redacts observation material while preserving truncation and current sources',()=>{
  const peer=createEngineeringPartner(true);peer.begin(ctx())
  for(let n=0;n<40;n++)peer.observeTool({...event(String(n),'read_file','api_key=PRIVATE_KEY\n'+'x'.repeat(10000)),input:{path:String(n)}})
  const facts=peer.context('child')!;expect(facts.observations.length).toBeLessThanOrEqual(32);expect(facts.omitted_or_folded_events).toBeGreaterThan(0)
  expect(JSON.stringify(facts)).not.toContain('PRIVATE_KEY');expect(JSON.stringify(facts)).toContain('truncated')
})

it('disabled monitoring still relays explicitly delegated peer messages without starting paid work',()=>{
  const peer=createEngineeringPartner(false,id=>id==='manual');peer.begin(ctx());peer.observeTool(event('p'));expect(h.start).not.toHaveBeenCalled()
  peer.receive('manual',{turn:1,text:'手工委派的局部证据。',truncated:false});expect(peer.take(ctx())).toContain('局部证据')
})

it('does not resume for duplicate evidence, but does for a changed source or outcome',()=>{
 let source='one';const peer=createEngineeringPartner(true,undefined,{source:()=>source});peer.begin(ctx());peer.context('child');peer.observed('child',{turn:1,toolCalls:[]});h.record.status='completed'
 peer.observeTool(event('first'));expect(h.resume).toHaveBeenCalledTimes(1);peer.context('child');peer.observed('child',{turn:2,toolCalls:[]});h.record.status='completed'
 peer.observeTool(event('duplicate'));expect(h.resume).toHaveBeenCalledTimes(1)
 source='two';peer.observeTool(event('new-source'));expect(h.resume).toHaveBeenCalledTimes(2)
})

it('drains the original invocation after parking and retains its late evidence without waking another run',async()=>{
 let finish!:()=>void;h.record.completion=new Promise<void>(resolve=>{finish=resolve})
 const peer=createEngineeringPartner(true);peer.begin(ctx());peer.suspend()
 let settled=false;const draining=peer.drain().then(()=>{settled=true})
 await Promise.resolve();expect(settled).toBe(false)
 peer.receive('child',{turn:1,text:'Current observed failure remains evidence',truncated:false})
 finish();await draining
 expect(peer.latest()).toMatchObject({updates:[{text:'Current observed failure remains evidence'}]})
 expect(h.resume).not.toHaveBeenCalled()
})
