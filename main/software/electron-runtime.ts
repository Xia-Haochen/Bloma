import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { execFileDriverSpawn, buildDriverEnv } from '../desktop/process-driver'
import { runtimeDirectoryDigest, type ManagedRuntime } from './runtime-bindings'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const { cpSync, existsSync, mkdirSync, readFileSync }: typeof nodeFs = process.versions.electron ? require('original-fs') : nodeFs
const semver = createRequire(require.resolve('npm/package.json'))('semver') as { validRange(value: string): string | null; satisfies(version: string, range: string): boolean }
export function electronConstraint(root: string): string | undefined {
  const file = join(root, 'package.json'); if (!existsSync(file)) return
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  const value = pkg.dependencies?.electron ?? pkg.devDependencies?.electron
  if (value !== undefined && (typeof value !== 'string' || !semver.validRange(value))) throw Error('PROJECT_ELECTRON_VERSION_INVALID')
  const lockFile = join(root, 'package-lock.json')
  if (value !== undefined && existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
    const pinned = lock.packages?.['node_modules/electron']?.version ?? lock.dependencies?.electron?.version
    if (pinned !== undefined) {
      if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned) || !semver.satisfies(pinned, value)) throw Error('PROJECT_ELECTRON_LOCK_MISMATCH')
      return pinned
    }
  }
  return value
}
export function assertElectronVersion(root: string, version: string) {
  const constraint = electronConstraint(root)
  if (constraint && !semver.satisfies(version, constraint)) throw Error(`RUNTIME_PROJECT_ENGINE_MISMATCH: ${version} / ${constraint}`)
}
export function hostElectronDistribution(): string | undefined {
  try { return join(dirname(require.resolve('electron/package.json')), 'dist') } catch { return undefined }
}
/** Explicit preparation only: import a complete generic distribution, never process.execPath. */
export async function importElectronRuntime(root: string, request: string, signal?: AbortSignal): Promise<ManagedRuntime> {
  const candidates = [join(root, 'node_modules/electron/dist'), hostElectronDistribution()].filter((path): path is string => Boolean(path))
  for (const source of candidates) {
    if (!existsSync(join(source, 'version'))) continue
    const version = readFileSync(join(source, 'version'), 'utf8').trim().replace(/^v/, '')
    if (!semver.satisfies(version, request)) continue
    assertElectronVersion(root, version)
    for (const path of ['electron.exe', 'resources/default_app.asar', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak']) {
      if (!existsSync(join(source, path))) throw Error(`ELECTRON_DISTRIBUTION_INCOMPLETE: ${path}`)
    }
    const before = runtimeDirectoryDigest(source)
    const directory = join(getPromaHome(), 'software-runtimes', 'installations', randomUUID())
    mkdirSync(dirname(directory), { recursive: true }); signal?.throwIfAborted()
    cpSync(source, directory, { recursive: true, dereference: false })
    if (runtimeDirectoryDigest(directory) !== before || runtimeDirectoryDigest(source) !== before) throw Error('ELECTRON_DISTRIBUTION_CHANGED_DURING_COPY')
    const executable = join(directory, 'electron.exe')
    const probe = await execFileDriverSpawn({ command: [executable, '-p', 'JSON.stringify({version:process.versions.electron,platform:process.platform,arch:process.arch})'], cwd: directory,
      env: { ...buildDriverEnv({ env_whitelist: [] } as never, process.env), ELECTRON_RUN_AS_NODE: '1' }, signal, timeoutMs: 15000 })
    const actual = JSON.parse(probe.stdout.trim())
    if (probe.code !== 0 || actual.version !== version || actual.platform !== process.platform || actual.arch !== process.arch || runtimeDirectoryDigest(directory) !== before) throw Error('ELECTRON_RUNTIME_PROBE_FAILED')
    return { kind: 'electron', version, executable, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'), directory_sha256: before,
      platform: process.platform, arch: process.arch, request, source, license: 'Electron distribution LICENSE and LICENSES.chromium.html', at: new Date().toISOString() }
  }
  throw Error(`ELECTRON_COMPATIBLE_DISTRIBUTION_MISSING: ${request}; prepare a matching complete project distribution`)
}
