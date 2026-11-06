/** Host-owned project history. software-v1 uses cancellable checkpoints and
 * requires success. Legacy snapshot/worktree callers retain their opt-in API;
 * that historical switch cannot disable the current production baseline. */
import { execFile, spawnSync, type ExecFileException } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** 开关解析（与 iterationBriefEnabled 同风格，每次调用读取）。 */
export function projectGitEnabled(): boolean {
  const raw = (process.env.BLOMA_PROJECT_GIT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

let gitProbe: boolean | null = null

/** git 可用性探测（进程内缓存一次；测试可用 resetGitProbeForTests 重置）。 */
export function gitAvailable(): boolean {
  if (gitProbe === null) {
    try {
      const r = spawnSync('git', ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' })
      gitProbe = r.status === 0
    } catch {
      gitProbe = false
    }
  }
  return gitProbe
}

export function resetGitProbeForTests(): void {
  gitProbe = null
}

/** .gitignore 追加行（真实数据与备份目录绝不进 git——回滚/升级各有自己的语义线）。 */
export const PROJECT_GITIGNORE_LINES = ['data/', 'data-backups/', 'node_modules/', 'dist/', '*.log', '.DS_Store'] as const

const GITATTRIBUTES = '* text=auto eol=lf\n'

export interface ProjectGitEvent {
  kind: string
  summary: string
  stage?: string
  taskId?: string
}

export interface ProjectGitResult {
  ok: boolean
  committed?: boolean
  commit?: string
  reason?: string
}

function runGit(root: string, args: string[]) {
  return spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args], { cwd: root, timeout: 15000, windowsHide: true, encoding: 'utf8' })
}

/** Host checkpoints use a private index and branch. An imported repository's
 * HEAD, staging area and original directory remain owned by the user. */
const HISTORY_REF = 'refs/heads/bloma-history'
export const PROJECT_HISTORY_EXCLUDES = ['.git', 'data', 'data-backups', 'node_modules', '.venv', 'venv', '.cache', '__pycache__', '00_HISTORY', '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.log']

function historyGit(root: string, args: string[], signal?: AbortSignal, input?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  signal?.throwIfAborted()
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key]
  return new Promise<{ status: number; stdout: string; stderr: string; error?: ExecFileException }>(resolveResult => {
    const child = execFile('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, env: { ...env, ...extraEnv }, signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => resolveResult({ status: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr, error: error ?? undefined }))
    child.stdin?.on('error', () => { /* execFile's completion reports process/abort failures */ })
    child.stdin?.end(input)
  })
}

export async function checkpointProjectHistory(projectRoot: string, event: ProjectGitEvent, signal?: AbortSignal): Promise<ProjectGitResult> {
  let temporary: string | undefined
  try {
    signal?.throwIfAborted()
    if (!existsSync(projectRoot)) return { ok: false, reason: 'root_missing' }
    const root = realpathSync(projectRoot)
    const run = (args: string[]) => historyGit(root, args, signal)
    const top = await run(['rev-parse', '--show-toplevel'])
    if (top.error?.code === 'ENOENT') return { ok: false, reason: 'git_missing' }
    signal?.throwIfAborted()
    if (top.status === 0 && realpathSync(top.stdout.trim()) !== root) return { ok: false, reason: 'parent_repository_not_owned' }
    const created = top.status !== 0
    if (created) {
      if (existsSync(join(root, '.git'))) return { ok: false, reason: 'repository_unreadable' }
      const init = await run(['init', '--initial-branch=main'])
      if (init.status !== 0) return { ok: false, reason: 'init_failed' }
    }
    // A named branch supplied by an imported project is not ours to advance.
    const owner = await run(['config', '--local', '--get', 'bloma.historyRef'])
    const prior = await run(['rev-parse', '--verify', HISTORY_REF])
    if (prior.status === 0 && owner.stdout.trim() !== HISTORY_REF) return { ok: false, reason: 'history_ref_not_owned' }
    if ((await run(['symbolic-ref', '-q', 'HEAD'])).stdout.trim() === HISTORY_REF) return { ok: false, reason: 'history_branch_checked_out' }
    if ((await run(['config', '--local', 'bloma.historyRef', HISTORY_REF])).status !== 0) return { ok: false, reason: 'config_failed' }
    const excludeResult = await run(['rev-parse', '--git-path', 'info/exclude'])
    if (excludeResult.status !== 0) return { ok: false, reason: 'exclude_path_unavailable' }
    const excludePath = resolve(root, excludeResult.stdout.trim())
    if (existsSync(excludePath) && !lstatSync(excludePath).isFile()) return { ok: false, reason: 'exclude_not_regular_file' }
    const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    const missing = PROJECT_HISTORY_EXCLUDES.filter(pattern => !exclude.split(/\r?\n/).includes(pattern))
    if (missing.length) { mkdirSync(dirname(excludePath), { recursive: true }); writeFileSync(excludePath, exclude + (exclude.endsWith('\n') || !exclude ? '' : '\n') + missing.join('\n') + '\n') }
    temporary = mkdtempSync(join(tmpdir(), 'bloma-history-'))
    const env = { GIT_INDEX_FILE: join(temporary, 'index'), GIT_AUTHOR_NAME: 'Bloma', GIT_AUTHOR_EMAIL: 'bloma@local', GIT_COMMITTER_NAME: 'Bloma', GIT_COMMITTER_EMAIL: 'bloma@local' }
    const git = async (args: string[], input?: string) => {
      const result = await historyGit(root, args, signal, input, env)
      signal?.throwIfAborted()
      if (result.status !== 0) throw Error(`git_${args[0]}_failed:${String(result.stderr || result.error || '').slice(0, 300)}`)
      return result.stdout.trim()
    }
    await git(['read-tree', '--empty'])
    await git(['add', '-A', '--', '.', ...PROJECT_HISTORY_EXCLUDES.map(path => `:(exclude,glob)**/${path}/**`),
      ...PROJECT_HISTORY_EXCLUDES.map(path => `:(exclude,glob)**/${path}`)])
    const tree = await git(['write-tree']), previous = prior.status === 0 ? prior.stdout.trim() : undefined
    const head = await run(['rev-parse', '--verify', 'HEAD'])
    const unchanged = Boolean(previous && await git(['rev-parse', `${previous}^{tree}`]) === tree)
    const parent = previous ?? (head.status === 0 ? head.stdout.trim() : undefined)
    const commit = unchanged ? previous! : await git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], `[bloma:${oneLine(event.kind)}] ${oneLine(event.summary)}\n`)
    if (!unchanged) await git(['update-ref', HISTORY_REF, commit, previous ?? '0'.repeat(commit.length)])
    // An interrupted first initialization can finish without overwriting any
    // existing user index. Later checkpoints leave HEAD and staging untouched.
    const actualIndex = await run(['rev-parse', '--git-path', 'index'])
    if (actualIndex.status !== 0) throw Error('index_path_unavailable')
    const indexPath = resolve(root, actualIndex.stdout.trim())
    if (created || head.status !== 0 && !existsSync(indexPath)) {
      await git(['update-ref', 'HEAD', commit, '0'.repeat(commit.length)])
    }
    if (!existsSync(indexPath) && (created || head.status !== 0 || head.stdout.trim() === previous)) {
      const index = await run(['read-tree', 'HEAD'])
      if (index.status !== 0) throw Error('initial_index_failed')
    }
    return { ok: true, committed: !unchanged, commit, ...(unchanged ? { reason: 'nothing_to_commit' } : {}) }
  } catch (error) {
    return { ok: false, reason: String(error).slice(0, 500) }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}

