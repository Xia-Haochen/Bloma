import { afterEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { codeServiceCapabilities, queryCodeService, type CodeServiceOptions, type CodeServiceRequest, type CodeServiceSuccess } from '../../../main/software/code-service'

// Preserve the installed implementation; make its exported object instrumentable ONLY for fault injection.
// Semantic positives still call the original TypeScript functions, parser and checker.
vi.mock('typescript', async importOriginal => {
  const original = await importOriginal<{ default: typeof ts }>()
  return { default: { ...original.default } }
})

const temporary: string[] = []
const config = (extra: Record<string, unknown> = {}, other: Record<string, unknown> = {}) => JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, types: [], lib: ['ES2022'], ...extra }, include: ['**/*.ts', '**/*.js'], ...other })
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'bloma-c1-'))
  temporary.push(root)
  for (const [path, text] of Object.entries({ 'tsconfig.json': config(), ...files })) {
    mkdirSync(resolve(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
    // Integer-second timestamps make exact same-stat assertions portable to Windows Date precision.
    utimesSync(join(root, path), 1_767_225_600, 1_767_225_600)
  }
  return root
}
function success(root: string, request: CodeServiceRequest, options: CodeServiceOptions = {}): CodeServiceSuccess {
  const result = queryCodeService(root, request, options)
  if (!result.ok) throw Error(JSON.stringify(result))
  return result
}
function position(text: string, token: string, occurrence = 0) {
  let index = -1
  for (let n = 0; n <= occurrence; n++) index = text.indexOf(token, index + 1)
  if (index < 0) throw Error('test token missing')
  const before = text.slice(0, index).split('\n')
  return { line: before.length, column: before.at(-1)!.length + 1 }
}
function replaceSameStat(path: string, text: string) {
  const stat = statSync(path)
  expect(Buffer.byteLength(text)).toBe(stat.size)
  writeFileSync(path, text)
  utimesSync(path, stat.atime, stat.mtime)
  expect(statSync(path).size).toBe(stat.size)
  expect(statSync(path).mtimeMs).toBe(stat.mtimeMs)
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
  // Queries are synchronous. Yield between fixtures so Vitest IPC/timers are not starved by a whole file.
  await new Promise<void>(resolve => setImmediate(resolve))
})

