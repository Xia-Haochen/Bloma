import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTextWindow, searchProjectFiles, pageFileNames, compileFileGlob } from '../../main/agent/tools/file-query'
import { buildAgentTools } from '../../main/agent/tools/agent-tools'
import { createToolState, type ToolContext } from '../../main/agent/loop/agent-loop'
import { createProject } from '../../main/project/project-service'
import { restorePromaHome } from '../support/proma-home-guard'

let root: string
const originalHome = process.env.PROMA_HOME
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bloma-query-')); process.env.PROMA_HOME = root })
afterEach(() => { restorePromaHome(originalHome); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function write(path: string, content: string | Buffer) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content) }

describe('bounded file queries', () => {
  it('reads ordinary CRLF and Unicode without relaxing whitespace', () => {
    write('a.txt', '一\r\n二\n三')
    const result = readTextWindow(join(root, 'a.txt'), 'a.txt', { offset: 2, limit: 1 })
    expect(result.output).toContain('2 │ 二')
    expect(result.detail?.next).toMatchObject({ offset: 3, char_offset: 0 })
  })
  it('recovers every character of a giant Unicode line with bounded continuation', () => {
    const text = '中😀'.repeat(2000); write('a.txt', text)
    let input: Record<string, unknown> = { limit: 1, max_chars: 512, max_bytes: 2048 }, actual = '', pages = 0
    for (;;) {
      const result = readTextWindow(join(root, 'a.txt'), 'a.txt', input)
      expect(result.isError, result.output).not.toBe(true)
      expect(result.output.length).toBeLessThanOrEqual(512)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(2048)
      const part = result.output.split('\n')[1].replace(/^1 │ /, '')
      expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      actual += part; pages++
      if (!result.detail?.next) break
      input = { ...input, ...(result.detail.next as object) }
      expect(pages).toBeLessThan(100)
    }
    expect(actual).toBe(text)
  })
  it('bounds many empty lines as well as content', () => {
    write('a.txt', '\n'.repeat(600))
    const result = readTextWindow(join(root, 'a.txt'), 'a.txt', { limit: 500, max_chars: 512, max_bytes: 2048 })
    expect(result.output.length).toBeLessThanOrEqual(512)
    expect(result.detail?.next).toBeDefined()
  })
  it('rejects stale or malformed long-line cursors and binary/directory input', () => {
    write('a.txt', 'x'.repeat(1000))
    const first = readTextWindow(join(root, 'a.txt'), 'a.txt', { max_chars: 512 })
    write('a.txt', 'different')
    expect(readTextWindow(join(root, 'a.txt'), 'a.txt', first.detail!.next as Record<string, unknown>).output).toContain('STALE_READ')
    expect(readTextWindow(join(root, 'a.txt'), 'a.txt', { char_offset: 1 }).output).toContain('READ_CURSOR_REQUIRES_REVISION')
    write('b.bin', Buffer.from([0, 1, 2]))
    expect(readTextWindow(join(root, 'b.bin'), 'b.bin', {}).output).toContain('READ_BINARY_FILE')
    expect(readTextWindow(root, '.', {}).output).toContain('READ_NOT_REGULAR_FILE')
  })
  it('rejects invalid numeric inputs instead of silently coercing', () => {
    write('a.txt', 'a')
    for (const input of [{ limit: 1.5 }, { offset: NaN }, { max_chars: 5 }, { offset: '2' }]) expect(readTextWindow(join(root, 'a.txt'), 'a.txt', input).isError).toBe(true)
  })
  it('supports explicit literal/case/context/file-only and basename/directory globs', () => {
    write('src/a.ts', 'before\nconst literal = "A.B"\nafter\n')
    write('src/nested/b.ts', 'A0B\nA.B')
    const files = ['src/a.ts', 'src/nested/b.ts']
    const result = searchProjectFiles(root, files, { pattern: 'a.b', literal: true, context: 1, glob: 'src/*.ts' })
    expect(result.output).toContain('src/a.ts:2: const literal = "A.B"')
    expect(result.output).toContain('src/a.ts:1- before')
    expect(result.output).not.toContain('nested')
    expect(searchProjectFiles(root, files, { pattern: 'a.b', literal: true, ignore_case: false }).detail?.hits).toBe(0)
    expect(searchProjectFiles(root, files, { pattern: 'A.B', literal: true, glob: '*.ts', files_only: true }).output).toContain('src/nested/b.ts')
    expect(searchProjectFiles(root, files, { pattern: 'A0B', glob: 'src/**/*.ts' }).detail?.hits).toBe(1)
  })
  it('never silently weakens unsupported globs or invalid regex', () => {
    expect(() => compileFileGlob('src/[ab].ts')).toThrow('UNSUPPORTED_GLOB')
    expect(searchProjectFiles(root, [], { pattern: '(' }).output).toContain('正则表达式无效')
    expect(searchProjectFiles(root, [], { pattern: '.', glob: '*.{ts,js}' }).isError).toBe(true)
  })
  it('returns stable pages and rejects changed query/content even with unchanged mtime/size', () => {
    write('a.txt', 'hit1\nhit2\nhit3')
    const stat = statSync(join(root, 'a.txt'))
    const first = searchProjectFiles(root, ['a.txt'], { pattern: 'hit', limit: 1 })
    const cursor = first.detail?.next_cursor
    expect(cursor).toBeTypeOf('string')
    const second = searchProjectFiles(root, ['a.txt'], { pattern: 'hit', cursor, limit: 1 })
    expect(second.output).toContain('a.txt:2: hit2')
    expect(searchProjectFiles(root, ['a.txt'], { pattern: 'other', cursor }).output).toContain('QUERY_CURSOR_MISMATCH')
    write('a.txt', 'hit9\nhit2\nhit3'); utimesSync(join(root, 'a.txt'), stat.atime, stat.mtime)
    expect(searchProjectFiles(root, ['a.txt'], { pattern: 'hit', cursor }).output).toContain('QUERY_CURSOR_STALE')
    expect(searchProjectFiles(root, ['a.txt'], { pattern: 'hit', cursor: 'bad' }).isError).toBe(true)
  })
  it('labels oversized/binary/unreadable search gaps instead of claiming completeness', () => {
    write('big.txt', 'x'.repeat(2 * 1024 * 1024 + 1)); write('b.bin', Buffer.from([0, 4]))
    const result = searchProjectFiles(root, ['big.txt', 'b.bin', 'missing.txt'], { pattern: 'none' })
    expect(result.detail).toMatchObject({ complete_scope: false, skipped_large_files: 1, skipped_binary_files: 1, unreadable_files: 1 })
    expect(result.output).toContain('范围不完整')
  })
  it('bounds huge context blocks and provides a way to read the actual line', () => {
    write('a.txt', ('long '.repeat(1000) + '\n').repeat(12))
    const result = searchProjectFiles(root, ['a.txt'], { pattern: 'long', context: 5, max_chars: 1024, limit: 1 })
    expect(result.output.length).toBeLessThanOrEqual(1024)
    expect(result.output).toContain('截断')
    expect(result.detail?.next_cursor).toBeDefined()
  })
  it('paginates file names and invalidates old pages when membership changes', () => {
    const files = Array.from({ length: 205 }, (_, n) => `${n}.txt`)
    const first = pageFileNames(files, {}, 'list:test', 200)
    expect(pageFileNames(files, { cursor: first.detail?.next_cursor }, 'list:test', 200).output).toContain('显示 201~205')
    expect(pageFileNames([...files, 'new'], { cursor: first.detail?.next_cursor }, 'list:test', 200).isError).toBe(true)
  })
})

