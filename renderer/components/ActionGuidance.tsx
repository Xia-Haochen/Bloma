import React from 'react'
import type { SoftwareStatusView } from '../../shared/types'

export interface ActionGuidanceProps {
  view?: SoftwareStatusView
  loading?: boolean
  failed?: boolean
  busy?: boolean
  override?: { headline: string; detail: string; actions?: React.ReactNode }
  onAction: (action: NonNullable<SoftwareStatusView['guidance']>['action']) => void | Promise<void>
  onRefresh: () => void
  onRecords: () => void
}
/** Prominent content answers what the person should do, not what the orchestrator is called. */
export const ActionGuidance: React.FC<ActionGuidanceProps> = ({ view, loading, failed, busy, override, onAction, onRefresh, onRecords }) => {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  const lock = React.useRef(false)
  const guidance = override ?? (failed ? undefined : view?.guidance)
  const perform = async () => {
    if (lock.current || busy || loading) return
    lock.current = true; setPending(true); setError('')
    try { await onAction(view?.guidance?.action) }
    catch { setError('暂时未能完成操作。请查看处理说明后再重试，不要重复点击。') }
    finally { lock.current = false; setPending(false) }
  }
  React.useEffect(() => setError(''), [view?.operation_id, guidance?.headline])
  return <section className="action-guidance" data-ai-id="action-guidance" aria-label="现在该做什么" aria-busy={loading || pending}>
    <h3 aria-live="polite" aria-atomic="true">{guidance?.headline ?? (failed ? '暂时无法读取进度，请重新读取。' : '正在读取进度，请稍候。')}</h3>
    {guidance?.detail && <p>{guidance.detail}</p>}
    <div className="action-guidance-actions">
      {override ? override.actions : (failed || view?.execution.status === 'unavailable'
        ? <button type="button" className="studio-primary" onClick={onRefresh} disabled={loading}>重新读取进度</button>
        : view?.guidance?.action && <button type="button" className="studio-primary" onClick={() => void perform()} disabled={pending || busy || loading}>{pending ? '正在处理…' : view.guidance.action_label}</button>)}
      <button type="button" className="theatre-tool" onClick={onRecords}>查看过程</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>
}
