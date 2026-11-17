import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, SDKMessage } from '../../shared/types'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { SDKQueryOptions, SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'
import { runAgentLoop, type AgentLoopInput, type AgentLoopTool } from '../../main/agent/loop/agent-loop'
import { openPiSession, piSessionPath } from '../../main/agent/loop/pi-session-store'
import { emptyAssistant } from '../../main/agent/loop/pi-messages'
import { createProductionBudget } from '../../main/desktop/production-budget'
import { enqueueSteer } from '../../main/agent/loop/steer-queue'
import { AssistantTurnCollector } from '../support/assistant-turn-collector'
import {verificationToolFeedback,verificationReportView} from '../../main/software/verification-report'
import {readToolFeedback} from '../../shared/tool-feedback'

let home: string, oldHome: string | undefined
beforeEach(() => { oldHome = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-pi-')); process.env.PROMA_HOME = home })
afterEach(() => {
  if (oldHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = oldHome
  // Windows may briefly retain Pi's just-closed session directory handle.
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
const text = (text: string): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const call = (id: string, name: string, input: Record<string, unknown> = {}): SDKMessage => ({ type: 'assistant', message: {
  role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const done: SDKMessage = { type: 'result', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 } }
function scripted(scripts: SDKMessage[][]) {
  const received: SDKQueryOptions[] = []
  const query: SDKQuery = async function* (_prompt, options) {
    received.push(options)
    const script = scripts[Math.min(received.length - 1, scripts.length - 1)]
    for (const item of script) yield item
    yield done
  }
  return { query, received }
}
function input(query: SDKQuery, extra: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return { runtimeScope: 'desktop-implement', projectId: 'test-project', sessionId: 'test-session', requestId: 'r1',
    system: 'test controlled system', task: '完成一个最小修改并验证', tools: [], query, env: {}, maxTokens: 1000, maxTurns: 5,
    permissionMode: 'allow-all', signal: new AbortController().signal, publish: vi.fn(), ...extra }
}
function tool(name: string, execute: AgentLoopTool['execute']): AgentLoopTool {
  return { name, description: name, input_schema: { type: 'object', properties: {} }, execute }
}
function nativeFile() { return piSessionPath('test-project', 'test-session', 'desktop-implement:', process.cwd()) }

function auditMessages(sessionId = 'test-session'): AgentMessage[] {
  const path = getAgentSessionPath(sessionId)
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function publicText(message: AgentMessage) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('Pi public assistant message boundaries', () => {
  it.each(['response', 'turn'] as const)('correlates distinct responses in one run with the original audit and preserves %s partner timing', async timing => {
    const publish = vi.fn(), partner = vi.fn(), order: string[] = []
    const flow = scripted([
      [text('先读取当前文件。'), call('read-one', 'read_file')],
      [call('read-two', 'read_file')],
      [text('已核对。'), text('这是独立的最终回复。')],
    ])
    const result = await runAgentLoop(input(flow.query, { publish, publicMessageTiming: timing,
      onAssistantMessage: value => { partner(value); order.push('partner') },
      tools: [tool('read_file', async () => { order.push('tool'); return { output: 'read receipt' } })] }))
    expect(result.status).toBe('completed'); expect(result.turns).toBe(3)
    expect(result.finalText).toBe('已核对。这是独立的最终回复。')
    expect(partner.mock.calls.map(([value]) => value)).toEqual([
      { turn: 1, text: '先读取当前文件。' }, { turn: 3, text: '已核对。这是独立的最终回复。' },
    ])
    expect(order[0]).toBe(timing === 'response' ? 'partner' : 'tool')
    const boundaries = publish.mock.calls.filter(([type]) => type === 'assistant_message_boundary').map(([, payload]) => payload)
    const starts = boundaries.filter(value => value.boundary === 'start')
    expect(starts).toHaveLength(3)
    expect(new Set(starts.map(value => value.public_message_id)).size).toBe(3)
    const audit = auditMessages().filter(message => message.role === 'assistant')
    expect(audit).toHaveLength(3)
    for (const [index, start] of starts.entries()) {
      expect(start).toEqual({ public_message_id: expect.any(String), boundary: 'start', at: expect.any(Number) })
      expect(start.public_message_id).not.toBe('r1')
      expect(boundaries.filter(value => value.public_message_id === start.public_message_id)).toEqual([
        start, { public_message_id: start.public_message_id, boundary: 'end', at: expect.any(Number) },
      ])
      const deltas = publish.mock.calls.filter(([type, payload]) => type === 'message_delta' && payload.public_message_id === start.public_message_id)
      expect(deltas.map(([, payload]) => payload.text).join('')).toBe(publicText(audit[index]))
      expect(audit[index]).toMatchObject({ public_message_id: start.public_message_id, timestamp: start.at })
      if (index === 1) {
        expect(deltas).toHaveLength(0)
        expect(audit[index].content).toMatchObject([{ type: 'tool_use', id: 'read-two' }])
      }
    }
    let activeId: string | undefined
    for (const [type, payload] of publish.mock.calls) {
      if (type === 'assistant_message_boundary') {
        if (payload.boundary === 'start') { expect(activeId).toBeUndefined(); activeId = payload.public_message_id }
        else { expect(activeId).toBe(payload.public_message_id); activeId = undefined }
      } else if (type === 'message_delta') expect(payload.public_message_id).toBe(activeId)
    }
    expect(activeId).toBeUndefined()
    expect(publish.mock.calls.filter(([type]) => type === 'message_completed')).toHaveLength(0)
    expect(result.usage).toMatchObject({ inputTokens: 90, outputTokens: 15, turnsWithUsage: 3 })
  })

  it('uses the same DSML projection for live text and the original audit, preserves native tool evidence and excludes thinking', async () => {
    const publish = vi.fn(), partner = vi.fn()
    const raw = '公开计划。<｜｜DSML｜｜ calls>PRIVATE_PROTOCOL'
    const flow = scripted([
      [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, text('公开计划。<｜'), call('read', 'read_file'), text('｜DSML｜｜ calls>PRIVATE_PROTOCOL')],
      [text('普通尾部前缀<｜')],
    ])
    await runAgentLoop(input(flow.query, { publish, onAssistantMessage: partner, publicMessageTiming: 'response',
      tools: [tool('read_file', async () => ({ output: 'read receipt' }))] }))
    const audit = auditMessages().filter(message => message.role === 'assistant')
    const deltas = publish.mock.calls.filter(([type]) => type === 'message_delta')
    expect(audit).toHaveLength(2)
    for (const message of audit) {
      const streamed = deltas.filter(([, payload]) => payload.public_message_id === message.public_message_id).map(([, payload]) => payload.text).join('')
      expect(publicText(message)).toBe(streamed)
    }
    expect(publicText(audit[0])).toContain('公开计划。'); expect(publicText(audit[0])).toContain('已过滤')
    expect(audit[0].content).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'read' }))
    expect(publicText(audit[1])).toBe('普通尾部前缀<｜')
    expect(JSON.stringify(audit)).not.toMatch(/PRIVATE_REASONING|PRIVATE_PROTOCOL|<｜｜DSML｜｜/)
    expect(JSON.stringify(deltas)).not.toContain('PRIVATE_REASONING')
    expect(readFileSync(nativeFile(), 'utf8')).toContain('PRIVATE_PROTOCOL')
    // The existing advisory callback and model/runtime result keep their raw-response semantics.
    expect(partner.mock.calls[0][0]).toEqual({ turn: 1, text: raw })
  })

  it.each(['abort', 'incomplete', 'error', 'length'] as const)('closes a %s response as interrupted and preserves partial text/start-time audit correlation', async stop => {
    const publish = vi.fn(), partner = vi.fn(), beforeComplete = vi.fn()
    const abort = new AbortController()
    const query: SDKQuery = async function* () {
      yield text('保留这一段。<｜')
      if (stop === 'abort') { abort.abort('test-cancel'); await new Promise(() => {}) }
      else if (stop === 'error') throw Object.assign(new Error('controlled permanent failure'), { nonRetryable: true })
      else if (stop === 'length') yield { type: 'result', stop_reason: 'max_tokens', usage: { input_tokens: 8, output_tokens: 1000 } }
    }
    const run = runAgentLoop(input(query, { publish, signal: abort.signal, maxTurns: stop === 'incomplete' ? 4 : 1, onAssistantMessage: partner,
      publicMessageTiming: 'response', beforeComplete }))
    if (stop === 'incomplete') await expect(run).rejects.toThrow('PI_TRANSPORT_INCOMPLETE')
    else if (stop === 'error') await expect(run).rejects.toThrow('controlled permanent failure')
    else {
      const result = await run
      expect(result.status).toBe(stop === 'abort' ? 'cancelled' : 'turn_limit')
      if (stop === 'length') expect(result.termination_detail?.reason).toBe('output_token_limit')
    }
    const boundaries = publish.mock.calls.filter(([type]) => type === 'assistant_message_boundary').map(([, payload]) => payload)
    const starts = boundaries.filter(value => value.boundary === 'start')
    // Pi retries an incomplete stream under its existing policy; each physical
    // response must still close independently, never concatenate retry text.
    expect(starts).toHaveLength(stop === 'incomplete' ? 3 : 1)
    expect(new Set(starts.map(value => value.public_message_id)).size).toBe(starts.length)
    const audit = auditMessages().filter(message => message.role === 'assistant')
    expect(audit).toHaveLength(starts.length)
    const deltas = publish.mock.calls.filter(([type]) => type === 'message_delta')
    expect(deltas.every(([, payload]) => typeof payload.public_message_id === 'string')).toBe(true)
    for (const [index, start] of starts.entries()) {
      expect(boundaries.filter(value => value.public_message_id === start.public_message_id)).toEqual([
        { public_message_id: start.public_message_id, boundary: 'start', at: expect.any(Number) },
        { public_message_id: start.public_message_id, boundary: 'interrupted', at: expect.any(Number) },
      ])
      expect(audit[index]).toMatchObject({ public_message_id: start.public_message_id, timestamp: start.at })
      expect(publicText(audit[index])).toBe('保留这一段。<｜')
      expect(deltas.filter(([, payload]) => payload.public_message_id === start.public_message_id).map(([, payload]) => payload.text).join('')).toBe(publicText(audit[index]))
    }
    expect(partner).not.toHaveBeenCalled(); expect(beforeComplete).not.toHaveBeenCalled()
    expect(publish.mock.calls.some(([type]) => type === 'message_completed')).toBe(false)
  })
})

describe('real upstream Pi AgentSession integration', () => {
  it('keeps per-call contexts/feedback identities separate and exposes numeric text metrics', async () => {
    const flow = scripted([[{ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'one', name: 'probe', input: {} }, { type: 'tool_use', id: 'two', name: 'probe', input: {} },
    ] } }], [text('done')]])
    const contexts: Array<import('../../main/agent/loop/agent-loop').ToolContext> = [], observations: import('../../main/agent/loop/agent-loop').ToolObservation[] = []
    const probe = tool('probe', async () => ({ output: '中文🙂', feedback: { schema_version: 1, source: 'host', execution: 'completed', verification: 'not_applicable' } }))
    probe.recordFeedback = (_feedback, ctx) => contexts.push(ctx)
    await runAgentLoop(input(flow.query, { tools: [probe], onToolObservation: value => observations.push(value), afterTools: async ctx => {
      expect(ctx.toolCallId).toBeUndefined(); return undefined
    } }))
    expect(contexts.map(ctx => ctx.toolCallId)).toEqual(['one', 'two'])
    expect(contexts[0]).not.toBe(contexts[1])
    for (const event of observations) if (event.phase === 'completed') {
      expect(event.duration_ms).toBeGreaterThanOrEqual(0); expect(event.input_bytes).toBe(2)
      expect(event.output_text_bytes).toBe(Buffer.byteLength(event.output))
    }
  })
  it('keeps original invocation budget admission for same-round read-only requests', async () => {
    const flow = scripted([[{ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'one', name: 'read_file', input: {} }, { type: 'tool_use', id: 'two', name: 'read_file', input: {} },
    ] } }], [text('stop after the bounded result')]])
    let executions = 0
    const result = await runAgentLoop(input(flow.query, { toolBudget: { read_file: 1 }, tools: [tool('read_file', async () => {
      executions++; return { output: 'read once' }
    })] }))
    expect(executions).toBe(1); expect(result.toolCalls.map(call => call.status)).toEqual(['ok', 'error'])
  })
  it('lets an advisory Agent end quietly only after a successful complete response',async()=>{
    let calls=0
    const publish=vi.fn()
    const quiet:SDKQuery=async function*(){calls++;yield{type:'thinking',thinking:'PRIVATE_MONITOR_REASONING'};yield{...done,subtype:'success'}}
    expect((await runAgentLoop(input(quiet,{publish,allowSilentCompletion:true,runtimeScope:'engineering-peer',accountingRole:'research'}))).status).toBe('completed')
    expect(calls).toBe(1)
    expect(publish.mock.calls.filter(([type])=>type==='message_delta')).toHaveLength(0)
    expect(publish.mock.calls.filter(([type])=>type==='assistant_message_boundary').map(([,payload])=>payload.boundary)).toEqual(['start','end'])
    expect(auditMessages().filter(message=>message.role==='assistant')).toHaveLength(0)
    const failed:SDKQuery=async function*(){yield{type:'result',subtype:'error'}}
    await expect(runAgentLoop(input(failed,{allowSilentCompletion:true,sessionId:'failed-monitor'}))).rejects.toThrow('EMPTY_MODEL_STREAM')
    const incomplete:SDKQuery=async function*(){}
    await expect(runAgentLoop(input(incomplete,{allowSilentCompletion:true,sessionId:'incomplete-monitor'}))).rejects.toThrow('PI_TRANSPORT_INCOMPLETE')
  })

  it('observes public plans and exact execution results without private reasoning or changing a receipt on observer failure',async()=>{
    const observed:unknown[]=[],order:string[]=[];let requests=0
    const query:SDKQuery=async function*(_p,options){
      if(requests++===0){yield{type:'thinking',thinking:'PRIVATE_REASONING'};yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'PUBLIC_PLAN: use seed 777001'},{type:'tool_use',id:'probe',name:'probe',input:{seed:777001}}]}}}
      else{expect(JSON.stringify(options.messages)).toContain('100027');expect(options.messages?.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='tool_use'&&b.id==='probe')?.input).toEqual({seed:777001});yield text('Actual seed differs; inspect before changing the test.')}
      yield done
    }
    const result=await runAgentLoop(input(query,{system:'PRIVATE_SYSTEM',publicMessageTiming:'response',
      onAssistantMessage:message=>{order.push('public');observed.push(message)},
      onToolObservation:value=>{order.push(value.phase==='started'?'requested':'result');observed.push(structuredClone(value));value.input.seed=0;throw Error('OBSERVER_FAILURE')},
      tools:[tool('probe',async()=>{order.push('execute');return{output:'actual seed=100027; room=normal'}})]}))
    expect(result.status).toBe('completed');expect(order.slice(0,4)).toEqual(['public','requested','execute','result'])
    expect(observed).toContainEqual(expect.objectContaining({id:'probe',name:'probe',input:{seed:777001},output:'actual seed=100027; room=normal',isError:false}))
    expect(JSON.stringify(observed)).not.toContain('PRIVATE_');expect(readFileSync(nativeFile(),'utf8')).toContain('actual seed=100027')
  })
  it.each([true,false])('distinguishes changing static findings from shifted line numbers (progress=%s)',async progress=>{
    const attempts=progress?3:8
    const q=scripted([...Array.from({length:attempts},(_,i)=>[call('check-'+i,'verify_app')]),[text('continue after actual repairs')]])
    let checks=0
    const result=await runAgentLoop(input(q.query,{maxTurns:10,tools:[tool('verify_app',async()=>{
      checks++
      const observed={status:'failed',summary:'rule hits',security:{passed:false,issues:Array.from({length:progress?4-checks:3},(_,i)=>({file:'app.js',category:'unsafe_dom',severity:'high',line:i+checks*100,user_visible_summary:'rule hit'}))}} as never
      return{output:'static findings',isError:true,feedback:verificationToolFeedback(observed)}
    })]}))
    expect(checks).toBe(attempts)
    if(progress){expect(result.status).toBe('completed');expect(q.received).toHaveLength(4)}
    else{expect(result.termination_detail).toMatchObject({reason:'no_progress',observed:8});expect(q.received).toHaveLength(8)}
  })

  it('stops repeated host closeout failures even when the initiating model tool succeeds',async()=>{
    const q=scripted([[call('review','start_quality_review')]])
    const failed=verificationToolFeedback({status:'failed',summary:'wrong total',core:{host_cli:{cases:[{name:'total',passed:false,exit_code:0,expected:{stdout:'4',exit_code:0},actual:'5'}]}}} as never)
    const result=await runAgentLoop(input(q.query,{maxTurns:8,tools:[tool('start_quality_review',async()=>({output:'review handed to host'}))],
      afterTools:async()=>({feedback:'QUALITY_CLOSEOUT_CHECK_REQUIRED: wrong total',verification:failed})}))
    expect(q.received).toHaveLength(8)
    expect(result.termination_detail).toMatchObject({reason:'no_progress',observed:8})
    expect(result.toolCalls).toHaveLength(8)
  })
  it('clears the host closeout failure count only after an actual passing host observation',async()=>{
    const q=scripted([[call('one','start_quality_review')],[call('two','start_quality_review')],[call('three','start_quality_review')],[call('four','start_quality_review')],[call('five','start_quality_review')],[text('done')]])
    const failed=verificationToolFeedback({status:'failed',summary:'wrong total'} as never),passed=verificationToolFeedback({status:'passed',summary:'checked'} as never)
    let checks=0
    const result=await runAgentLoop(input(q.query,{maxTurns:8,tools:[tool('start_quality_review',async()=>({output:'review returned'}))],
      afterTools:async()=>({feedback:'host observation',verification:++checks===3?passed:failed})}))
    expect(checks).toBe(5);expect(q.received).toHaveLength(6);expect(result.status).toBe('completed')
  })
  it.each(['verify_project_stage','future_verification_entry'])('stops repeated typed host refusals from %s despite changed filenames and intervening successful writes',async name=>{
    let calls=0
    const query:SDKQuery=async function*(){calls++;yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'edit-'+calls,name:'write_file',input:{}},{type:'tool_use',id:'check-'+calls,name,input:{file:'renamed-'+calls}}]}};yield done}
    const result=await runAgentLoop(input(query,{maxTurns:20,tools:[tool('write_file',async()=>({output:'written'})),tool(name,async()=>({output:'host refuses this contract',isError:true,feedback:{schema_version:1,execution:'not_run',verification:'unverified',source:'host',category:'invalid_input',reason:'CONTRACT_REFUSED',fingerprint:'same-contract'}}))]}))
    expect(calls).toBe(3);expect(result.termination_detail).toMatchObject({reason:'no_progress',observed:3})
  })
  it.each(['unknown','environment','assertion'] as const)('delivers %s feedback before the next controlled decision without routing ambiguity to blind product edits',async scenario=>{
    const r=(scenario==='environment'?{status:'environment_blocked',summary:'runtime unavailable'}:scenario==='assertion'?{status:'failed',summary:'expectation must be checked',core:{host_cli:{cases:[{name:'rounding',passed:false,exit_code:0,expected:{stdout:'4',exit_code:0},actual:'5'}]}}}:{status:'failed',summary:'failure without cause'}) as never
    const actions:string[]=[];let requests=0
    const query:SDKQuery=async function*(_p,options){
      if(requests++===0)yield call('verify','verify_app')
      else if(requests===2){
        const result=options.messages?.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='tool_result'&&b.tool_use_id==='verify')
        const feedback=readToolFeedback(result?.content??'')!
        expect(feedback.assessment?.root_cause_confirmed).toBe(false)
        expect(feedback.recovery).toBe(scenario==='environment'?'prepare_environment':'inspect')
        const packet=JSON.parse((result?.content??'').replace(/^<tool-feedback>[^\n]*<\/tool-feedback>\n/,''))
        yield call('diagnose',packet.next_action.tool,packet.next_action.arguments)
      }else yield text('observed next step; no unsupported repair')
      yield done
    }
    await runAgentLoop(input(query,{tools:[tool('verify_app',async()=>({output:JSON.stringify(verificationReportView(r)),feedback:verificationToolFeedback(r),isError:true})),
      ...['inspect_software_environment','read_production_context','write_file'].map(name=>tool(name,async args=>{actions.push(name+(args.topic?':'+args.topic:''));return{output:'observed'}}))]}))
    expect(actions).toEqual([scenario==='environment'?'inspect_software_environment':'read_production_context:'+(scenario==='assertion'?'features':'diagnostics')])
    expect(requests).toBe(3)
  })
  it('stops an unchanged review submission protocol failure in read-only mode before the turn ceiling',async()=>{
    const publish=vi.fn(),partner=vi.fn(),q=scripted([[call('submit','submit_quality_findings')]])
    const result=await runAgentLoop(input(q.query,{publish,onAssistantMessage:partner,maxTurns:48,tools:[tool('submit_quality_findings',async()=>({output:'INTENT_CONCERN_FINDING_REQUIRED',isError:true}))]}))
    expect(q.received).toHaveLength(3);expect(result.status).toBe('budget_exhausted')
    expect(result.termination_detail).toMatchObject({reason:'no_progress',observed:3})
    // The existing host stop notice is not a model/partner completion and must
    // not be appended to the preceding tool-only response's closed identity.
    const deltas=publish.mock.calls.filter(([type])=>type==='message_delta')
    expect(deltas).toHaveLength(1);expect(partner).not.toHaveBeenCalled()
    const notice=deltas[0][1],audit=auditMessages().filter(message=>message.role==='assistant')
    expect(audit).toHaveLength(4)
    expect(audit.at(-1)).toMatchObject({public_message_id:notice.public_message_id})
    expect(publicText(audit.at(-1)!)).toBe(notice.text)
    expect(publish.mock.calls.filter(([type,payload])=>type==='assistant_message_boundary'&&payload.public_message_id===notice.public_message_id).map(([,payload])=>payload.boundary)).toEqual(['start','end'])
  })
  it('hands verified tool work to the host without buying a final parent declaration', async () => {
    const q=scripted([[call('check','verify_app')],[text('this extra model call must not happen')]])
    const result=await runAgentLoop(input(q.query,{tools:[tool('verify_app',async()=>({output:'host receipt'}))],
      afterTools:async(_ctx,calls)=>calls.some(c=>c.name==='verify_app'&&c.status==='ok')?{complete:true}:undefined}))
    expect(result.status).toBe('completed');expect(q.received).toHaveLength(1)
    expect(readFileSync(nativeFile(),'utf8')).toContain('host receipt')
  })
  it('host feedback from tools continues repair and is not treated as completion', async () => {
    const q=scripted([[call('check','verify_app')],[text('need repair')]])
    const result=await runAgentLoop(input(q.query,{tools:[tool('verify_app',async()=>({output:'unverified'}))],
      afterTools:async()=>({feedback:'HOST_REPRODUCTION_REQUIRED'})}))
    expect(result.status).toBe('completed');expect(q.received).toHaveLength(2)
    expect(JSON.stringify(q.received[1].messages)).toContain('HOST_REPRODUCTION_REQUIRED')
  })
  it('keeps obsolete host snapshots in native history while sending only current state to the model',async()=>{
    let reads=0
    const q=scripted([[call('old-state','read_quality_findings')],[call('new-state','read_quality_findings')],[text('done')]])
    await runAgentLoop(input(q.query,{workMode:'implementation',tools:[tool('read_quality_findings',async()=>({output:++reads===1?'OLD_HOST_QUEUE_123':'CURRENT_HOST_QUEUE_456'}))]}))
    const wire=JSON.stringify(q.received[2].messages),native=readFileSync(nativeFile(),'utf8')
    expect(wire).not.toContain('OLD_HOST_QUEUE_123');expect(wire).toContain('CURRENT_HOST_QUEUE_456')
    expect(native).toContain('OLD_HOST_QUEUE_123');expect(native).toContain('CURRENT_HOST_QUEUE_456')
  })
  it('does not let host closeout swallow a user correction arriving while verification is awaited',async()=>{
    const q=scripted([[call('check','verify_app')],[text('processed correction')]])
    await runAgentLoop(input(q.query,{tools:[tool('verify_app',async()=>({output:'receipt'}))],afterTools:async()=>{
      enqueueSteer('test-session',{queueMessageId:'during-closeout',content:'保留新增的纠正要求',enqueuedAt:Date.now()})
      return{complete:true}
    }}))
    expect(q.received).toHaveLength(2)
    expect(JSON.stringify(q.received[1].messages)).toContain('保留新增的纠正要求')
  })
  it('does not enter host completion or spawn reviews for a failed provider turn', async () => {
    const beforeComplete=vi.fn(async()=>undefined)
    const query:SDKQuery=async function*(){throw new Error('REQUEST_BUDGET_EXHAUSTED')}
    await expect(runAgentLoop(input(query,{beforeComplete}))).rejects.toThrow('REQUEST_BUDGET_EXHAUSTED')
    expect(beforeComplete).not.toHaveBeenCalled()
  })
  it('stops repeated host failures despite intervening successful commands', async () => {
    const scripts: SDKMessage[][] = Array.from({ length: 8 }, (_, i) => [call('print-' + i, 'run_command'), call('failed-' + i, 'verify_app')])
    const source = scripted([...scripts, [text('must not reach completion')]])
    const result = await runAgentLoop(input(source.query, { maxTurns: 30, workMode: 'implementation', tools: [
      tool('run_command', async () => ({ output: '{"exit_code":0}' })),
      tool('verify_app', async () => ({ output: '{"failure":{"code":"GUI_EXISTING_EXPECTATIONS_CHANGED"}}', isError: true })),
    ] }))
    expect(result.status).toBe('budget_exhausted')
    expect(result.termination_detail).toMatchObject({ reason: 'no_progress', limit: 8, observed: 8 })
    expect(source.received).toHaveLength(8)
    expect(result.toolCalls.filter(c => c.name === 'verify_app').every(c => c.failureKey?.startsWith('GUI_EXISTING_EXPECTATIONS_CHANGED:'))).toBe(true)
  }, 60000)
  it('executes tools through Pi, pairs transport results, persists native history and reports real usage', async () => {
    const observed=vi.fn()
    const write = vi.fn(async () => ({ output: 'written', detail: { path: 'main.py' } }))
    const check = vi.fn(async () => ({ output: 'verified' }))
    const { query, received } = scripted([[call('w', 'write_file'), call('v', 'run_project_script')], [text('已修改并验证')]])
    const result = await runAgentLoop(input(query, { tools: [tool('write_file', write), tool('run_project_script', check)],onRuntimeObservation:observed,
      env:{ANTHROPIC_AUTH_TOKEN:'secret-not-in-identity',ANTHROPIC_MODEL:'fixture',ANTHROPIC_BASE_URL:'https://user:password@fixture.invalid/v1?key=private',ANTHROPIC_PROVIDER_TYPE:'fixture'} }))
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed.mock.calls[0][0]).toMatchObject({runtime:{engine:'pi',packages:{'pi-coding-agent':'1.4.0'}},settings:{contextWindow:128000,tool_execution:'sequential'},route:{model:'fixture',endpoint_origin:'https://fixture.invalid'},skills:{mode:'explicit-bloma',names:[]}})
    expect(JSON.stringify(observed.mock.calls)).not.toMatch(/secret-not-in-identity|password|key=private/)
    expect(result.status).toBe('completed')
    expect(write).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1)
    expect(result.files_changed).toEqual(['main.py'])
    expect(result.toolCalls).toMatchObject([{ name: 'write_file', status: 'ok' }, { name: 'run_project_script', status: 'ok' }])
    expect(received[1].messages?.at(-1)?.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'w' }, { type: 'tool_result', tool_use_id: 'v' }])
    expect(result.usage).toMatchObject({ inputTokens: 60, outputTokens: 10, turnsWithUsage: 2 })
    const native = readFileSync(nativeFile(), 'utf8')
    expect(native).toContain('"type":"session"'); expect(native).toContain('"role":"toolResult"')
    expect(native).toContain('bloma-tool-receipt')
    expect(received.every(options => options.accounting?.scope === 'loop')).toBe(true)
  })

  it('resumes the native transcript without importing duplicate audit history or replaying writes', async () => {
    const write = vi.fn(async () => ({ output: 'durable-write-result' }))
    const first = scripted([[call('w', 'write_file')], [text('第一轮完成')]])
    await runAgentLoop(input(first.query, { tools: [tool('write_file', write)] }))
    const second = scripted([[text('沿用既有结果继续')]])
    await runAgentLoop(input(second.query, { task: '继续', requestId: 'r2', historyTurns: [{ role: 'user', content: 'DUPLICATE_AUDIT' }] }))
    const history = JSON.stringify(second.received[0].messages)
    expect(history).toContain('durable-write-result'); expect(history).not.toContain('DUPLICATE_AUDIT')
    expect(write).toHaveBeenCalledTimes(1)
    const other = scripted([[text('新阶段')]])
    await runAgentLoop(input(other.query, { runtimeScope: 'desktop-verify' }))
    expect(JSON.stringify(other.received[0].messages)).not.toContain('durable-write-result')
  })

  it.each([true, false])('recovers an interrupted tool without replaying it (receipt=%s), including a torn final append', async receipt => {
    const { manager, release } = await openPiSession('test-project', 'test-session', 'desktop-implement:', process.cwd())
    const assistant = emptyAssistant({ id: 'bridge', name: 'bridge', api: 'openai-completions', provider: 'bloma-transport',
      baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 })
    assistant.content = [{ type: 'toolCall', id: 'crash', name: 'write_file', arguments: {} }]; assistant.stopReason = 'toolUse'
    const assistantEntryId = manager.appendMessage(assistant)
    manager.appendCustomEntry('bloma-tool-receipt', { id: 'crash', assistantEntryId: receipt ? assistantEntryId : 'stale-entry-id',
      name: 'write_file', content: 'already-written-before-crash', isError: false })
    release()
    appendFileSync(nativeFile(), '{"type":"message","incomplete":')
    const write = vi.fn(async () => ({ output: 'unexpected' }))
    const next = scripted([[text('恢复完成')]])
    await runAgentLoop(input(next.query, { tools: [tool('write_file', write)] }))
    expect(JSON.stringify(next.received[0].messages)).toContain(receipt ? 'already-written-before-crash' : '执行结果未知')
    expect(readdirSync(dirname(nativeFile())).some(file => file.includes('.interrupted-'))).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps completion prerequisites open and never marks a truncated response completed', async () => {
    const flow = scripted([[text('准备好了')], [text('满足条件')]])
    const beforeComplete = vi.fn().mockResolvedValueOnce('缺少真实结果，继续').mockResolvedValue(undefined)
    const result = await runAgentLoop(input(flow.query, { beforeComplete }))
    expect(result.turns).toBe(2); expect(beforeComplete).toHaveBeenCalledTimes(2)
    const cutoff: SDKQuery = async function* () { yield text('partial'); yield { type: 'result', stop_reason: 'max_tokens' } }
    const stopped = await runAgentLoop(input(cutoff, { sessionId: 'cutoff', maxTurns: 2 }))
    expect(stopped.status).toBe('turn_limit'); expect(stopped.termination_detail?.reason).toBe('output_token_limit')
  })

  it('resumes past a failed assistant with a leftover result without sending orphan results or replaying writes', async () => {
    const {manager,release}=await openPiSession('test-project','test-session','desktop-implement:',process.cwd())
    const failed=emptyAssistant({id:'bridge',name:'bridge',api:'openai-completions',provider:'bloma-transport',baseUrl:'',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1000})
    failed.content=[{type:'toolCall',id:'failed-call',name:'write_file',arguments:{}}];failed.stopReason='error'
    manager.appendMessage(failed)
    manager.appendMessage({role:'toolResult',toolCallId:'failed-call',toolName:'write_file',content:[{type:'text',text:'orphan-native-evidence'}],isError:true,timestamp:Date.now()})
    release()
    const query:SDKQuery=async function*(_prompt,options){
      expect(JSON.stringify(options.messages)).not.toContain('failed-call')
      yield text('继续核对现场，不重放写入');yield done
    }
    const write=vi.fn(async()=>({output:'must-not-replay'}))
    expect((await runAgentLoop(input(query,{tools:[tool('write_file',write)]}))).status).toBe('completed')
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(nativeFile(),'utf8')).toContain('orphan-native-evidence')
  })

  it('preserves denied permissions and stops mixed tool batches on persistent host budget exhaustion', async () => {
    const write = vi.fn(async () => ({ output: 'unexpected' }))
    const denied = scripted([[call('no', 'write_file')], [text('已受阻')]])
    const result = await runAgentLoop(input(denied.query, { tools: [tool('write_file', write)], permissionMode: 'safe' }))
    expect(result.toolCalls[0].status).toBe('error'); expect(write).not.toHaveBeenCalled()
    const exhausted = scripted([[call('budget', 'run_project_script'), call('write', 'write_file')], [text('must-not-call')]])
    const blocked = await runAgentLoop(input(exhausted.query, { sessionId: 'budget', tools: [tool('run_project_script', async () => ({
      output: 'exhausted', budgetExhausted: true, feedback: { schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'budget', recovery: 'resume',
        budget: { resource: 'script_runs', scope: 'project', used: 1, limit: 1, remaining: 0, resets_on: 'none' } },
    })), tool('write_file', write)] }))
    expect(blocked.status).toBe('budget_exhausted'); expect(write).not.toHaveBeenCalled(); expect(exhausted.received).toHaveLength(1)
  })

  it('cancels a non-cooperative model stream without starting tools or another request', async () => {
    const abort = new AbortController()
    const query: SDKQuery = async function* () { yield text('partial'); abort.abort('test-cancel'); await new Promise(() => {}) }
    const result = await runAgentLoop(input(query, { signal: abort.signal }))
    expect(result.status).toBe('cancelled'); expect(result.toolCalls).toHaveLength(0)
  })

  it('honors the physical request guard and rejects corrupt native history', async () => {
    const budget = createProductionBudget('test-project', 'digest', 'desktop-implement', { requests: 1, output: 5000,
      phaseRequests: 1, perResponse: 1000 })
    const physical: SDKQuery = async function* (_prompt, options) {
      options.requestGuard?.({ url: 'https://model.invalid', body: JSON.stringify({ max_tokens: options.maxTokens }) })
      yield call('r', 'read_file'); yield done
    }
    await expect(runAgentLoop(input(budget.wrap(physical), { tools: [tool('read_file', async () => ({ output: 'read' }))] }))).rejects.toThrow('HARNESS_')
    expect(budget.snapshot().requests).toBe(1)
    const badFile = nativeFile(); mkdirSync(dirname(badFile), { recursive: true }); writeFileSync(badFile, 'corrupt')
    const safe = scripted([[text('unexpected')]])
    await expect(runAgentLoop(input(safe.query))).rejects.toThrow()
    expect(safe.received).toHaveLength(0)
  })

  it('uses native compaction and routes summary requests through the guarded transport', async () => {
    let requests = 0
    const scopes: string[] = []
    const loopInputs: string[] = []
    const query: SDKQuery = async function* (_prompt, options) {
      scopes.push(options.accounting?.scope ?? '')
      if (options.accounting?.scope === 'loop') loopInputs.push(JSON.stringify(options.messages))
      requests += 1
      yield text(requests === 1 ? 'completed first task' : 'Preserved durable task facts')
      yield { type: 'result', stop_reason: 'end_turn', usage: { input_tokens: requests === 1 ? 110000 : 100, output_tokens: 10 } }
    }
    const compaction = vi.fn()
    const historyTurns = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `history ${index}: ` + 'context fact '.repeat(5000) }))
    let recoveries = 0
    const result = await runAgentLoop(input(query, { onCompaction: compaction, historyTurns, recoveryContext: () => 'CURRENT_HOST_FACTS_' + (++recoveries) }))
    expect(result.status).toBe('completed'); expect(compaction).toHaveBeenCalled()
    expect(scopes).toContain('handoff')
    expect(readFileSync(nativeFile(), 'utf8')).toContain('"type":"compaction"')
    expect(result.usage?.handoffCalls).toBeGreaterThan(0)
    expect(recoveries).toBeGreaterThanOrEqual(2)
    expect(loopInputs.some(text => text.includes('CURRENT_HOST_FACTS_2'))).toBe(true)
  })

  it('lets Pi retry a failed provider turn without replaying a completed write', async () => {
    let requests = 0
    const write = vi.fn(async () => ({ output: 'preserved write' }))
    const query: SDKQuery = async function* () {
      requests += 1
      if (requests === 1) yield call('write-once', 'write_file')
      else if (requests === 2) { yield text('FAILED_STREAM_ADVANCE_MARK'); throw new Error('503 service unavailable') }
      else yield text('恢复后完成')
      yield done
    }
    const collector = new AssistantTurnCollector()
    const result = await runAgentLoop(input(query, { tools: [tool('write_file', write)], publish: collector.onPublish,
      onTurn: info => info.failed ? collector.discardCurrentTurn() : collector.onTurnBoundary() }))
    expect(result.status).toBe('completed'); expect(requests).toBe(3); expect(write).toHaveBeenCalledTimes(1)
    expect(result.turns).toBe(3)
    expect(JSON.stringify(collector.flush())).not.toContain('FAILED_STREAM_ADVANCE_MARK')
  })

  it('injects running corrections at the Pi queue boundary and defers them at the turn limit', async () => {
    const correction = tool('read_file', async () => {
      enqueueSteer('test-session', { queueMessageId: 'correction-1', content: '把标题改成知识库', enqueuedAt: Date.now() })
      return { output: 'read' }
    })
    const flow = scripted([[call('read', 'read_file')], [text('已采纳补充')]])
    const publish = vi.fn()
    await runAgentLoop(input(flow.query, { tools: [correction], publish }))
    expect(JSON.stringify(flow.received[1].messages)).toContain('把标题改成知识库')
    expect(publish.mock.calls.filter(([type]) => type === 'steer_injected')).toHaveLength(1)
    const capped = scripted([[call('last-read', 'read_file')]])
    publish.mockClear()
    const result = await runAgentLoop(input(capped.query, { tools: [correction], publish, maxTurns: 1 }))
    expect(result.status).toBe('turn_limit')
    expect(publish.mock.calls.filter(([type]) => type === 'steer_injected')).toHaveLength(0)
    const resumed = scripted([[text('续跑处理补充')]])
    await runAgentLoop(input(resumed.query))
    expect(JSON.stringify(resumed.received[0].messages)).toContain('把标题改成知识库')
  })

  it('ignores ambient agent instructions and preserves short image references', async () => {
    const dir = join(home, 'bloma-pi-runtime'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'AGENTS.md'), 'AMBIENT_INSTRUCTION_MUST_NOT_LOAD')
    writeFileSync(join(dir, 'APPEND_SYSTEM.md'), 'AMBIENT_APPEND_MUST_NOT_LOAD')
    const flow = scripted([[text('完成')]])
    await runAgentLoop(input(flow.query, { images: [{ imageId: 'test-session/image.png', media_type: 'image/png' }] }))
    const serialized = JSON.stringify(flow.received[0].messages)
    expect(serialized).not.toContain('AMBIENT_')
    expect(serialized).toContain('test-session/image.png'); expect(serialized).not.toContain('bloma-image-ref:')
    expect(readFileSync(nativeFile(), 'utf8')).not.toContain('"source":{"type":"base64"')
  })
  it('delivers actual tool image references to the next model request and preserves them in replay without base64 logs', async () => {
    const flow = scripted([[call('see', 'see_image')], [text('看到实际截图')]])
    const images = [{ imageId: 'test-session/actual-screenshot.png', media_type: 'image/png' }]
    const see = tool('see_image', async () => ({ output: 'actual screenshot', images }))
    await runAgentLoop(input(flow.query, { tools: [see] }))
    expect(JSON.stringify(flow.received[1].messages)).toContain('actual-screenshot.png')
    expect(readFileSync(nativeFile(), 'utf8')).toContain(Buffer.from('bloma-image-ref:test-session/actual-screenshot.png').toString('base64'))
    const resumed = scripted([[text('继续检查')]])
    await runAgentLoop(input(resumed.query, { tools: [see], task: '沿上次截图继续' }))
    expect(JSON.stringify(resumed.received[0].messages)).toContain('actual-screenshot.png')
    expect(readFileSync(nativeFile(), 'utf8')).not.toContain('"source":{"type":"base64"')
  })

  it('respects permanent quota denial and rejects an empty completion', async () => {
    let requests = 0
    const denied: SDKQuery = async function* () { requests++; throw Object.assign(new Error('HTTP 429 code 1308 fixed account limit'), { nonRetryable: true }) }
    await expect(runAgentLoop(input(denied))).rejects.toThrow('1308')
    expect(requests).toBe(1)
    const empty: SDKQuery = async function* () { yield done }
    await expect(runAgentLoop(input(empty, { sessionId: 'empty' }))).rejects.toThrow('EMPTY_MODEL_STREAM')
  })
})

it.each(['off','low','high','max'] as const)('uses the same %s setting for requests and runtime observations',async level=>{
  const q=scripted([[text('finished')]]),observations:any[]=[]
  await runAgentLoop(input(q.query,{env:{BLOMA_LOOP_THINKING:level},onRuntimeObservation:o=>observations.push(o)}))
  expect(q.received[0].thinkingLevel).toBe(level)
  expect(observations[0].settings.thinking).toBe(level)
})
it('refreshes ephemeral host facts without accumulating them in the Pi transcript',async()=>{
  let remaining=10
  const q=scripted([[call('step','step')],[text('finished')]])
  await runAgentLoop(input(q.query,{tools:[tool('step',async()=>{remaining=3;return{output:'executed'}})],liveContext:()=>({remaining})}))
  const messages=q.received[1].messages!
  const facts=messages.filter(m=>JSON.stringify(m.content).includes('当前宿主事实'))
  expect(facts).toHaveLength(1);expect(JSON.stringify(facts)).toContain('remaining');expect(JSON.stringify(facts)).toContain('3')
  expect(readFileSync(nativeFile(),'utf8')).not.toContain('当前宿主事实')
})
