import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {redactSoftwareOutput} from '../main/software/process-manager'

/** Public operational audit only; native thinking and credentials are excluded.
 * Full tool receipts are joined using session + tool ID, never guessed by time. */
export function exportTrialTrace(root:string){
  root=resolve(root)
  const dest=join(root,'report'),details=join(dest,'requests');mkdirSync(details,{recursive:true})
  const read=(p:string)=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''))
  const rows=readdirSync(join(root,'trace/requests')).filter(n=>/^\d{5}\.json$/.test(n)).map(n=>read(join(root,'trace/requests',n))).sort((a,b)=>a.sequence-b.sequence)
  const owners=new Map<string,any[]>(),receipts=new Map<string,any[]>()
  for(const r of rows)for(const t of r.tool_calls){const key=r.session_id+':'+t.id;owners.set(key,[...(owners.get(key)??[]),r])}
  let unmatched=0
  for(const session of new Set(rows.map(r=>r.session_id))){
    if(!/^[A-Za-z0-9_-]+$/.test(session))continue
    const path=join(root,'home/agent-sessions',session+'.jsonl');if(!existsSync(path))continue
    const active=new Map<string,any>(),used=new Map<string,number>()
    for(const line of readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean)){
      let m;try{m=JSON.parse(line)}catch{continue}
      if(!Array.isArray(m.content))continue
      for(const b of m.content){
        if(b.type==='tool_use'){const key=session+':'+b.id,i=used.get(key)??0;used.set(key,i+1);const owner=owners.get(key)?.[i];if(owner)active.set(b.id,owner)}
        if(b.type==='tool_result'){
          const owner=active.get(b.tool_use_id);if(!owner){unmatched++;continue}
          receipts.set(owner.trace_id,[...(receipts.get(owner.trace_id)??[]),{tool_call_id:b.tool_use_id,is_error:b.is_error===true,content:b.content}])
          active.delete(b.tool_use_id)
        }
      }
    }
  }
  const json=(v:unknown)=>redactSoftwareOutput(JSON.stringify(v,null,2))
  const fence=(s:string)=>{const n=Math.max(3,...(s.match(/`+/g)??[]).map(t=>t.length))+1,f='`'.repeat(n);return f+'text\n'+s+'\n'+f}
  const link=(p:string)=>p.replaceAll('\\','/')
  const index=['# 本轮逐请求完整记录','','本文件按请求序号记录本轮真实复测。`completed`只表示模型请求收到成功回执，不代表其输出通过校验，更不代表产品交付。物理发送、工具结果、观察员判断分别记录。','','| 请求 | 入口阶段 / 角色 | 物理发送 | 请求状态 | 已报告用量保守计价 | 工具动作 |','| --- | --- | ---: | --- | ---: | --- |']
  for(const r of rows){
    const id=String(r.sequence).padStart(5,'0'),full={...r,tool_results:receipts.get(r.trace_id)??[],tool_result_source:'native public tool_result messages; session and ID matched'}
    writeFileSync(join(details,id+'.json'),json(full))
    const text=['# 请求 '+r.sequence,'',`- 入口阶段：${r.phase}；角色：${r.role}；会话：${r.session_id}`,
      `- 开始：${r.started_at}；结束：${r.finished_at??'未结束'}（ISO UTC）`,
      `- 请求状态：${r.status}；实际发送次数：${r.transports.filter((t:any)=>t.state==='started').length}`,
      `- 用量回执：${JSON.stringify(r.usage??null)}；按已冻结高峰单价计价：${r.reported_price_micro_rmb===undefined?'未知':r.reported_price_micro_rmb/1e6+' 元'}`,
      `- [SDK对话输入](${link(r.input_file)}) · [结构化明细与完整工具回执](${link(join(details,id+'.json'))})`,'','## 触发输入',fence(redactSoftwareOutput(r.trigger??'')),'','## 模型公开返回',fence(redactSoftwareOutput((r.assistant_output??[]).join(''))),'','## 请求的工具动作']
    for(const call of r.tool_calls)text.push(`- ${call.name}（${call.id}）`,fence(json(call.input)))
    text.push('','## 工具实际返回')
    for(const result of full.tool_results)text.push(`- ${result.tool_call_id}；is_error=${result.is_error}`,fence(redactSoftwareOutput(typeof result.content==='string'?result.content:JSON.stringify(result.content))))
    if(!full.tool_results.length)text.push('本请求没有可关联的完整工具回执；参见结构化明细的tool_events，不能据此推断工具执行成功。')
    if(r.error)text.push('','## 请求错误',fence(redactSoftwareOutput(r.error)))
    if(r.observer_assessment)text.push('','## 观察员判断（区别于模型回执）',fence(json(r.observer_assessment)))
    writeFileSync(join(details,id+'.md'),text.join('\n')+'\n')
    index.push(`| [${r.sequence}](${link(join(details,id+'.md'))}) | ${r.phase} / ${r.role} | ${r.transports.filter((t:any)=>t.state==='started').length} | ${r.status} | ${r.reported_price_micro_rmb===undefined?'未知':(r.reported_price_micro_rmb/1e6).toFixed(6)} | ${r.tool_calls.map((t:any)=>t.name).join(', ')} |`)
  }
  const state=read(join(root,'monetary-policy.json.state.json'))
  const summary={logical_recorded:rows.length,physical_recorded:rows.reduce((n,r)=>n+r.transports.filter((t:any)=>t.state==='started').length,0),monetary_receipts:state.entries.length,
    accounted_rmb:state.entries.reduce((n:number,r:any)=>n+r.charged_micro_rmb,0)/1e6,unreported_monetary:state.entries.filter((r:any)=>r.status!=='reported').length,
    native_tool_receipts:[...receipts.values()].reduce((n,r)=>n+r.length,0),unmatched_native_tool_receipts:unmatched}
  index.push('','## 对账',fence(JSON.stringify(summary,null,2)),'',`[观察员日志](${link(join(root,'observer-log.md'))})`)
  writeFileSync(join(dest,'requests.md'),index.join('\n')+'\n');writeFileSync(join(dest,'summary.json'),json(summary))
  return{...summary,index:join(dest,'requests.md')}
}
