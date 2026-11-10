import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn() }, app: { isPackaged: false }, BrowserWindow: class {} }))
import { softwareGuidance, softwareStatusView } from '../../../main/software/state-view'
import { createProject } from '../../../main/project/project-service'
import { saveSoftwareRunState } from '../../../main/software/run-state'
import { registerProjectDeliverablesIpc } from '../../../main/ipc/project-deliverables'
import { IPC_CHANNELS } from '../../../shared/types'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { configureSoftwareExecutionLimits } from '../../../main/software/execution-limits'
let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-action-guidance-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
it('uses host goal, not old PASS or maker claims; running and confirmation need no bogus continue', () => {
  expect(softwareGuidance('running', 'not_delivered').action).toBeUndefined()
  expect(softwareGuidance('blocked', 'not_delivered').headline).toContain('没完成')
  expect(softwareGuidance('ended', 'delivered').action).toBe('open')
  expect(softwareGuidance('waiting_user', 'not_delivered').action).toBe('inspect')
  expect(softwareGuidance('unavailable', 'delivered').headline).toContain('无法读取')
  expect(softwareGuidance('running', 'not_delivered', undefined, true).action).not.toBe('continue')
})
it.each(['HARNESS_OUTPUT_BUDGET_EXHAUSTED', 'HARNESS_REQUEST_BUDGET_EXHAUSTED', 'FUNDING_INSUFFICIENT', 'GENERATION_PAUSED'])('does not offer impossible or unauthorised continuation for %s', reason => {
  expect(softwareGuidance('blocked', 'not_delivered', reason).action).toBe('inspect')
})
it('only a current readable internal allowance can change a historical budget hint, not grant money', () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  configureSoftwareExecutionLimits(project.project_id, project.lean_operation_id ?? 'initial', { requests: 2, output: 1024, reason: 'isolated test' })
  const budget = leanBudget(project.project_id, 'desktop-implement')
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(budget.snapshot().file, JSON.stringify({ version: 1, requests: 2, output: 1024, phases: { 'desktop-implement': 2 } }))
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'r', status: 'blocked', error: 'HARNESS_OUTPUT_BUDGET_EXHAUSTED' })
  expect(softwareStatusView(project.project_id, false).guidance?.action).toBe('inspect')
  const before = readFileSync(budget.snapshot().file, 'utf8')
  configureSoftwareExecutionLimits(project.project_id, project.lean_operation_id ?? 'initial', { requests: 4, output: 2048, reason: 'isolated approved allowance increase' })
  const hint = softwareStatusView(project.project_id, false).guidance!
  expect(hint.action).toBe('continue'); expect(hint.detail).toContain('仍会检查费用')
  expect(readFileSync(budget.snapshot().file, 'utf8')).toBe(before)
})
it('status-only actual IPC is read-only, omits file inventory/launch inspection, and respects corrupt state', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'r', status: 'blocked', error: 'QUALITY_FINDING_REPRODUCTION_REQUIRED' })
  const handlers = new Map<string, (...args: unknown[]) => Promise<any>>()
  registerProjectDeliverablesIpc({ handle: (name: string, handler: (...args: unknown[]) => Promise<any>) => handlers.set(name, handler) } as never, {} as never)
  const runPath = join(home, 'software-run-states', project.project_id + '.json')
  const before = readFileSync(runPath, 'utf8'); const folders = readdirSync(home)
  const call = () => handlers.get(IPC_CHANNELS.PROJECT_DELIVERABLES)!({}, { project_id: project.project_id, request_id: 'read-only', status_only: true })
  const result = await call()
  expect(result.ok).toBe(true); expect(result.data.files).toEqual([]); expect(result.data.can_launch).toBe(false)
  expect(result.data.status_view.guidance.action).toBe('continue')
  expect(readFileSync(runPath, 'utf8')).toBe(before); expect(readdirSync(home)).toEqual(folders)
  writeFileSync(runPath, '{broken')
  const broken = await call()
  expect(broken.data.status_view.execution.status).toBe('unavailable')
  expect(broken.data.status_view.guidance.action).not.toBe('continue')
})