// All semantic positives below invoke the installed real TypeScript LanguageService over real source bytes.
describe('C1 real TypeScript/JavaScript semantics', () => {
  it('resolves path aliases, renamed imports and re-exports to the actual declaration', () => {
    const consumer = "import { renamed as task } from '@lib/bridge'\nexport const value = task(3)\n"
    const root = fixture({
      'tsconfig.json': config({ baseUrl: '.', paths: { '@lib/*': ['src/*'] } }),
      'src/source.ts': 'export function shared(value: number) { return value + 1 }\n',
      'src/bridge.ts': "export { shared as renamed } from './source'\n",
      'consumer.ts': consumer,
    })
    const result = success(root, { kind: 'definition', path: 'consumer.ts', ...position(consumer, 'task', 1) })
    expect(result.backend).toBe('typescript-language-service')
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'definition', name: 'shared', location: expect.objectContaining({ path: 'src/source.ts', start: { line: 1, column: 17 } }) })]))
    expect(result.boundary.omittedExternalResults).toBe(0)
    expect(result.fileVersion).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
  it('finds cross-file references through aliases instead of matching spelling', () => {
    const definition = 'export function original(x: number) { return x }\n'
    const consumer = "import { original as renamed } from './a'\nrenamed(1)\n"
    const root = fixture({ 'a.ts': definition, 'b.ts': consumer })
    const result = success(root, { kind: 'references', path: 'a.ts', ...position(definition, 'original') })
    const paths = result.items.filter(item => item.kind === 'reference').map(item => item.location.path)
    expect(paths).toContain('a.ts')
    expect(paths).toContain('b.ts')
    expect(result.items.some(item => item.kind === 'reference' && item.location.path === 'b.ts' && item.location.start.line === 2)).toBe(true)
  })
  it('distinguishes shadowed local symbols with identical text', () => {
    const source = 'function one() { const shared = 1; return shared }\nfunction two() { const shared = 2; return shared }\n'
    const root = fixture({ 'a.ts': source })
    const result = success(root, { kind: 'references', path: 'a.ts', ...position(source, 'shared') })
    const references = result.items.filter(item => item.kind === 'reference')
    expect(references).toHaveLength(2)
    expect(references.every(item => item.location.start.line === 1)).toBe(true)
    const withoutDeclaration = success(root, { kind: 'references', path: 'a.ts', ...position(source, 'shared'), includeDeclaration: false })
    expect(withoutDeclaration.items).toHaveLength(1)
  })
  it('returns actual compiler type errors and unresolved dependency diagnostics', () => {
    const root = fixture({ 'a.ts': "import { absent } from 'missing-package'\nexport const value: number = 'bad'\nabsent()\n" })
    const result = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'diagnostic', code: 2307 }),
      expect.objectContaining({ kind: 'diagnostic', code: 2322, location: expect.objectContaining({ path: 'a.ts', start: { line: 2, column: 14 } }) }),
    ]))
    expect(result.items.some(item => item.kind === 'diagnostic' && item.message.includes('missing-package'))).toBe(true)
  })
  it('uses the real LanguageService for checked JavaScript JSDoc types', () => {
    const source = '/** @param {number} value */\nexport function plus(value) { return value + 1 }\nplus("bad")\n'
    const root = fixture({ 'tsconfig.json': config({ allowJs: true, checkJs: true }), 'a.js': source })
    const diagnostics = success(root, { kind: 'diagnostics', path: 'a.js' })
    expect(diagnostics.language).toBe('javascript')
    expect(diagnostics.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'diagnostic', code: 2345 })]))
    const definition = success(root, { kind: 'definition', path: 'a.js', ...position(source, 'plus', 1) })
    expect(definition.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'definition', name: 'plus' })]))
  })
  it('returns declaration symbols and their scope, never comment/lexical matches', () => {
    const root = fixture({ 'a.ts': '// phantomSymbol is not a declaration\nexport class Store { save(value: number) { return value } }\nexport function worker() { const local = 1; return local }\n' })
    const result = success(root, { kind: 'symbol', path: 'a.ts' })
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'symbol', name: 'Store', symbolKind: 'class' }),
      expect.objectContaining({ kind: 'symbol', name: 'save', container: 'Store' }),
      expect.objectContaining({ kind: 'symbol', name: 'worker' }),
    ]))
    expect(result.items.some(item => item.kind === 'symbol' && item.name === 'phantomSymbol')).toBe(false)
    const filtered = success(root, { kind: 'symbol', path: 'a.ts', query: 'SAVE' })
    expect(filtered.items).toHaveLength(1)
    expect(filtered.items[0]).toMatchObject({ kind: 'symbol', name: 'save' })
  })
  it('supports UTF-16 positions and CRLF without treating columns as bytes', () => {
    const source = 'const label = "😀"; export const actual = 3;\r\nactual;\r\n'
    const root = fixture({ 'a.ts': source })
    const result = success(root, { kind: 'definition', path: 'a.ts', ...position(source, 'actual', 1) })
    expect(result.items[0]).toMatchObject({ kind: 'definition', location: { start: position(source, 'actual') } })
  })
  it('uses explicit inferred-project semantics when no configuration exists', () => {
    const root = fixture({ 'a.ts': 'export const x: number = "bad"\n' })
    rmSync(join(root, 'tsconfig.json'))
    const result = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(result.config).toEqual({ path: null, version: null, mode: 'inferred' })
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322 })]))
    expect(result.cache).toBe('fresh-language-service')
  })
  it('does not include excluded files or silently infer a different project', () => {
    const root = fixture({ 'tsconfig.json': config({}, { include: ['src/**/*.ts'], exclude: ['src/omit.ts'] }), 'src/a.ts': 'export const a = 1', 'src/omit.ts': 'export const omit = 2', 'outside.ts': 'export const outside = 3' })
    expect(queryCodeService(root, { kind: 'symbol', path: 'outside.ts' })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_IN_PROJECT' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'src/omit.ts' })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_IN_PROJECT' } })
    expect(success(root, { kind: 'symbol', path: 'src/a.ts' }).items[0]).toMatchObject({ name: 'a' })
  })
})

