import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { readPrdBackplane } from '../project/prd-store'
import { redactSoftwareOutput } from './process-manager'

interface Activity { version: 1; revision: number; events: Array<{ seq: number; at: number; kind: string; operation: string; scope: string; data: unknown }> }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function path(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw Error('PROJECT_ACTIVITY_ID_INVALID')
  return join(getPromaHome(), 'software-project-activity', id + '.json')
}
export function readProjectActivity(id: string): Activity {
  const file = path(id)
  if (!existsSync(file)) return { version: 1, revision: 0, events: [] }
  const { checksum, ...state } = JSON.parse(readFileSync(file, 'utf8')) as Activity & { checksum: string }
  if (state.version !== 1 || !Array.isArray(state.events) || state.revision !== state.events.length || checksum !== hash(state)
    || state.events.some((e, i) => e.seq !== i + 1)) throw Error('PROJECT_ACTIVITY_CORRUPT')
  return state
}
/** Observational only: never grants execution, spending or delivery. */
export function recordProjectActivity(id: string, kind: string, data: unknown, at = Date.now()) {
  try {
    const project = findProject(id)
    if (project.workflow_version !== 'software-v1') return false
    const state = readProjectActivity(id)
    if (state.events.length >= 20000) throw Error('PROJECT_ACTIVITY_LIMIT')
    const text = redactSoftwareOutput(JSON.stringify(data))
    const safe = text.length <= 24000 ? JSON.parse(text) : { truncated: true, content_sha256: hash(data) }
    state.events.push({ seq: ++state.revision, at, kind, operation: project.lean_operation_id ?? 'initial', scope: prdScopeFingerprint(readPrdBackplane(id)), data: safe })
    writeTextFileAtomic(path(id), JSON.stringify({ ...state, checksum: hash(state) }))
    return true
  } catch { return false } // corrupt evidence stays corrupt; never replaces it with empty success
}

export function projectActivityView(id: string, offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('PROJECT_ACTIVITY_PAGE_INVALID')
  const state = readProjectActivity(id)
  const profiles = state.events.filter(e => e.kind === 'runtime_identity').map(e => {
    const d = e.data as { observation?: { role?: string; route?: unknown; settings?: unknown; prompt_sha256?: string; tools_sha256?: string } }
    return { e, o: d.observation }
  }).filter(({ o }) => o?.role === 'orchestrator')
  const segments: Array<{ revision: string; first_seq: number; last_seq: number; operation: string; scope: string }> = []
  for (const { e, o } of profiles) {
    const revision = hash([o?.route, o?.settings, o?.prompt_sha256, o?.tools_sha256])
    const last = segments.at(-1)
    if (last?.revision === revision && last.operation === e.operation && last.scope === e.scope) last.last_seq = e.seq
    else segments.push({ revision, first_seq: e.seq, last_seq: e.seq, operation: e.operation, scope: e.scope })
  }
  return { revision: state.revision, items: state.events.slice(offset, offset + limit),
    next_offset: offset + limit < state.events.length ? offset + limit : null,
    strategy_segments: segments.slice(-50), segment_count: segments.length,
    fixed_strategy_observed: segments.length === 1, provider_parameter_acceptance: 'unknown',
    note: '记录观测到的配置和活动；没有完整模型回执不推断服务端采纳参数。阶段delivery事件不是项目整体完成证明。' }
}
