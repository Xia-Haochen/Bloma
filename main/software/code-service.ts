import ts from 'typescript'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

/** Positions are 1-based UTF-16 code units, like TypeScript, NOT UTF-8 offsets. */
export interface CodePosition { line: number; column: number }
export interface CodeLocation {
  path: string
  version: string
  start: CodePosition
  end: CodePosition
}
export interface CodeServiceRequest {
  kind: 'definition' | 'references' | 'diagnostics' | 'symbol'
  path: string
  line?: number
  column?: number
  /** Literal, case-insensitive filter on LanguageService declaration names, not lexical source search. */
  query?: string
  includeDeclaration?: boolean
  expectedFileVersion?: string
  expectedIndexVersion?: string
  limit?: number
}
export interface CodeServiceOptions {
  signal?: AbortSignal
  /** Root-relative config; default uses ONLY the root tsconfig.json, then jsconfig.json. */
  configPath?: string
  /** HOST authorization only. Never pass through untrusted tool input. No automatic ancestor/dependency grants. */
  dependencyRoots?: readonly string[]
  timeoutMs?: number
  maxProjectFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxOutputBytes?: number
}
export type CodeServiceItem =
  | { kind: 'definition'; name: string; symbolKind: string; location: CodeLocation }
  | { kind: 'reference'; isDefinition: boolean; isWriteAccess: boolean; location: CodeLocation }
  | { kind: 'symbol'; name: string; symbolKind: string; container: string; location: CodeLocation }
  | { kind: 'diagnostic'; code: number; category: string; message: string; messageTruncated: boolean; location?: CodeLocation }
export interface CodeServiceSuccess {
  ok: true
  backend: 'typescript-language-service'
  typescriptVersion: string
  kind: CodeServiceRequest['kind']
  language: 'typescript' | 'javascript'
  path: string
  fileVersion: string
  /** Hash of actual observed file bytes, existence probes and directory inventories, not mtime/size. */
  indexVersion: string
  config: { path: string | null; version: string | null; mode: 'configured' | 'inferred' }
  items: CodeServiceItem[]
  truncated: boolean
  boundary: { deniedReads: number; omittedExternalResults: number; examples: string[] }
  observed: { files: number; bytes: number; projectFiles: number }
  timings: { snapshotMs: number; serviceInitMs: number; queryMs: number; validationMs: number; totalMs: number }
  cache: 'fresh-language-service'
  limitations: string[]
}
export interface CodeServiceFailure {
  ok: false
  error: { code: string; message: string }
  backend: 'typescript-language-service' | 'unavailable'
}
export type CodeServiceResult = CodeServiceSuccess | CodeServiceFailure

class ServiceError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'CodeServiceError' }
}
// Native realpath still resolves junctions/symlinks, without repeated JS component walks on Windows.
const realPath = (path: string) => realpathSync.native(path)
const hash = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const slash = (path: string) => path.split(sep).join('/')
const caseSensitive = ts.sys.useCaseSensitiveFileNames
const key = (path: string) => caseSensitive ? resolve(path) : resolve(path).toLowerCase()
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/i
const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.context', '.bloma-build'])
const indexedFile = (name: string) => sourcePattern.test(name) || /^(?:package|tsconfig(?:\..*)?|jsconfig(?:\..*)?)\.json$/i.test(name)
const ignoredPath = (root: string, path: string) => relative(root, path).split(sep).some(part => ignored.has(part))
const bounded = (value: number | undefined, fallback: number, min: number, max: number, name: string) => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new ServiceError('INVALID_OPTIONS', `${name} must be an integer in ${min}..${max}`)
  return value
}

interface FileImage { path: string; label: string; bytes: Buffer; text: string; version: string }
interface DirectoryImage { path: string; label: string; signature: string; files: string[]; directories: string[] }
/** TypeScript ships this helper but does not expose its declaration in typescript.d.ts.
 * Keep it guarded; never silently replace TypeScript config glob semantics with our own.
 * Verified with 5.9.3. A future incompatible TS release fails with an explicit capability error.
 */
type MatchFiles = (path: string, extensions: readonly string[] | undefined, excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined, caseSensitive: boolean, cwd: string, depth: number | undefined,
  entries: (path: string) => { files: readonly string[]; directories: readonly string[] }, realpath: (path: string) => string) => string[]
