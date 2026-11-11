import React from 'react'
import type { ToolDisplay } from '../../shared/tool-display'
const panel: React.CSSProperties={margin:0,padding:'var(--space-2)',border:'1px solid var(--color-border)',borderRadius:'var(--radius-sm)',whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflowY:'auto',fontFamily:'monospace',fontSize:'var(--font-size-xs)'}
const stateLabels:Record<string,string>={starting:'正在启动',running:'进程仍在运行',stopping:'正在停止',stopped:'已停止',exited:'已退出',failed:'进程失败',interrupted:'运行中断，结果待核对'}
/** Render text only. Never evaluate HTML/ANSI, open tool-supplied URLs or replay actions. */
export const ToolDetailView:React.FC<{display:ToolDisplay}>=({display})=>display.kind==='changes'?(
 <section data-ai-id="tool-change-details" aria-label="实际提交差异">
  <p>本次实际提交的连续差异片段；不是当前磁盘版本或验收通过证明。</p>
  {display.files.map((file,index)=><section key={`${file.path}:${index}`} style={{marginBottom:8}}>
   <strong>{file.path} · {file.created?'已创建':'已写入'}{file.line?` · 第 ${file.line} 行起`:''}</strong>
   <div>提交 {file.before?.slice(0,12)??(file.created?'新文件':'原文未保留')} → {file.after.slice(0,12)}</div>
   {file.removed!==undefined&&<pre style={{...panel,borderLeft:'3px solid var(--color-danger)'}} aria-label="移除内容">{file.removed||'（无移除）'}</pre>}
   {file.added!==undefined&&<pre style={{...panel,borderLeft:'3px solid var(--color-quick)'}} aria-label="写入内容">{file.added||'（无新增）'}</pre>}
   {file.omitted&&<p role="note">差异未完整保存（大小限制或原文不可用）；此处只展示脱敏片段。</p>}
  </section>)}
 </section>
):(
 <section data-ai-id="tool-process-details" aria-label="进程与日志">
  <strong>{stateLabels[display.state]??display.state}{display.exit_code!==undefined?` · 退出码 ${display.exit_code}`:''}</strong>
  <p>这是本次读取时的状态，不是实时监控。命令退出不等于产品验收；无需重复启动。</p>
  <pre style={panel}>{display.preview||'本次读取没有新的文本输出。'}</pre>
  {display.truncated&&<p role="note">这是有界输出片段，不是完整日志。</p>}
  <details><summary>日志查询入口</summary>
   <p>{display.log_available?(display.log_complete?'脱敏归档可查询。':'归档存在，但有明确缺口。'):'归档不可用；不能保证取回早期输出。'}</p>
   <code style={{overflowWrap:'anywhere'}}>read_process({JSON.stringify({process_id:display.id,mode:'log',since_seq:0,limit:40})})</code>
   <p>仅查询原所属会话的日志；不会重启或重放命令。</p>
  </details>
 </section>
)
