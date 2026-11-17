import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkpointProjectHistory, requireProjectCheckpoint } from '../../../main/coding/project-git'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { parseEngineeringReview, readEngineeringDesign, blockingEngineeringReview } from '../../../main/software/engineering-design'
import { softwareVerificationFingerprint } from '../../../main/desktop/verification-fingerprint'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'bloma-engineering-')); roots.push(dir); return dir }
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8' }).trim()
const event = { kind: 'test', summary: '工程检查点' }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

it('records real source/assets/locks without runtime data, credentials or hooks; checkpoints are idempotent', async () => {
  const dir = root()
  for (const path of ['data', 'node_modules', 'assets', '00_VERIFY', 'nested']) mkdirSync(join(dir, path))
  for (const path of ['main.js', 'assets/art.svg', 'package-lock.json', 'ARCHITECTURE.md', 'data/real.json', 'node_modules/cache.js', '00_VERIFY/report.json', '.env', 'nested/.env.local', 'nested/secret.key']) writeFileSync(join(dir, path), path)
  let ticks = 0
  const heartbeat = setInterval(() => { ticks++ }, 1)
  let first: string
  try { first = await requireProjectCheckpoint(dir, event) } finally { clearInterval(heartbeat) }
  expect(ticks).toBeGreaterThan(0)
  expect(git(dir, 'ls-tree', '-r', '--name-only', first).split('\n')).toEqual(['00_VERIFY/report.json', 'ARCHITECTURE.md', 'assets/art.svg', 'main.js', 'package-lock.json'])
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(first)
  expect(git(dir, 'status', '--porcelain')).toBe('')
  expect(await checkpointProjectHistory(dir, event)).toMatchObject({ ok: true, committed: false, commit: first })
  const hook = join(dir, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  git(dir, 'config', 'commit.gpgsign', 'true')
  const index = readFileSync(join(dir, '.git/index'))
  writeFileSync(join(dir, 'main.js'), 'changed')
  const second = await requireProjectCheckpoint(dir, event)
  expect(second).not.toBe(first)
  expect(git(dir, 'rev-parse', `${second}^`)).toBe(first)
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(first)
  expect(readFileSync(join(dir, '.git/index'))).toEqual(index)
}, 30000)

it('preserves an existing HEAD and staged bytes and never adopts a parent repository', async () => {
  const dir = root()
  await requireProjectCheckpoint(dir, event)
  writeFileSync(join(dir, 'original.txt'), 'staged')
  git(dir, 'add', 'original.txt')
  const index = readFileSync(join(dir, '.git/index')), head = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'original.txt'), 'working')
  const commit = await requireProjectCheckpoint(dir, event)
  expect(git(dir, 'show', `${commit}:original.txt`)).toBe('working')
  expect(git(dir, 'show', ':original.txt')).toBe('staged')
  expect(readFileSync(join(dir, '.git/index'))).toEqual(index)
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  const child = join(dir, 'child'); mkdirSync(child)
  expect(await checkpointProjectHistory(child, event)).toEqual({ ok: false, reason: 'parent_repository_not_owned' })
}, 30000)

it('recognizes worktrees by actual ownership and refuses unreadable repository metadata', async () => {
  const dir = root(), worktree = join(root(), 'worktree')
  await requireProjectCheckpoint(dir, event)
  git(dir, 'worktree', 'add', '-b', 'user-work', worktree)
  writeFileSync(join(worktree, 'work.js'), 'export {}')
  expect((await checkpointProjectHistory(worktree, event)).ok).toBe(true)
  git(worktree, 'add', 'work.js')
  git(worktree, 'switch', 'bloma-history')
  expect(await checkpointProjectHistory(worktree, event)).toEqual({ ok: false, reason: 'history_branch_checked_out' })
  const broken = root(); mkdirSync(join(broken, '.git'))
  await expect(requireProjectCheckpoint(broken, event)).rejects.toThrow('repository_unreadable')
}, 30000)

it('keeps engineering judgment with agents, permits investigation and binds conventional design changes to source identity', () => {
  const dir = root(), policy = createSoftwareCollaborationPolicy('p', dir, 's')
  const ctx = { projectId: 'p', sessionId: 's', requestId: 'r', state: createToolState(), signal: new AbortController().signal }
  expect(() => policy.assertRead(ctx)).not.toThrow()
  expect(() => policy.assertFileWrite('ARCHITECTURE.md', ctx)).not.toThrow()
  expect(() => policy.assertFileWrite('src/main.js', ctx)).not.toThrow()
  expect(() => policy.assertCommand(ctx)).not.toThrow()
  writeFileSync(join(dir, 'ARCHITECTURE.md'), '   ')
  expect(readEngineeringDesign(dir)).toBeUndefined()
  writeFileSync(join(dir, 'ARCHITECTURE.md'), 'Domain owns state; UI sends commands. Persistence failures propagate. Verify save/reopen/failure.')
  expect(() => policy.assertCommand(ctx)).not.toThrow()
  expect(() => policy.assertFileWrite('src/main.js', ctx)).not.toThrow()
  const before = softwareVerificationFingerprint(dir)
  writeFileSync(join(dir, 'ARCHITECTURE.md'), 'Revised state ownership')
  expect(softwareVerificationFingerprint(dir)).not.toBe(before)
  expect(() => parseEngineeringReview({ status: 'supported', evidence: '', limitations: '' })).toThrow('ENGINEERING_REVIEW_INVALID')
  writeFileSync(join(dir, 'ARCHITECTURE.md'), 'large existing design\n'.repeat(4000))
  expect(readEngineeringDesign(dir)).toContain('未附正文')
  expect(() => policy.assertCommand(ctx)).not.toThrow()
})

it('cancels an unstarted checkpoint without creating repository metadata', async () => {
  const dir = root(), controller = new AbortController(); controller.abort()
  const result = await checkpointProjectHistory(dir, event, controller.signal)
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('AbortError')
  expect(() => readFileSync(join(dir, '.git/HEAD'))).toThrow()
})

it('cancels an active Git request and permits a later retry', async () => {
  const dir = root(), controller = new AbortController()
  const pending = checkpointProjectHistory(dir, event, controller.signal)
  controller.abort()
  expect((await pending).ok).toBe(false)
  expect((await checkpointProjectHistory(dir, event)).ok).toBe(true)
}, 30000)

it('treats advisory and unevaluated architecture as information, reserving blocking for explicit serious findings', () => {
  expect(blockingEngineeringReview({status:'unverified',evidence:'Need more evidence',limitations:'Not assessed'})).toBe(false)
  expect(blockingEngineeringReview({status:'concern',severity:'medium',evidence:'Possible future simplification',limitations:''})).toBe(false)
  expect(blockingEngineeringReview({status:'concern',severity:'high',evidence:'Two owners overwrite persisted state under the confirmed concurrent flow',limitations:''})).toBe(true)
})
