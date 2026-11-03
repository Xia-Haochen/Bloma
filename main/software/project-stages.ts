import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { parseGuiSuite, type GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import { freezeNativeGuiTests, type NativeGuiTests } from './native-gui-tests'
import { runNativeGuiTests } from './native-gui-observer'
import { prepareSoftwareRelease, verifyReleaseSource } from './release-store'
import { runSecurityScan } from '../verification/security-scan'
import { recordEvaluationEvent } from './harness-evaluation'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { validateProjectPlan } from './project-plan'
import { stageContractChanges, stageContractError } from './stage-contracts'

interface StageAttempt { id: string; stage: string; scope: string; source: string; status: 'running'|'passed'|'failed'|'unverified';
  covers: string[]; executed?: boolean; native: NativeGuiTests; candidate?: string; report?: string; report_hash?: string; at: string; error?: string }
interface StageState { version: 1; revision: number; attempts: StageAttempt[] }
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function folder(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('PROJECT_STAGE_ID_INVALID')
  return join(getPromaHome(), 'software-stage-checks', id)
}
export function readProjectStages(id: string): StageState {
  const file = join(folder(id), 'state.json')
  if (!existsSync(file)) return { version: 1, revision: 0, attempts: [] }
  const { checksum, ...state } = JSON.parse(readFileSync(file, 'utf8')) as StageState & { checksum: string }
  if (state.version !== 1 || !Array.isArray(state.attempts) || !Number.isSafeInteger(state.revision) || checksum !== sha(state)) throw Error('PROJECT_STAGE_STATE_CORRUPT')
  return state
}
function save(id: string, state: StageState) {
  if (readProjectStages(id).revision !== state.revision) throw Error('PROJECT_STAGE_STATE_STALE')
  if (state.attempts.length > 2000) throw Error('PROJECT_STAGE_HISTORY_LIMIT')
  state.revision++
  writeTextFileAtomic(join(folder(id), 'state.json'), JSON.stringify({ ...state, checksum: sha(state) }))
}
export function projectStageView(id: string) {
  const brief = readPrdBackplane(id), scope = prdScopeFingerprint(brief)
  const plan = validateProjectPlan(brief.project_plan, brief.requirements.map(r => r.id))
  if (!plan) return { enabled: false, stages: [], next_stage: null }
  const state = readProjectStages(id), source = softwareVerificationFingerprint(findProject(id).root_path)
  const stages = plan.stages.map((stage, index) => {
    const latest = state.attempts.filter(a => a.scope === scope && a.stage === stage.id).at(-1)
    return { ...stage, cumulative_feature_ids: plan.stages.slice(0, index + 1).flatMap(s => s.feature_ids),
      status: latest?.status ?? 'not_run', source_matches: latest ? latest.source === source : false, candidate: latest?.candidate, report: latest?.report }
  })
  const next = stages.find(s => s.status !== 'passed') ?? (stages.at(-1)?.source_matches ? undefined : stages.at(-1))
  return { enabled: true, stages, next_stage: next?.id ?? null,
    note: '阶段通过仅证明对应快照上的累计局部案例；不是完整验收或发布。下一阶段必须保留此前案例，最终仍走全部需求与C/V检查。' }
}
const active = new Set<string>()
/** Partial checks do not overwrite the formal GUI suite or weaken its full coverage. */
export async function verifyProjectStage(id: string, stageId: string, script: string, signal: AbortSignal, restart = false) {
  signal.throwIfAborted()
  if (active.has(id)) throw Error('PROJECT_STAGE_ALREADY_RUNNING')
  const project = findProject(id), brief = readPrdBackplane(id), scope = prdScopeFingerprint(brief)
  if (project.workflow_version !== 'software-v1' || !brief.user_confirmed_at || ['archived','abandoned'].includes(project.status)) throw Error('PROJECT_STAGE_CONFIRMED_SCOPE_REQUIRED')
  readConfirmedUxBinding(id, brief)
  const view = projectStageView(id), stage = view.stages.find(s => s.id === stageId)
  if (!stage || view.next_stage !== stageId) throw Error('PROJECT_STAGE_ORDER_REQUIRED')
  const native = freezeNativeGuiTests(id, project.root_path, script, stage.cumulative_feature_ids, restart)
  const state = readProjectStages(id)
  // Keep every previously executed contract in this scope, including failed attempts.
  for (const old of state.attempts.filter(a => a.scope === scope && a.executed !== false)) {
    const changes = stageContractChanges(id, project.root_path, old.native, native)
    if (changes.length) throw stageContractError(id, old.native, changes)
  }
  const source = softwareVerificationFingerprint(project.root_path)
  if (!source) throw Error('PROJECT_STAGE_SOURCE_REQUIRED')
  const attempt: StageAttempt = { id: randomUUID(), stage: stageId, scope, source, status: 'running', executed: false, covers: stage.cumulative_feature_ids, native, at: new Date().toISOString() }
  state.attempts.push(attempt); save(id, state); active.add(id)
  recordEvaluationEvent(id, 'stage_check_started', { stage: stageId, attempt: attempt.id, covers: attempt.covers })
  try {
    const candidate = await prepareSoftwareRelease(id, project.root_path, signal)
    attempt.candidate = candidate.id
    if (!['browser','electron'].includes(candidate.launch.ui ?? '')) throw Error('PROJECT_STAGE_NATIVE_GUI_REQUIRED')
    const security = runSecurityScan({ project_id: id, root_path: candidate.root, profile: 'local-software' })
    if (!security.passed) throw Error('PROJECT_STAGE_SECURITY_FAILED')
    const suite: GuiAcceptanceSuite = parseGuiSuite({ version: 1, scope_hash: scope, design_hash: project.ux_confirmation?.design_hash, covers: attempt.covers, steps: [], native_tests: native })
    attempt.executed = true; save(id, state)
    const result = await runNativeGuiTests({ projectId: id, root: candidate.root, launch: candidate.launch, suite, signal })
    attempt.executed = (result.native_evidence?.assertions ?? 0) > 0
    signal.throwIfAborted(); await verifyReleaseSource(candidate, signal)
    if (prdScopeFingerprint(readPrdBackplane(id)) !== scope || softwareVerificationFingerprint(project.root_path) !== source) throw Error('PROJECT_STAGE_INPUT_CHANGED')
    attempt.status = result.status
    attempt.report = join(folder(id), `${attempt.id}.json`)
    writeTextFileAtomic(attempt.report, JSON.stringify({ ...result, scope, source, candidate: candidate.id, stage: stageId, covers: attempt.covers, verified_scope: 'partial_cumulative_gui' }))
    attempt.report_hash = createHash('sha256').update(readFileSync(attempt.report)).digest('hex')
    attempt.error = result.error
  } catch (error) {
    attempt.status = 'unverified'; attempt.error = String(error).slice(0, 2000)
  } finally {
    if (signal.aborted) { attempt.status = 'unverified'; attempt.error = 'cancelled' }
    try { save(id, state); recordEvaluationEvent(id, 'stage_check_finished', { stage: stageId, status: attempt.status, candidate: attempt.candidate }) }
    finally { active.delete(id) }
  }
  return { status: attempt.status, report: attempt.report, error: attempt.error, ...projectStageView(id) }
}

/** Final registration retains partial contracts too; changing a requirement is explicit scope revision. */
export function assertStageContractsRetained(id: string, native: NativeGuiTests) {
  const scope = prdScopeFingerprint(readPrdBackplane(id))
  for (const attempt of readProjectStages(id).attempts.filter(a => a.scope === scope && a.executed !== false)) {
    const changes = stageContractChanges(id, findProject(id).root_path, attempt.native, native)
    if (changes.length) throw stageContractError(id, attempt.native, changes)
  }
}

/** An earlier partial snapshot stays usable even when later working files are broken. */
export function latestCheckedStageCandidate(id: string): string | undefined {
  const scope = prdScopeFingerprint(readPrdBackplane(id))
  const attempt = readProjectStages(id).attempts.filter(a => a.scope === scope && a.status === 'passed').at(-1)
  if (!attempt) return
  if (!attempt.report || !attempt.report_hash || !attempt.candidate) throw Error('PROJECT_STAGE_EVIDENCE_MISSING')
  const bytes = readFileSync(attempt.report), report = JSON.parse(bytes.toString('utf8'))
  if (createHash('sha256').update(bytes).digest('hex') !== attempt.report_hash || report.status !== 'passed'
    || report.scope !== scope || report.candidate !== attempt.candidate) throw Error('PROJECT_STAGE_REPORT_CHANGED')
  return attempt.candidate
}
