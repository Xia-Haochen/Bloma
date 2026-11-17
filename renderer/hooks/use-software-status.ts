import React from 'react'
import type { SoftwareStatusView } from '../../shared/types'

/** Bounded read-only IPC. No model call, verification or launch is performed here. */
export function useSoftwareStatus(projectId: string | undefined, operationId: string | undefined, change: string, busy: boolean) {
  const [snapshot, setSnapshot] = React.useState<{ project: string; operation?: string; view: SoftwareStatusView }>()
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [revision, refresh] = React.useReducer(n => n + 1, 0)
  const generation = React.useRef(0)
  React.useEffect(() => {
    const sequence = ++generation.current
    let disposed = false
    let requested = 0
    setLoading(true); setFailed(false)
    const read = async () => {
      const ticket = ++requested
      const api = window.electronAPI?.projectDeliverables
      if (!projectId || !api) { if (!disposed) { setLoading(false); setFailed(true) }; return }
      try {
        const result = await api.get({ request_id: crypto.randomUUID(), project_id: projectId, status_only: true })
        if (disposed || sequence !== generation.current || ticket !== requested) return
        if (!result.ok || !result.data.status_view) throw Error('STATUS_UNAVAILABLE')
        setSnapshot({ project: projectId, operation: operationId, view: result.data.status_view }); setFailed(false)
      } catch { if (!disposed && sequence === generation.current && ticket === requested) setFailed(true) }
      finally { if (!disposed && sequence === generation.current && ticket === requested) setLoading(false) }
    }
    const timer = setTimeout(() => void read(), 180)
    // Terminal events can precede the host's finally block. A bounded follow-up reads
    // persisted end-state after it releases the run; no per-token polling.
    const settled = setTimeout(() => void read(), 1100)
    const poll = busy ? setInterval(() => void read(), 2500) : undefined
    return () => { disposed = true; clearTimeout(timer); clearTimeout(settled); clearInterval(poll) }
  }, [projectId, operationId, change, busy, revision])
  return { view: !failed && snapshot && snapshot.project === projectId && snapshot.operation === operationId ? snapshot.view : undefined, loading, failed, refresh }
}
