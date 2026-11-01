// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CollaborationPanel } from '../../renderer/components/CollaborationPanel'
import { activeAgentSessionIdAtom, collaborationPanelExpandedAtom, currentProjectAtom, delegationsFamily } from '../../renderer/components/atoms'
import type { ElectronAPI, Project } from '../../shared/types'
afterEach(() => { cleanup(); delete window.electronAPI })
function setup(loadMessages: ReturnType<typeof vi.fn>) {
  const store = createStore()
  store.set(currentProjectAtom, { project_id: 'p', name: '项目' } as Project)
  store.set(activeAgentSessionIdAtom, 'parent')
  store.set(collaborationPanelExpandedAtom, true)
  store.set(delegationsFamily('parent'), [{ delegation_id: 'd', child_session_id: 'child', role: 'code', goal: '检查记录', status: 'completed' }])
  window.electronAPI = { agent: { loadMessages } } as unknown as ElectronAPI
  render(<Provider store={store}><CollaborationPanel embedded /></Provider>)
  fireEvent.click(screen.getByRole('button', { name: '查看详情' }))
  fireEvent.click(screen.getByRole('button', { name: '查看执行过程与结果' }))
  return store
}
it('reads full child history without switching the parent and returns to its delegation', async () => {
  const data = { session: { project_id: 'p' }, messages: [{ role: 'assistant', content: [{ type: 'text', text: '实际检查结果' }] }], total: 230, truncated: true }
  const load = vi.fn().mockResolvedValueOnce({ ok: true, data }).mockResolvedValueOnce({ ok: true, data: { ...data, truncated: false } })
  const store = setup(load)
  await screen.findByText('实际检查结果')
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ session_id: 'child', limit: 230 }))
  expect(store.get(activeAgentSessionIdAtom)).toBe('parent')
  fireEvent.click(screen.getByRole('button', { name: '返回协作详情' }))
  expect(screen.getByText('目标：检查记录')).toBeTruthy()
})
it('reports missing records and allows a read-only retry', async () => {
  const load = vi.fn().mockResolvedValue({ ok: false, error: { message: '子会话不存在或已归档' } })
  setup(load)
  expect((await screen.findByRole('alert')).textContent).toContain('不存在或已归档')
  fireEvent.click(screen.getByRole('button', { name: '刷新记录' }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
})
it('does not display a record from a different project', async () => {
  setup(vi.fn().mockResolvedValue({ ok: true, data: { session: { project_id: 'other' }, messages: [], truncated: false } }))
  expect((await screen.findByRole('alert')).textContent).toContain('不属于当前项目')
})
