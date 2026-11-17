// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSoftwareStatus } from '../../renderer/hooks/use-software-status'
const response = (name: string) => ({ ok: true, data: { status_view: { execution: { status: name, label: name }, verification: { status: 'not_run', label: '' }, goal: { status: 'not_delivered', label: '' }, active_commands: 0 } } })
afterEach(() => { cleanup(); vi.useRealTimers(); delete window.electronAPI })
it('rejects a late snapshot from the previous project and only uses the bounded read-only IPC', async () => {
  vi.useFakeTimers()
  const resolves: ((value: unknown) => void)[] = []
  const get = vi.fn(() => new Promise(resolve => resolves.push(resolve)))
  window.electronAPI = { projectDeliverables: { get } } as never
  const hook = renderHook(({ project }) => useSoftwareStatus(project, 'op', 'event', false), { initialProps: { project: 'one' } })
  await act(async () => { vi.advanceTimersByTime(180) })
  hook.rerender({ project: 'two' })
  await act(async () => { vi.advanceTimersByTime(180) })
  await act(async () => { resolves[1](response('new')); resolves[0](response('stale')) })
  expect(hook.result.current.view?.execution.status).toBe('new')
  expect(get.mock.calls.map(call => (call as unknown as [{status_only:boolean}])[0].status_only)).toEqual([true,true])
})
it('rejects a late earlier poll of the SAME project; ordinary rerenders do not cause per-token reads', async () => {
  vi.useFakeTimers()
  const resolves: ((value: unknown) => void)[] = []
  const get = vi.fn(() => new Promise(resolve => resolves.push(resolve)))
  window.electronAPI = { projectDeliverables: { get } } as never
  const hook = renderHook(() => useSoftwareStatus('one', 'op', 'state-event', true))
  await act(async () => { vi.advanceTimersByTime(180) })
  for (let index=0;index<100;index++) hook.rerender()
  expect(get).toHaveBeenCalledTimes(1)
  await act(async () => { vi.advanceTimersByTime(920) })
  await act(async () => { resolves[1](response('ended')); resolves[0](response('old-running')) })
  expect(hook.result.current.view?.execution.status).toBe('ended')
})