describe('C1 byte identity and configuration freshness', () => {
  it('rebuilds from bytes after a same-mtime/same-size source edit', () => {
    const root = fixture({ 'a.ts': 'export const first = 1\n' })
    const first = success(root, { kind: 'symbol', path: 'a.ts' })
    replaceSameStat(join(root, 'a.ts'), 'export const other = 2\n')
    const other = success(root, { kind: 'symbol', path: 'a.ts' })
    expect(other.fileVersion).not.toBe(first.fileVersion)
    expect(other.indexVersion).not.toBe(first.indexVersion)
    expect(other.items[0]).toMatchObject({ name: 'other' })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts', expectedFileVersion: first.fileVersion })).toMatchObject({ ok: false, error: { code: 'STALE_FILE_VERSION' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts', expectedIndexVersion: first.indexVersion })).toMatchObject({ ok: false, error: { code: 'STALE_INDEX_VERSION' } })
  })
  it('invalidates alias resolution on a same-stat tsconfig change', () => {
    const source = "import { target } from '@target'\nexport const answer = target\n"
    const root = fixture({ 'tsconfig.json': config({ baseUrl: '.', paths: { '@target': ['./a.ts'] } }), 'a.ts': 'export const target = 1', 'b.ts': 'export const target = 2', 'use.ts': source })
    const request: CodeServiceRequest = { kind: 'definition', path: 'use.ts', ...position(source, 'target', 1) }
    const first = success(root, request)
    const configPath = join(root, 'tsconfig.json')
    replaceSameStat(configPath, readFileSync(configPath, 'utf8').replace('./a.ts', './b.ts'))
    const second = success(root, request)
    expect(first.items[0]).toMatchObject({ location: { path: 'a.ts' } })
    expect(second.items[0]).toMatchObject({ location: { path: 'b.ts' } })
    expect(second.config.version).not.toBe(first.config.version)
    expect(second.indexVersion).not.toBe(first.indexVersion)
  })
  it('invalidates extended-config bytes and semantic options without touching tsconfig', () => {
    const root = fixture({ 'base.json': '{"compilerOptions":{"strictNullChecks":true}}', 'tsconfig.json': config({}, { extends: './base.json' }), 'a.ts': 'export const value: string = null\n' })
    const first = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(first.items.some(item => item.kind === 'diagnostic' && item.code === 2322)).toBe(true)
    writeFileSync(join(root, 'base.json'), '{"compilerOptions":{"strictNullChecks":false}}')
    const second = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(second.items.some(item => item.kind === 'diagnostic' && item.code === 2322)).toBe(false)
    expect(second.indexVersion).not.toBe(first.indexVersion)
  })
  it('distinguishes selected configuration even when the same files have been observed', () => {
    const root = fixture({ 'tsconfig.json': config(), 'tsconfig.relaxed.json': config({ strict: false }), 'a.ts': 'export const value: string = null\n' })
    const strict = success(root, { kind: 'diagnostics', path: 'a.ts' })
    const relaxed = success(root, { kind: 'diagnostics', path: 'a.ts' }, { configPath: 'tsconfig.relaxed.json' })
    expect(strict.indexVersion).not.toBe(relaxed.indexVersion)
    expect(relaxed.items.some(item => item.kind === 'diagnostic' && item.code === 2322)).toBe(false)
  })
  it('returns stable identity for the same query and unchanged bytes', () => {
    const root = fixture({ 'a.ts': 'export const value = 1' })
    const first = success(root, { kind: 'symbol', path: 'a.ts' })
    const second = success(root, { kind: 'symbol', path: 'a.ts', expectedIndexVersion: first.indexVersion })
    expect(second.indexVersion).toBe(first.indexVersion)
    expect(second.items).toEqual(first.items)
    expect(second.timings.totalMs).toBeGreaterThan(0)
  })
  it('discards a real semantic result if bytes change during the query', () => {
    const root = fixture({ 'a.ts': 'export const value = 1; value;' })
    const original = ts.createLanguageService
    vi.spyOn(ts, 'createLanguageService').mockImplementation((...args: Parameters<typeof original>) => {
      const service = original(...args)
      const definition = service.getDefinitionAtPosition.bind(service)
      service.getDefinitionAtPosition = (...query) => {
        const result = definition(...query)
        replaceSameStat(join(root, 'a.ts'), 'export const other = 2; other;')
        return result
      }
      return service
    })
    expect(queryCodeService(root, { kind: 'definition', path: 'a.ts', line: 1, column: 25 })).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_CHANGED' } })
  })
})