it('actual tools batch independent windows/errors, register revisions and preserve read-only role', async () => {
  const project = createProject({ request_id: 'batch-read', mode: 'quick' })
  writeFileSync(join(project.root_path, 'a.js'), 'const value = 1')
  const tools = buildAgentTools({ projectId: project.project_id, software: true, role: 'review' })
  const ctx: ToolContext = { projectId: project.project_id, sessionId: 'batch', requestId: 'batch', signal: new AbortController().signal, state: createToolState() }
  const read = tools.find(t => t.name === 'read_file')!
  const result = await read.execute({ files: [{ path: 'a.js' }, { path: 'missing' }, { path: '../outside' }] }, ctx)
  expect(result.output).toContain('const value = 1'); expect(result.isError).toBe(true)
  expect(ctx.state.file_revisions?.has('a.js')).toBe(true)
  expect(tools.some(t => t.name === 'edit_file')).toBe(false)
  expect((await read.execute({ path: 'a.js', files: [{ path: 'a.js' }] }, ctx)).isError).toBe(true)
  expect((await read.execute({ files: Array.from({ length: 9 }, () => ({ path: 'a.js' })) }, ctx)).isError).toBe(true)
  const many = await read.execute({ files: Array.from({ length: 8 }, () => ({ path: 'a.js' })) }, ctx)
  expect(many.output.length).toBeLessThanOrEqual(24000)
})
it('actual tools reject a junction escape for both reading and scoped search', async () => {
  const project = createProject({ request_id: 'safe-path', mode: 'quick' })
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET')
  symlinkSync(outside, join(project.root_path, 'escape'), 'junction')
  const tools = buildAgentTools({ projectId: project.project_id, software: true })
  const ctx: ToolContext = { projectId: project.project_id, sessionId: 'safe', requestId: 'safe', signal: new AbortController().signal, state: createToolState() }
  for (const [name, input] of [['read_file', { path: 'escape/secret.txt' }], ['grep', { path: 'escape', pattern: 'OUTSIDE_SECRET' }]] as const) {
    const result = await tools.find(t => t.name === name)!.execute(input, ctx)
    expect(result.isError).toBe(true); expect(result.output).not.toContain('OUTSIDE_SECRET')
  }
})
