import React from 'react'
import { useAtomValue } from 'jotai'
import { activeAgentSessionIdAtom, hasActiveStreamAtom } from '../agent-atoms'
import type { SoftwareProjectProgress } from '../../shared/types'

export function ProjectExecutionPanel({ projectId, progress, error }: { projectId: string; progress?: SoftwareProjectProgress; error?: string }) {
  const sessionId = useAtomValue(activeAgentSessionIdAtom), busy = useAtomValue(hasActiveStreamAtom)
  const [notice, setNotice] = React.useState('')
  if (error) return <p role="status">{error}</p>
  if (!progress) return null
  const cancel = async () => {
    if (!sessionId) return
    try { await window.electronAPI?.agent.cancel({ request_id: crypto.randomUUID(), project_id: projectId, session_id: sessionId, reason: 'user_cancelled' }); setNotice('已发送停止请求，正在保留现场。') }
    catch { setNotice('停止请求未确认，请重试。') }
  }
  return <section className="longterm-project-panel" aria-label="项目执行状态">
    <p>{progress.environment} · {progress.execution}</p>
    {busy && <button type="button" onClick={() => void cancel()}>停止当前制作</button>}
    <details><summary>阶段与协作详情</summary>
      {progress.stages.map(stage => <p key={stage.id}>{stage.title} · {stage.status === 'passed'
        ? stage.current_source ? '累计局部检查通过' : '此前版本局部检查通过'
        : stage.status === 'failed' ? '局部检查未通过' : stage.status === 'running' && busy ? '正在检查' : stage.status === 'not_run' ? '尚未检查' : '检查尚未完成'}{progress.next_stage === stage.id ? ' · 下一步' : ''}</p>)}
      <p>本轮累计派发 {progress.delegation_count} 次，以下为最近 {progress.delegations.length} 项；累计数量不是同时并发数量。</p>
      {progress.delegations.map(task => <p key={task.id}>{task.required_review ? '必需审阅' : '专项工作'} · {task.reason} · {task.status === 'ended' ? '已结束，结果仍须验收' : task.status === 'running' ? '执行中' : '已中断，待恢复核对'}</p>)}
      <p>{progress.note}</p>
    </details>
    {notice && <p role="status">{notice}</p>}
  </section>
}