describe('C1 containment, capability gaps and bounded failure', () => {
  it('rejects outside files and symlink/junction escapes without returning their text', () => {
    const outside = fixture({ 'secret.ts': 'export const SECRET_DO_NOT_LEAK = 7' })
    const root = fixture({ 'a.ts': "import { SECRET_DO_NOT_LEAK } from './escape/secret'\nexport const value = SECRET_DO_NOT_LEAK" })
    symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(queryCodeService(root, { kind: 'symbol', path: join(outside, 'secret.ts') })).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_PROJECT' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'escape/secret.ts' })).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_PROJECT' } })
    const result = success(root, { kind: 'definition', path: 'a.ts', line: 2, column: 22 })
    expect(result.items.every(item => !('location' in item) || !item.location?.path.includes('secret.ts'))).toBe(true)
    expect(result.boundary.deniedReads).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toContain(outside.replaceAll('\\', '/'))
  })
  it('does not follow external configuration extends', () => {
    const external = fixture({ 'external.json': '{"compilerOptions":{"baseUrl":".","strict":false}}' })
    const root = fixture({ 'tsconfig.json': config({}, { extends: join(external, 'external.json') }), 'a.ts': 'export const value = 1' })
    const result = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(result.boundary.deniedReads).toBeGreaterThan(0)
    expect(result.items.some(item => item.kind === 'diagnostic' && (item.code === 5083 || item.code === 6053))).toBe(true)
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' })).toMatchObject({ ok: false, error: { code: 'CONFIGURATION_ERROR' } })
  })
  it('only resolves an external declaration dependency with explicit host authorization', () => {
    const dependency = fixture({ 'types/index.d.ts': 'export declare function dependency(value: number): number', 'types/package.json': '{"name":"dep","types":"index.d.ts"}' })
    const source = "import { dependency } from 'dep'\nexport const value = dependency('bad')\n"
    const root = fixture({ 'a.ts': source })
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(join(dependency, 'types'), join(root, 'node_modules/dep'), process.platform === 'win32' ? 'junction' : 'dir')
    const denied = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(denied.items.some(item => item.kind === 'diagnostic' && item.code === 2307)).toBe(true)
    const authorized = success(root, { kind: 'diagnostics', path: 'a.ts' }, { dependencyRoots: [join(root, 'node_modules'), join(dependency, 'types')] })
    expect(authorized.items.some(item => item.kind === 'diagnostic' && item.code === 2345)).toBe(true)
    expect(authorized.items.some(item => item.kind === 'diagnostic' && item.code === 2307)).toBe(false)
    const definition = success(root, { kind: 'definition', path: 'a.ts', ...position(source, 'dependency', 1) }, { dependencyRoots: [join(root, 'node_modules'), join(dependency, 'types')] })
    expect(definition.items).toHaveLength(0)
    expect(definition.boundary.omittedExternalResults).toBeGreaterThan(0)
  })
  it('returns an explicit Python capability gap instead of lexical semantics', () => {
    const root = fixture({ 'a.py': 'def target():\n    return 1\ntarget()\n' })
    for (const kind of ['definition', 'references', 'diagnostics', 'symbol'] as const) expect(queryCodeService(root, { kind, path: 'a.py', line: 3, column: 1 })).toMatchObject({ ok: false, backend: 'unavailable', error: { code: 'PYTHON_BACKEND_UNAVAILABLE' } })
    expect(codeServiceCapabilities().python.available).toBe(false)
    expect(codeServiceCapabilities().typescript.backend).toBe('typescript-language-service')
  })
  it('honors pre-aborted cancellation and recovers on a new request', () => {
    const root = fixture({ 'a.ts': 'export const value = 1' })
    const controller = new AbortController()
    controller.abort()
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(success(root, { kind: 'symbol', path: 'a.ts' }).items[0]).toMatchObject({ name: 'value' })
  })
  it('checks cancellation after the backend returns, discards results, and disposes', () => {
    const root = fixture({ 'a.ts': 'export const value = 1; value;' })
    const controller = new AbortController(), disposed = vi.fn()
    const original = ts.createLanguageService
    vi.spyOn(ts, 'createLanguageService').mockImplementation((...args: Parameters<typeof original>) => {
      const service = original(...args), definition = service.getDefinitionAtPosition.bind(service), dispose = service.dispose.bind(service)
      service.getDefinitionAtPosition = (...query) => { const result = definition(...query); controller.abort(); return result }
      service.dispose = () => { disposed(); dispose() }
      return service
    })
    expect(queryCodeService(root, { kind: 'definition', path: 'a.ts', line: 1, column: 25 }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(disposed).toHaveBeenCalledOnce()
  })
  it('does not reuse a crashed backend or return a stale success', () => {
    const root = fixture({ 'a.ts': 'export const value = 1' })
    const spy = vi.spyOn(ts, 'createLanguageService').mockImplementationOnce(() => { throw Error('simulated backend crash') })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' })).toMatchObject({ ok: false, error: { code: 'BACKEND_FAILURE' } })
    spy.mockRestore()
    expect(success(root, { kind: 'symbol', path: 'a.ts' }).items[0]).toMatchObject({ name: 'value' })
  })
  it('bounds result count and serialized output bytes with explicit truncation', () => {
    const root = fixture({ 'a.ts': Array.from({ length: 50 }, (_, i) => `export const symbol_${i} = ${i}`).join('\n') })
    const count = success(root, { kind: 'symbol', path: 'a.ts', limit: 3 })
    expect(count.items).toHaveLength(3)
    expect(count.truncated).toBe(true)
    const bytes = success(root, { kind: 'symbol', path: 'a.ts', limit: 200 }, { maxOutputBytes: 2400 })
    expect(Buffer.byteLength(JSON.stringify(bytes))).toBeLessThanOrEqual(2400)
    expect(bytes.truncated).toBe(true)
  })
  it('fails closed at source/file/total byte bounds, not a silently partial index', () => {
    const root = fixture({ 'a.ts': 'export const a = 1', 'b.ts': 'export const b = 2' })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' }, { maxProjectFiles: 1 })).toMatchObject({ ok: false, error: { code: 'PROJECT_FILE_LIMIT' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' }, { maxFileBytes: 10 })).toMatchObject({ ok: false, error: { code: 'FILE_BYTE_LIMIT' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' }, { maxTotalBytes: 20 })).toMatchObject({ ok: false, error: { code: 'INDEX_BYTE_LIMIT' } })
  })
  it('honors cooperative deadlines without returning a partial result', () => {
    const root = fixture({ 'a.ts': 'export const value = 1' })
    const original = ts.createLanguageService
    vi.spyOn(ts, 'createLanguageService').mockImplementation((...args: Parameters<typeof original>) => {
      const service = original(...args), navigation = service.getNavigationTree.bind(service)
      service.getNavigationTree = (...query) => { const end = performance.now() + 40; while (performance.now() < end) { /* synchronous backend work */ } return navigation(...query) }
      return service
    })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' }, { timeoutMs: 25 })).toMatchObject({ ok: false, error: { code: 'DEADLINE_EXCEEDED' } })
  })
  it('reports configuration syntax errors and unsupported project references honestly', () => {
    const root = fixture({ 'a.ts': 'export const a = 1', 'tsconfig.json': '{ "compilerOptions": invalid }' })
    expect(success(root, { kind: 'diagnostics', path: 'a.ts' }).items.some(item => item.kind === 'diagnostic')).toBe(true)
    writeFileSync(join(root, 'tsconfig.json'), config({}, { references: [{ path: './another' }] }))
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' })).toMatchObject({ ok: false, error: { code: 'PROJECT_REFERENCES_UNSUPPORTED' } })
  })
  it('does not execute compiler plugins or emit output', () => {
    const root = fixture({ 'a.ts': 'export const value = 1', 'tsconfig.json': config({ plugins: [{ name: './malicious.cjs' }], outDir: './output' }), 'malicious.cjs': "require('fs').writeFileSync(require('path').join(__dirname,'executed.txt'),'bad'); module.exports = () => {}" })
    const before = readFileSync(join(root, 'a.ts'))
    success(root, { kind: 'symbol', path: 'a.ts' })
    expect(() => statSync(join(root, 'executed.txt'))).toThrow()
    expect(() => statSync(join(root, 'output'))).toThrow()
    expect(readFileSync(join(root, 'a.ts'))).toEqual(before)
  })
  it('invalidates a result when an internal alias is retargeted outside during the backend call', () => {
    const outside = fixture({ 'value.ts': 'export const target = 99' })
    const source = "import { target } from './alias/value'\nexport const answer = target\n"
    const root = fixture({ 'real/value.ts': 'export const target = 1', 'use.ts': source })
    symlinkSync(join(root, 'real'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    const original = ts.createLanguageService
    vi.spyOn(ts, 'createLanguageService').mockImplementation((...args: Parameters<typeof original>) => {
      const service = original(...args), definition = service.getDefinitionAtPosition.bind(service)
      service.getDefinitionAtPosition = (...query) => {
        const result = definition(...query)
        rmSync(join(root, 'alias'), { recursive: true, force: true })
        symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
        return result
      }
      return service
    })
    expect(queryCodeService(root, { kind: 'definition', path: 'use.ts', ...position(source, 'target', 1) })).toMatchObject({ ok: false, error: { code: 'SNAPSHOT_CHANGED' } })
  })
  it('invalidates missing-module lookups after a real dependency source is added', () => {
    const source = "import { value } from './missing'\nexport const answer = value\n"
    const root = fixture({ 'a.ts': source })
    const before = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(before.items.some(item => item.kind === 'diagnostic' && item.code === 2307)).toBe(true)
    writeFileSync(join(root, 'missing.ts'), 'export const value = 1')
    const after = success(root, { kind: 'diagnostics', path: 'a.ts' })
    expect(after.items.some(item => item.kind === 'diagnostic' && item.code === 2307)).toBe(false)
    expect(after.indexVersion).not.toBe(before.indexVersion)
  })
  it('rejects malformed UTF-8 and gives an explicit missing-file error', () => {
    const root = fixture({ 'a.ts': 'export const value = 1' })
    expect(queryCodeService(root, { kind: 'symbol', path: 'missing.ts' })).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } })
    writeFileSync(join(root, 'a.ts'), Buffer.from([0x65, 0xff, 0xfe]))
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' })).toMatchObject({ ok: false, error: { code: 'INVALID_UTF8' } })
  })
  it('validates request positions, unsupported languages and resource options', () => {
    const root = fixture({ 'a.ts': 'export const x = 1' })
    expect(queryCodeService(root, { kind: 'definition', path: 'a.ts', line: 999, column: 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_POSITION' } })
    expect(queryCodeService(root, { kind: 'definition', path: 'a.ts', line: 1, column: 999 })).toMatchObject({ ok: false, error: { code: 'INVALID_POSITION' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.rs' })).toMatchObject({ ok: false, error: { code: 'LANGUAGE_UNSUPPORTED' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts', limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } })
    expect(queryCodeService(root, { kind: 'symbol', path: 'a.ts' }, { maxTotalBytes: Infinity })).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } })
  })
})
