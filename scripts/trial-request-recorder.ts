import {appendFileSync,existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import type {SDKQuery} from '../main/orchestration/stages/orchestration-contracts'
import type {SDKMessage} from '../shared/types'

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
export { serializeRedactedJson as serializeTrialRecord } from '../shared/redacted-json'
/** Trial-only observation. No admission, retries, prompts or product state are
 * changed. Explicit request/tool IDs replace timestamp-based attribution. */
export function createTrialRequestRecorder(folder:string,redact:(value:unknown)=>string,snapshot:(session?:string)=>any,rates?:{input_rmb_per_million:number;output_rmb_per_million:number;cache_rmb_per_million:number}){
  mkdirSync(join(folder,'requests'),{recursive:true})
  const toolOwners=new Map<string,string>(),rows=new Map<string,any>()
  for(const file of readdirSync(join(folder,'requests')).filter(n=>/^\d{5}\.json$/.test(n))){
    let row:any
    try{row=JSON.parse(readFileSync(join(folder,'requests',file),'utf8'))}
    catch(error){
      if(!(error instanceof SyntaxError))throw error
      // Keep damaged historical bytes. A gap is visible, never fabricated as a
      // successful request and never allowed to reset sequence/accounting.
      const sequence=Number(file.slice(0,5))
      row={sequence,trace_id:'unreadable-'+sequence,phase:'historical',role:'unknown',status:'unreadable_record',trigger:'Historical record cannot be parsed; original bytes retained.',transports:[],tool_calls:[]}
    }
    rows.set(row.trace_id,row);for(const call of row.tool_calls??[])toolOwners.set(call.id,row.trace_id)
  }
  let sequence=Math.max(0,...[...rows.values()].map(r=>r.sequence))
  const clean=(value:any):any=>{
    if(Array.isArray(value))return value.filter(v=>!['thinking','redacted_thinking','reasoning'].includes(v?.type)).map(clean)
    if(!value||typeof value!=='object')return value
    if(value.type==='image'||value.type==='image_url')return{type:value.type,imageId:value.imageId,media_type:value.media_type,omitted_image_payload:true,sha256:sha(JSON.stringify(value))}
    return Object.fromEntries(Object.entries(value).filter(([k])=>!['thinking','reasoning','reasoning_content','signature','authorization','api_key','apiKey','password'].includes(k)).map(([k,v])=>[k,clean(v)]))
  }
  let recordingError:unknown
  const save=(row:any)=>{try{writeFileSync(join(folder,'requests',String(row.sequence).padStart(5,'0')+'.json'),redact(clean(row)))}catch(error){recordingError=error;throw error}}
  const timeline=()=>{
    const body=['# 全流程逐请求时间线','','每条记录区分逻辑请求、实际发送和用量回执；未发送不算API调用。工具归属按返回的tool_call_id关联，未知归属明确保留。原始明细不含凭据、图片二进制或模型隐藏推理。','','| 请求 | 阶段 / 角色 | 状态 | 物理发送 | 输入/输出 | 触发内容与动作 | 明细 |','| --- | --- | --- | ---: | --- | --- | --- |']
    for(const r of [...rows.values()].sort((a,b)=>a.sequence-b.sequence)){
      const cell=(s:unknown)=>String(s??'').replaceAll('|','\\|').replace(/[\r\n]+/g,' ').slice(0,230)
      body.push(`| ${r.sequence} | ${cell(r.before?.desktop_phase??r.before?.current_stage??r.phase)} / ${cell(r.role)} | ${cell(r.status)} | ${r.transports.filter((t:any)=>t.state==='started').length} | ${r.usage?.input_tokens??'?'} / ${r.usage?.output_tokens??'?'} | ${cell(r.trigger)}；${cell(r.tool_calls.map((t:any)=>t.name).join(', '))} | [请求 ${r.sequence}](requests/${String(r.sequence).padStart(5,'0')}.json) |`)
    }
    writeFileSync(join(folder,'timeline.md'),JSON.parse(redact(body.join('\n')+'\n')))
    writeFileSync(join(folder,'closeout-summary.json'),redact(summarizeTrialCloseout([...rows.values()])))
  }
  const event=(type:string,payload:any)=>{
    if(type==='thinking_delta'||type==='reasoning_delta')return
    const id=payload.tool_call_id,owner=id&&toolOwners.get(id),row=owner&&rows.get(owner)
    const entry={at:new Date().toISOString(),type,payload:clean(payload),trace_id:owner??null}
    appendFileSync(join(folder,'events.jsonl'),redact(entry)+'\n')
    if(row){row.tool_events.push(entry);save(row)}
  }
  const wrap=(query:SDKQuery,phase:string):SDKQuery=>async function*(prompt,options){
    if(recordingError)throw Error('TRIAL_TRACE_WRITE_FAILED: stop before new model calls')
    const seq=++sequence,id=randomUUID(),messages=options.messages??options.history??[]
    const last=messages.filter(m=>m.role==='user').at(-1)
    const before=snapshot(options.sessionId)
    const trigger=!options.messages?prompt:typeof last?.content==='string'?last.content:Array.isArray(last?.content)?last.content.map(b=>b.type==='tool_result'?`工具回执 ${b.tool_use_id}: ${b.content?.slice(0,500)}`:b.type==='text'?b.text:'图片/附件').join('\n'):prompt
    const row:any={sequence:seq,trace_id:id,phase,role:before?.review_kind??options.accounting?.role??'unassigned',session_id:options.sessionId,run_id:options.accounting?.runId,
      started_at:new Date().toISOString(),status:'running',trigger,
      before,requested_max_tokens:options.maxTokens,input:{prompt,messages},transports:[],prepared:[],tool_calls:[],assistant_output:[],tool_events:[]}
    rows.set(id,row);save(row);timeline()
    const bodyFile=join(folder,'requests',String(seq).padStart(5,'0')+'-input.json')
    writeFileSync(bodyFile,redact(clean(row.input)));delete row.input;row.input_file=bodyFile
    try{
      for await(const message of query(prompt,{...options,requestGuard:request=>{
        options.requestGuard?.(request)
        const body=JSON.parse(request.body)
        row.prepared.push({at:new Date().toISOString(),state:'prepared_not_proof_of_send',model:body.model,max_tokens:body.max_tokens,body_bytes:Buffer.byteLength(request.body),body_sha256:sha(request.body)});save(row)
      },onTransportAttempt:state=>{options.onTransportAttempt?.(state);row.transports.push({at:new Date().toISOString(),state});save(row);timeline()},
      onTransportResponse:receipt=>{options.onTransportResponse?.(receipt);row.transports.push({at:new Date().toISOString(),state:'response',receipt});save(row);timeline()}})){
        if(message.usage)row.usage={...row.usage,...message.usage}
        if(message.type==='assistant'&&message.message)for(const block of message.message.content){
          if(block.type==='text')row.assistant_output.push(block.text)
          if(block.type==='tool_use'){row.tool_calls.push(block);if(block.id)toolOwners.set(block.id,id)}
        }
        if(message.type==='result'){row.status=message.subtype==='success'?'completed':'error';row.stop_reason=message.stop_reason}
        yield message
      }
    }catch(error){row.status=options.signal.aborted?'cancelled':'error';row.error=String(error);throw error}
    finally{
      if(row.status==='running')row.status='ended_without_success_receipt'
      const starts=row.transports.filter((t:any)=>t.state==='started').length,u=row.usage
      if(rates&&starts&&row.status==='completed'&&Number.isSafeInteger(u?.input_tokens)&&Number.isSafeInteger(u?.output_tokens))row.reported_price_micro_rmb=Math.ceil((u.input_tokens+(u.cache_creation_input_tokens??0))*rates.input_rmb_per_million)+Math.ceil((u.cache_read_input_tokens??0)*rates.cache_rmb_per_million)+Math.ceil(u.output_tokens*rates.output_rmb_per_million)
      row.unreported_physical_attempts=Math.max(0,starts-(row.reported_price_micro_rmb===undefined?0:1))
      row.finished_at=new Date().toISOString();row.after=snapshot(options.sessionId);save(row);timeline()
    }
  }
  return{wrap,event,finish:timeline}
}

/** Derived from immutable recorder rows; never used for admission or publication. */
export function summarizeTrialCloseout(rows:any[]){
 const ordered=[...rows].sort((a,b)=>a.sequence-b.sequence)
 const tools=ordered.flatMap(r=>(r.tool_events??[]).filter((e:any)=>e.type==='tool_call_completed').map((e:any)=>({row:r,event:e})))
 const ready=tools.find(({event})=>event.payload?.feedback?.verification==='passed'&&event.payload?.feedback?.scope==='software_candidate')
 const at=ready?Date.parse(ready.event.at):undefined
 const following=at===undefined?[]:ordered.filter(r=>Date.parse(r.started_at)>=at)
 const role=(name:string)=>following.filter(r=>r.role===name)
 const sent=(r:any)=>(r.transports??[]).filter((t:any)=>t.state==='started').length
 const first=(names:string[])=>following.find(r=>names.includes(r.role)&&sent(r)>0)
 const milestone=(r:any)=>r&&at!==undefined?{sequence:r.sequence,elapsed_ms:Date.parse(r.started_at)-at}:null
 const published=following.find(r=>r.after?.desktop_phase==='delivered'&&r.after?.software_release_id)
 const counts=(list:any[])=>({logical:list.length,physical:list.reduce((n,r)=>n+sent(r),0),reported_micro_rmb:list.reduce((n,r)=>n+(r.reported_price_micro_rmb??0),0),unknown_physical:list.reduce((n,r)=>n+(r.unreported_physical_attempts??sent(r)),0)})
 return{first_ready:ready?{sequence:ready.row.sequence,at:ready.event.at}:null,
  first_code:milestone(first(['code'])),first_visual:milestone(first(['visual'])),publication:milestone(published),
  after_ready:counts(following),maker:counts(role('orchestrator')),optional:counts(role('research')),
  required_reviews:counts(following.filter(r=>['code','visual'].includes(r.role))),
  verification_attempts:tools.filter(({event})=>at!==undefined&&Date.parse(event.at)>=at&&event.payload?.tool==='verify_app').length,
  return_reasons:following.filter(r=>r.role==='orchestrator').map(r=>({sequence:r.sequence,trigger:r.trigger??null})),
  finding_submissions:following.flatMap(r=>(r.tool_calls??[]).filter((c:any)=>c.name==='submit_quality_findings').map((c:any)=>({sequence:r.sequence,findings:c.input?.findings?.length??null,resolutions:c.input?.resolutions?.length??null}))),
  authority:'observed recorder projection; review resolutions are not defect closures; unknown remains unknown; no release inferred from model text'}
}