export async function requireProjectCheckpoint(root: string, event: ProjectGitEvent, signal?: AbortSignal): Promise<string> {
  const result = await checkpointProjectHistory(root, event, signal)
  if (!result.ok || !result.commit) throw Error(`PROJECT_HISTORY_UNAVAILABLE: ${result.reason ?? 'commit_missing'}`)
  return result.commit
}

/** 单行化 summary（压制换行与超长，commit message 首行可读）。 */
function oneLine(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 197) + '...' : flat
}

/** 幂等 init：.git 不存在则建；.gitignore 缺行则补（保留用户手写行）；autocrlf=false 统一 LF。 */
export function ensureProjectRepo(projectRoot: string): ProjectGitResult {
  try {
    if (!projectGitEnabled()) return { ok: false, reason: 'disabled' }
    if (!existsSync(projectRoot)) return { ok: false, reason: 'root_missing' }
    if (!gitAvailable()) return { ok: false, reason: 'git_missing' }
    const gitDir = join(projectRoot, '.git')
    if (!existsSync(gitDir)) {
      const init = runGit(projectRoot, ['init'])
      if (init.status !== 0) return { ok: false, reason: `init_failed:${String(init.stderr).slice(0, 120)}` }
    }
    const cfg = runGit(projectRoot, ['config', 'core.autocrlf', 'false'])
    if (cfg.status !== 0) return { ok: false, reason: 'config_failed' }
    // commit 身份兑底：机器无全局 user.email 时 commit 必败（fail-open 不允许）——
    // 探测为空则写入仓库局部身份（不碰全局配置）。
    const email = runGit(projectRoot, ['config', 'user.email'])
    if (email.status !== 0 || !String(email.stdout ?? '').trim()) {
      const setId = runGit(projectRoot, ['config', 'user.email', 'bloma@local'])
      const setName = runGit(projectRoot, ['config', 'user.name', 'Bloma'])
      if (setId.status !== 0 || setName.status !== 0) return { ok: false, reason: 'identity_failed' }
    }
    const ignorePath = join(projectRoot, '.gitignore')
    let existing = ''
    if (existsSync(ignorePath)) existing = readFileSync(ignorePath, 'utf8')
    const lines = existing.split(/\r?\n/).map((l) => l.trim())
    const missing = PROJECT_GITIGNORE_LINES.filter((l) => !lines.includes(l))
    if (missing.length > 0 || existing === '') {
      const next = existing === '' ? [...PROJECT_GITIGNORE_LINES].join('\n') + '\n' : existing.replace(/\s*$/, '\n') + missing.join('\n') + '\n'
      writeFileSync(ignorePath, next, 'utf8')
    }
    const attrPath = join(projectRoot, '.gitattributes')
    if (!existsSync(attrPath)) writeFileSync(attrPath, GITATTRIBUTES, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `error:${String((err as Error)?.message ?? err).slice(0, 120)}` }
  }
}