function directoryEntries(path: string, check: () => void): Dirent[] {
  const directory = opendirSync(path)
  const entries: Dirent[] = []
  try {
    for (;;) {
      check()
      const entry = directory.readSync()
      if (!entry) break
      if (entries.length >= 20000) throw new ServiceError('DIRECTORY_ENTRY_LIMIT')
      entries.push(entry)
    }
  } finally { directory.closeSync() }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}
const getMatcher = () => {
  const matcher = (ts as unknown as { matchFiles?: MatchFiles }).matchFiles
  if (typeof matcher !== 'function') throw new ServiceError('TS_CONFIG_MATCHER_UNAVAILABLE', 'Installed TypeScript does not expose the bounded config matcher')
  return matcher
}

/** One query owns one bounded filesystem image and one disposable LanguageService. No global mutable cache. */
class ReadImage {
  root = ''
  readonly libraryRoot: string
  readonly dependencyRoots: string[]
  readonly files = new Map<string, FileImage>()
  readonly directories = new Map<string, DirectoryImage>()
  readonly probes = new Map<string, { path: string; exists: boolean; directory: boolean }>()
  // Immutable query-local lookup image only. validate() bypasses it and rechecks real paths/bytes.
  private readonly realpaths = new Map<string, string | undefined>()
  readonly denied = new Set<string>()
  readonly projectFiles: string[] = []
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  bytes = 0
  private inventoryEntries = 0
  private readonly deadline: number
  constructor(readonly options: CodeServiceOptions, readonly started: number) {
    this.deadline = started + bounded(options.timeoutMs, 10_000, 1, 30_000, 'timeoutMs')
    this.maxFiles = bounded(options.maxProjectFiles, 4000, 1, 10000, 'maxProjectFiles')
    this.maxFileBytes = bounded(options.maxFileBytes, 4 * 1024 * 1024, 1, 8 * 1024 * 1024, 'maxFileBytes')
    this.maxTotalBytes = bounded(options.maxTotalBytes, 64 * 1024 * 1024, 1, 128 * 1024 * 1024, 'maxTotalBytes')
    this.libraryRoot = realPath(dirname(ts.getDefaultLibFilePath({})))
    if ((options.dependencyRoots?.length ?? 0) > 8) throw new ServiceError('INVALID_OPTIONS', 'At most 8 dependency roots')
    this.dependencyRoots = (options.dependencyRoots ?? []).map(path => realPath(path))
  }
  initialize(root: string) {
    this.root = realPath(root)
    if (!statSync(this.root).isDirectory()) throw new ServiceError('INVALID_ROOT')
    this.check()
    this.scan(this.root)
  }
  check() {
    if (this.options.signal?.aborted) throw new ServiceError('CANCELLED', 'Semantic query cancelled; no partial result is authoritative')
    if (performance.now() >= this.deadline) throw new ServiceError('DEADLINE_EXCEEDED', 'Semantic query exceeded its cooperative deadline')
  }
  private label(path: string) {
    if (inside(this.root, path)) return slash(relative(this.root, path)) || '.'
    if (inside(this.libraryRoot, path)) return `@typescript-lib/${slash(relative(this.libraryRoot, path))}`
    const index = this.dependencyRoots.findIndex(root => inside(root, path))
    return index < 0 ? '@outside' : `@dependency/${index}/${slash(relative(this.dependencyRoots[index], path))}`
  }
  private grant(path: string) {
    if (inside(this.root, path) && !ignoredPath(this.root, path)) return true
    if (inside(this.libraryRoot, path)) return true
    return this.dependencyRoots.some(root => inside(root, path))
  }
  private deny(path: string) {
    // Keep no source text or uncontrolled absolute paths in errors/metadata.
    this.denied.add(inside(this.root, path) ? slash(relative(this.root, path)).slice(0, 200) : '@outside')
  }
  private actual(path: string, fresh = false): string | undefined {
    this.check()
    const absolute = resolve(path), id = key(absolute)
    if (!fresh && this.realpaths.has(id)) return this.realpaths.get(id)
    if (this.realpaths.size >= 60000 && !this.realpaths.has(id)) throw new ServiceError('PROBE_LIMIT')
    // Lexical access must be authorized too; root/node_modules can be an explicitly granted junction.
    if (!inside(this.root, absolute) && !this.grant(absolute)) { this.deny(absolute); this.realpaths.set(id, undefined); return undefined }
    try {
      const real = realPath(absolute)
      if (!this.grant(real)) { this.deny(absolute); this.realpaths.set(id, undefined); return undefined }
      if (!fresh) this.realpaths.set(id, real)
      return real
    } catch (error) {
      if (isMissing(error)) { if (!fresh) this.realpaths.set(id, undefined); return undefined }
      throw new ServiceError('FILESYSTEM_ERROR', 'Cannot resolve an authorized semantic input')
    }
  }
  requireProjectFile(requested: string): FileImage {
    const requestedAbsolute = resolve(this.root, requested)
    if (!inside(this.root, requestedAbsolute) || ignoredPath(this.root, requestedAbsolute)) throw new ServiceError('PATH_OUTSIDE_PROJECT', 'Requested file must resolve to an owned project source file')
    const path = this.actual(requestedAbsolute)
    if (!path) {
      try { realPath(requestedAbsolute) } catch (error) {
        if (isMissing(error)) throw new ServiceError('FILE_NOT_FOUND', 'Requested project file does not exist')
        throw error
      }
      throw new ServiceError('PATH_OUTSIDE_PROJECT', 'Requested file resolves outside the authorized project')
    }
    if (!inside(this.root, path) || ignoredPath(this.root, path)) throw new ServiceError('PATH_OUTSIDE_PROJECT', 'Requested file must resolve to an owned project source file')
    const image = this.read(path)
    if (!image) throw new ServiceError('FILE_NOT_FOUND')
    return image
  }
  /** Realpath before+after a descriptor read. Not an OS sandbox or atomic multi-file snapshot. */
  private readBytes(path: string): Buffer {
    this.check()
    const before = realPath(path)
    if (!this.grant(before)) throw new ServiceError('PATH_OUTSIDE_PROJECT')
    const fd = openSync(before, 'r')
    try {
      const info = fstatSync(fd)
      if (!info.isFile()) throw new ServiceError('NOT_A_FILE')
      if (info.size > this.maxFileBytes) throw new ServiceError('FILE_BYTE_LIMIT', 'A semantic input exceeds maxFileBytes; no partial index returned')
      // Read at most the initial bounded size + one growth sentinel, never an unbounded readFileSync.
      const buffer = Buffer.allocUnsafe(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        this.check()
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      const after = statSync(before), descriptorAfter = fstatSync(fd)
      if (key(realPath(path)) !== key(before) || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || descriptorAfter.size !== info.size || length !== info.size) throw new ServiceError('SNAPSHOT_CHANGED', 'Input identity changed during read')
      this.check()
      return Buffer.from(buffer.subarray(0, length))
    } finally { closeSync(fd) }
  }
  read(path: string): FileImage | undefined {
    const real = this.actual(path)
    if (!real) { this.exists(path, false); return undefined }
    const old = this.files.get(key(real))
    if (old) return old
    if (!statSync(real).isFile()) return undefined
    if (this.files.size >= this.maxFiles + 256) throw new ServiceError('INDEX_FILE_LIMIT')
    const bytes = this.readBytes(real)
    this.bytes += bytes.length
    if (this.bytes > this.maxTotalBytes) throw new ServiceError('INDEX_BYTE_LIMIT', 'Semantic input byte budget exceeded; no partial index returned')
    if (bytes.includes(0)) throw new ServiceError('BINARY_INPUT', 'Semantic source/config must be UTF-8 text')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new ServiceError('INVALID_UTF8', 'Semantic source/config is not valid UTF-8') }
    const value = { path: real, label: this.label(real), bytes, text, version: hash(bytes) }
    this.files.set(key(real), value)
    return value
  }
  exists(path: string, directory: boolean): boolean {
    this.check()
    const id = `${directory ? 'd' : 'f'}:${key(path)}`
    const previous = this.probes.get(id)
    if (previous) return previous.exists
    const real = this.actual(path)
    let exists = false
    if (real) {
      const info = statSync(real)
      exists = directory ? info.isDirectory() : info.isFile()
    }
    if (this.probes.size >= 50000) throw new ServiceError('PROBE_LIMIT')
    this.probes.set(id, { path: resolve(path), exists, directory })
    return exists
  }
  private directory(path: string): DirectoryImage | undefined {
    const real = this.actual(path)
    if (!real || !statSync(real).isDirectory()) return undefined
    const old = this.directories.get(key(real))
    if (old) return old
    if (this.directories.size >= 8000) throw new ServiceError('DIRECTORY_LIMIT')
    const entries = directoryEntries(real, () => this.check())
    this.inventoryEntries += entries.length
    if (this.inventoryEntries > 150000) throw new ServiceError('INVENTORY_ENTRY_LIMIT')
    const files: string[] = [], directories: string[] = []
    const signature = hash(entries.map(entry => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`).join('\n'))
    for (const entry of entries) {
      this.check()
      const child = resolve(real, entry.name)
      if (ignored.has(entry.name) && inside(this.root, real)) continue
      if (entry.isSymbolicLink()) {
        // Discovery never follows symlink trees. Direct TS imports are still checked by realpath.
        this.deny(child)
        continue
      }
      if (entry.isDirectory()) directories.push(entry.name)
      else if (entry.isFile()) files.push(entry.name)
    }
    const value = { path: real, label: this.label(real), signature, files, directories }
    this.directories.set(key(real), value)
    return value
  }
  private scan(path: string, depth = 0) {
    if (depth > 48) throw new ServiceError('DIRECTORY_DEPTH_LIMIT')
    const entries = this.directory(path)
    if (!entries) return
    for (const file of entries.files) {
      if (!indexedFile(file)) continue
      const image = this.read(resolve(path, file))
      if (image && sourcePattern.test(file)) {
        if (this.projectFiles.length >= this.maxFiles) throw new ServiceError('PROJECT_FILE_LIMIT')
        this.projectFiles.push(image.path)
      }
    }
    for (const directory of entries.directories) this.scan(resolve(path, directory), depth + 1)
  }
  readDirectory = (root: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] => {
    this.check()
    const actual = this.actual(root)
    if (!actual) return []
    return getMatcher()(actual, extensions, excludes, includes, caseSensitive, this.root, depth, path => {
      const entry = this.directory(path)
      return entry ? { files: entry.files, directories: entry.directories } : { files: [], directories: [] }
    }, path => this.actual(path) ?? resolve(path))
  }
  getDirectories = (path: string) => [...(this.directory(path)?.directories ?? [])]
  realpath = (path: string) => this.actual(path) ?? resolve(path)
  version(configurationIdentity: unknown) {
    const files = [...this.files.values()].map(image => `${image.label}:${image.version}`).sort()
    const directories = [...this.directories.values()].map(image => `${image.label}:${image.signature}`).sort()
    const probes = [...this.probes.values()].map(probe => `${probe.directory ? 'd' : 'f'}:${this.label(probe.path)}:${probe.exists}`).sort()
    return hash(JSON.stringify({ files, directories, probes, denied: [...this.denied].sort(), typescript: ts.version, configurationIdentity }))
  }
  validate() {
    this.check()
    // Validate lexical aliases too, not only canonical targets: a junction may have been retargeted.
    for (const [path, expected] of [...this.realpaths]) {
      const current = this.actual(path, true)
      if ((current ? key(current) : undefined) !== (expected ? key(expected) : undefined)) throw new ServiceError('SNAPSHOT_CHANGED', 'A path target changed during query; retry')
    }
    for (const image of this.files.values()) {
      const current = this.actual(image.path, true)
      if (!current || key(current) !== key(image.path) || hash(this.readBytes(current)) !== image.version) throw new ServiceError('SNAPSHOT_CHANGED', 'Observed source/config/dependency bytes changed during query; retry')
    }
    for (const image of this.directories.values()) {
      const real = this.actual(image.path, true)
      if (!real || key(real) !== key(image.path)) throw new ServiceError('SNAPSHOT_CHANGED')
      const entries = directoryEntries(real, () => this.check())
      const signature = hash(entries.map(entry => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`).join('\n'))
      if (signature !== image.signature) throw new ServiceError('SNAPSHOT_CHANGED', 'Directory inventory changed during query; retry')
      this.check()
    }
    // Negative lookup changes (e.g. installing a missing package) also invalidate the result.
    for (const probe of [...this.probes.values()]) {
      const real = this.actual(probe.path, true)
      const exists = real ? (probe.directory ? statSync(real).isDirectory() : statSync(real).isFile()) : false
      if (exists !== probe.exists) throw new ServiceError('SNAPSHOT_CHANGED', 'Module-resolution input changed during query; retry')
    }
    this.check()
  }
}
function isMissing(error: unknown) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '') }

