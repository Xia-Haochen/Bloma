import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { leanBudget } from '../desktop/lean-budget'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { redactSoftwareOutput } from './process-manager'
import type { SoftwareRunStatus } from './run-state'

interface Assignment { id: string; session: string; lease: string; started_at: string; status: SoftwareRunStatus; source?: string;
  candidate?: string; report?: { path: string; sha256: string }; error?: string }
interface Task { id: string; scope: string; operation: string; goal: string; feature_ids: string[]; current: string; assignments: Assignment[] }
interface Tasks { version: 1; revision: number; tasks: Task[] }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function path(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('TASK_PROJECT_INVALID')
  return join(getPromaHome(), 'software-tasks', `${id}.json`)
}
export function readProjectTasks(id: string): Tasks {
  const file = path(id)
  if (!existsSync(file)) return { version: 1, revision: 0, tasks: [] }
  const { checksum, ...state } = JSON.parse(readFileSync(file, 'utf8')) as Tasks & { checksum: string }
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.tasks) || checksum !== hash(state)
    || state.tasks.some(t => !t.assignments.some(a => a.id === t.current))) throw Error('TASK_STORE_CORRUPT')
  return state
}
function save(id: string, state: Tasks) {
  if (readProjectTasks(id).revision !== state.revision) throw Error('TASK_STATE_STALE')
  if (state.tasks.length > 1000 || state.tasks.some(t => t.assignments.length > 1000)) throw Error('TASK_HISTORY_LIMIT')
  state.revision++
  writeTextFileAtomic(path(id), JSON.stringify({ ...state, checksum: hash(state) }))
}

/** Host-only admission after acquiring the existing operation lease. No model tool grants this. */
export function beginProjectAssignment(projectId: string, session: string, run: string) {
  const project = findProject(projectId), brief = readPrdBackplane(projectId)
  const budget = leanBudget(projectId, 'desktop-implement').snapshot()
  if (project.workflow_version !== 'software-v1' || !brief.user_confirmed_at || !budget.runtimeOwner || budget.runtimePid !== process.pid
    || !session || !run) throw Error('TASK_EXECUTION_LEASE_REQUIRED')
  const scope = prdScopeFingerprint(brief), operation = project.lean_operation_id ?? 'initial', id = hash([projectId, operation, scope])
  const state = readProjectTasks(projectId)
  let task = state.tasks.find(t => t.id === id)
  if (!task) { task = { id, scope, operation, goal: brief.positioning, feature_ids: brief.requirements.map(r => r.id), current: run, assignments: [] }; state.tasks.push(task) }
  const previous = task.assignments.find(a => a.id === task!.current)
  if (task.assignments.some(a => a.id === run)) throw Error('TASK_ATTEMPT_ALREADY_EXISTS')
  if (previous?.lease === budget.runtimeOwner) throw Error('TASK_ASSIGNMENT_ALREADY_ACTIVE')
  if (previous && ['running', 'repairing', 'verifying'].includes(previous.status)) previous.status = 'interrupted'
  task.current = run
  task.assignments.push({ id: run, session, lease: budget.runtimeOwner, status: 'running', started_at: new Date().toISOString(), source: softwareVerificationFingerprint(project.root_path) })
  save(projectId, state)
  return {
    task_id: id, assignment_id: run,
    checkpoint(status: SoftwareRunStatus, patch: { source?: string; candidateId?: string; error?: string; check?: { path: string; sha256: string } } = {}) {
      const currentProject = findProject(projectId), currentBrief = readPrdBackplane(projectId)
      if (['running','verifying','repairing','verified'].includes(status) && ((currentProject.lean_operation_id ?? 'initial') !== operation || prdScopeFingerprint(currentBrief) !== scope)) throw Error('TASK_SCOPE_CHANGED')
      const next = readProjectTasks(projectId), currentTask = next.tasks.find(t => t.id === id)
      const attempt = currentTask?.assignments.find(a => a.id === run)
      if (currentTask?.current !== run || !attempt || attempt.session !== session) throw Error('TASK_ASSIGNMENT_STALE')
      if (['cancelled', 'interrupted'].includes(attempt.status) && status !== attempt.status) throw Error('TASK_ASSIGNMENT_ENDED')
      if (status === 'verified') {
        if (!patch.check || !patch.candidateId || !patch.source || patch.source !== softwareVerificationFingerprint(currentProject.root_path)) throw Error('TASK_HOST_EVIDENCE_REQUIRED')
        const bytes = readFileSync(patch.check.path)
        if (JSON.parse(bytes.toString('utf8')).status !== 'passed' || createHash('sha256').update(bytes).digest('hex') !== patch.check.sha256) throw Error('TASK_REPORT_CHANGED')
        // Caller is the host completion path, after candidate/C/V/source guards.
      }
      attempt.status = status
      if (patch.source) attempt.source = patch.source
      if (patch.candidateId) attempt.candidate = patch.candidateId
      if (patch.check) attempt.report = patch.check
      if (patch.error) attempt.error = redactSoftwareOutput(patch.error).slice(0, 1600)
      save(projectId, next)
    },
  }
}

export function projectTaskView(projectId: string, offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('TASK_PAGE_INVALID')
  const state = readProjectTasks(projectId), project = findProject(projectId), scope = prdScopeFingerprint(readPrdBackplane(projectId))
  return { revision: state.revision, tasks: state.tasks.slice(offset, offset + limit).map(t => ({
    ...t, assignments: t.assignments.slice(-10), assignment_count: t.assignments.length,
    current_scope: t.scope === scope && t.operation === (project.lean_operation_id ?? 'initial'),
    note: '运行状态及报告属于记录版本；当前源码变化后必须重新验证。',
  })), next_offset: offset + limit < state.tasks.length ? offset + limit : null }
}