/** 生命周期事件提交：无变更如实 nothing_to_commit；失败 fail-open 返回 reason。 */
export function commitProjectState(projectRoot: string, event: ProjectGitEvent): ProjectGitResult {
  try {
    const ensure = ensureProjectRepo(projectRoot)
    if (!ensure.ok) return ensure
    const status = runGit(projectRoot, ['status', '--porcelain'])
    if (status.status !== 0) return { ok: false, reason: 'status_failed' }
    if (!String(status.stdout ?? '').trim()) return { ok: true, committed: false, reason: 'nothing_to_commit' }
    const add = runGit(projectRoot, ['add', '-A'])
    if (add.status !== 0) return { ok: false, reason: 'add_failed' }
    const message = [
      `[bloma:${event.kind}] ${oneLine(event.summary)}`,
      event.stage ? `stage: ${oneLine(event.stage)}` : null,
      event.taskId ? `task: ${oneLine(event.taskId)}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join('\n')
    const commit = runGit(projectRoot, ['commit', '-m', message])
    if (commit.status !== 0) return { ok: false, reason: `commit_failed:${String(commit.stderr).slice(0, 120)}` }
    const hash = runGit(projectRoot, ['rev-parse', '--short', 'HEAD'])
    return {
      ok: true,
      committed: true,
      commit: hash.status === 0 ? String(hash.stdout ?? '').trim() : undefined,
    }
  } catch (err) {
    return { ok: false, reason: `error:${String((err as Error)?.message ?? err).slice(0, 120)}` }
  }
}