function configuration(image: ReadImage, options: CodeServiceOptions) {
  let config: FileImage | undefined
  if (options.configPath !== undefined) {
    if (!options.configPath || isAbsolute(options.configPath)) throw new ServiceError('INVALID_CONFIG_PATH', 'configPath must be project-relative')
    config = image.requireProjectFile(options.configPath)
  } else {
    for (const path of ['tsconfig.json', 'jsconfig.json']) {
      if (image.exists(resolve(image.root, path), false)) { config = image.requireProjectFile(path); break }
    }
  }
  if (!config) return {
    files: [...image.projectFiles],
    options: { allowJs: true, checkJs: true, strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [] } as ts.CompilerOptions,
    errors: [] as ts.Diagnostic[], config,
  }
  const initial = ts.parseConfigFileTextToJson(config.path, config.text)
  if (initial.error) return { files: [] as string[], options: {} as ts.CompilerOptions, errors: [initial.error], config }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: caseSensitive,
    fileExists: path => image.exists(path, false),
    readFile: path => image.read(path)?.text,
    readDirectory: image.readDirectory,
  }
  const parsed = ts.parseJsonConfigFileContent(initial.config, host, dirname(config.path), undefined, config.path)
  // Multiple TS projects require a solution/project-service coordinator; do not flatten them silently.
  if (parsed.projectReferences?.length) throw new ServiceError('PROJECT_REFERENCES_UNSUPPORTED', 'Query an individual tsconfig; solution/project-reference orchestration is not implemented')
  return { files: parsed.fileNames, options: { ...parsed.options, noEmit: true, incremental: false, composite: false }, errors: parsed.errors, config }
}

export function codeServiceCapabilities() {
  return {
    typescript: { available: true, backend: 'typescript-language-service', version: ts.version, methods: ['definition', 'references', 'diagnostics', 'symbol'], incremental: false },
    javascript: { available: true, backend: 'typescript-language-service', methods: ['definition', 'references', 'diagnostics', 'symbol'] },
    python: { available: false, code: 'PYTHON_BACKEND_UNAVAILABLE', reason: 'No Python semantic backend is configured by this module. A Python interpreter alone is not a language server; lexical search is not substituted.' },
  }
}

/** Read-only, on-demand semantic query. Never runs project scripts, compiler plugins, emit, models or a server.
 * Do not mark a surrounding tool parallel-safe without accounting for synchronous CPU/IO and host policy.
 */
export function queryCodeService(root: string, request: CodeServiceRequest, options: CodeServiceOptions = {}): CodeServiceResult {
  const started = performance.now()
  let service: ts.LanguageService | undefined
  let image: ReadImage | undefined
  try {
    if (typeof root !== 'string' || !root) throw new ServiceError('INVALID_ROOT')
    if (!request || !['definition', 'references', 'diagnostics', 'symbol'].includes(request.kind) || typeof request.path !== 'string' || !request.path || request.path.length > 2048) throw new ServiceError('INVALID_REQUEST')
    if (/\.pyi?$/i.test(request.path)) return { ok: false, backend: 'unavailable', error: { code: 'PYTHON_BACKEND_UNAVAILABLE', message: codeServiceCapabilities().python.reason } }
    if (!sourcePattern.test(request.path)) throw new ServiceError('LANGUAGE_UNSUPPORTED', 'Only TypeScript/JavaScript are available; Python requires a real configured backend')
    if (request.query !== undefined && (typeof request.query !== 'string' || request.query.length > 120)) throw new ServiceError('INVALID_REQUEST', 'symbol query must contain at most 120 characters')
    const limit = bounded(request.limit, 80, 1, 200, 'limit')
    const maxOutputBytes = bounded(options.maxOutputBytes, 24000, 2048, 65536, 'maxOutputBytes')
    image = new ReadImage(options, started)
    image.initialize(root)
    const file = image.requireProjectFile(request.path)
    if (request.expectedFileVersion && file.version !== request.expectedFileVersion) throw new ServiceError('STALE_FILE_VERSION', 'Source bytes no longer match expectedFileVersion')
    const config = configuration(image, options)
    const configErrors = [...config.errors]
    // If parsing fails, diagnostics still expose real TS configuration errors without a fictitious semantic program.
    if (!config.files.some(path => key(image!.realpath(path)) === key(file.path)) && !configErrors.length) throw new ServiceError('FILE_NOT_IN_PROJECT', 'Requested file is not included in this configuration')
    if (configErrors.length && request.kind !== 'diagnostics') throw new ServiceError('CONFIGURATION_ERROR', ts.flattenDiagnosticMessageText(configErrors[0].messageText, '\n').slice(0, 500))
    const snapshotMs = performance.now() - started
    const initStart = performance.now()
    const view = image
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => config.options,
      getCurrentDirectory: () => view.root,
      getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
      getScriptFileNames: () => config.files,
      getScriptVersion: path => view.read(path)?.version ?? 'missing',
      getScriptSnapshot: path => { const source = view.read(path); return source ? ts.ScriptSnapshot.fromString(source.text) : undefined },
      getProjectVersion: () => 'immutable-per-query',
      useCaseSensitiveFileNames: () => caseSensitive,
      readFile: path => view.read(path)?.text,
      fileExists: path => view.exists(path, false),
      directoryExists: path => view.exists(path, true),
      getDirectories: view.getDirectories,
      readDirectory: view.readDirectory,
      realpath: view.realpath,
      getCancellationToken: () => ({ isCancellationRequested: () => { view.check(); return false }, throwIfCancellationRequested: () => view.check() }),
    }
    service = ts.createLanguageService(host, ts.createDocumentRegistry(caseSensitive, image.root))
    const serviceInitMs = performance.now() - initStart
    const queryStart = performance.now()
    const items: CodeServiceItem[] = []
    let truncated = false, omittedExternalResults = 0
    const seen = new Set<string>()
    const location = (path: string, span: ts.TextSpan): CodeLocation | undefined => {
      view.check()
      const source = view.read(path)
      if (!source || !inside(view.root, source.path) || ignoredPath(view.root, source.path)) { omittedExternalResults++; return undefined }
      const sf = service!.getProgram()?.getSourceFile(source.path) ?? ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true)
      const begin = sf.getLineAndCharacterOfPosition(Math.min(span.start, source.text.length))
      const end = sf.getLineAndCharacterOfPosition(Math.min(span.start + span.length, source.text.length))
      return { path: source.label, version: source.version, start: { line: begin.line + 1, column: begin.character + 1 }, end: { line: end.line + 1, column: end.character + 1 } }
    }
    const append = (item: CodeServiceItem) => {
      const id = JSON.stringify(item)
      if (seen.has(id)) return
      if (items.length >= limit) { truncated = true; return }
      seen.add(id)
      items.push(item)
    }
    const position = () => {
      if (!Number.isInteger(request.line) || !Number.isInteger(request.column) || request.line! < 1 || request.column! < 1) throw new ServiceError('INVALID_POSITION', 'line/column must be 1-based UTF-16 integers')
      const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest)
      const lines = sf.getLineStarts()
      if (request.line! > lines.length) throw new ServiceError('INVALID_POSITION')
      const begin = lines[request.line! - 1]
      const end = (lines[request.line!] ?? file.text.length)
      const lineText = file.text.slice(begin, end).replace(/\r?\n$/, '')
      if (request.column! > lineText.length + 1) throw new ServiceError('INVALID_POSITION')
      return begin + request.column! - 1
    }
    view.check()
    if (request.kind === 'definition') {
      for (const entry of service.getDefinitionAtPosition(file.path, position()) ?? []) {
        const value = location(entry.fileName, entry.textSpan)
        if (value) append({ kind: 'definition', name: entry.name.slice(0, 240), symbolKind: entry.kind, location: value })
      }
    } else if (request.kind === 'references') {
      for (const group of service.findReferences(file.path, position()) ?? []) for (const entry of group.references) {
        view.check()
        if (request.includeDeclaration === false && entry.isDefinition) continue
        const value = location(entry.fileName, entry.textSpan)
        if (value) append({ kind: 'reference', isDefinition: entry.isDefinition ?? false, isWriteAccess: entry.isWriteAccess, location: value })
      }
    } else if (request.kind === 'symbol') {
      const filter = request.query?.toLowerCase()
      const visit = (node: ts.NavigationTree, container: string) => {
        view.check()
        if (!filter || node.text.toLowerCase().includes(filter)) for (const span of node.nameSpan ? [node.nameSpan] : node.spans) {
          const value = location(file.path, span)
          if (value) append({ kind: 'symbol', name: node.text.slice(0, 240), symbolKind: node.kind, container: container.slice(0, 240), location: value })
        }
        for (const child of node.childItems ?? []) visit(child, container ? `${container}.${node.text}` : node.text)
      }
      for (const node of service.getNavigationTree(file.path).childItems ?? []) visit(node, '')
    } else {
      const diagnostics = [...configErrors]
      if (!configErrors.length) diagnostics.push(...service.getCompilerOptionsDiagnostics(), ...service.getSyntacticDiagnostics(file.path), ...service.getSemanticDiagnostics(file.path))
      for (const diagnostic of diagnostics) {
        view.check()
        const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        const value = diagnostic.file && diagnostic.start !== undefined ? location(diagnostic.file.fileName, { start: diagnostic.start, length: diagnostic.length ?? 0 }) : undefined
        append({ kind: 'diagnostic', code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(), message: text.slice(0, 1200), messageTruncated: text.length > 1200, ...(value ? { location: value } : {}) })
      }
    }
    const queryMs = performance.now() - queryStart
    const validationStart = performance.now()
    const configurationIdentity = { config: config.config?.label ?? null, options: config.options, roots: config.files.map(path => key(view.realpath(path))).sort(), dependencyRoots: view.dependencyRoots.map(key).sort() }
    view.validate()
    const indexVersion = view.version(configurationIdentity)
    if (request.expectedIndexVersion && request.expectedIndexVersion !== indexVersion) throw new ServiceError('STALE_INDEX_VERSION', 'Observed project/config/module inputs no longer match expectedIndexVersion')
    const validationMs = performance.now() - validationStart
    const result: CodeServiceSuccess = {
      ok: true, backend: 'typescript-language-service', typescriptVersion: ts.version, kind: request.kind,
      language: /\.(?:[cm]?js|jsx)$/i.test(file.path) ? 'javascript' : 'typescript', path: file.label, fileVersion: file.version, indexVersion,
      config: { path: config.config?.label ?? null, version: config.config?.version ?? null, mode: config.config ? 'configured' : 'inferred' },
      items, truncated, boundary: { deniedReads: view.denied.size, omittedExternalResults, examples: [...view.denied].sort().slice(0, 8) },
      observed: { files: view.files.size, bytes: view.bytes, projectFiles: view.projectFiles.length },
      timings: { snapshotMs, serviceInitMs, queryMs, validationMs, totalMs: performance.now() - started }, cache: 'fresh-language-service',
      limitations: [
        'Read-only compiler LanguageService, not LSP, formal verification or a business PASS. No emit, plugins, project scripts or models.',
        'Fresh bounded service per query; no cross-query incremental cache. Timings are local observations, not end-to-end efficiency claims.',
        'Cancellation/deadline is cooperative in synchronous TypeScript/Node code, not a hard interrupt or an OS sandbox. No atomic multi-file snapshot.',
        'Project references are unsupported. External dependency/library locations are omitted; denied reads and missing modules reduce resolution scope.',
      ],
    }
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxOutputBytes && result.items.length) { result.items.pop(); result.truncated = true }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxOutputBytes) throw new ServiceError('OUTPUT_BYTE_LIMIT', 'Metadata exceeds output byte limit')
    return result
  } catch (error) {
    const known = error instanceof ServiceError
    const code = known ? error.code : error instanceof ts.OperationCanceledException ? 'CANCELLED' : 'BACKEND_FAILURE'
    return { ok: false, backend: 'typescript-language-service', error: { code, message: known ? error.message.slice(0, 800) : 'Semantic backend failed; no partial or cached semantic result was returned. A later query creates a fresh backend.' } }
  } finally {
    // Backend disposal must not override a failure/return with an unstructured exception.
    try { service?.dispose() } catch { /* The per-query instance is never reused. */ }
  }
}
