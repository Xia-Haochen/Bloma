import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
const { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, readdirSync, lstatSync }: typeof nodeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'

export type RuntimeKind = 'node' | 'python' | 'electron'
export interface ManagedRuntime { kind: RuntimeKind; version: string; executable: string; sha256: string; platform: string; arch: string;
  abi?: string; request: string; source: string; archive_sha256?: string; directory_sha256?: string; license: string; at: string }
/** Hash every physical distribution file; reject links rather than following mutable external resources. */
export function runtimeDirectoryDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), info = lstatSync(file)
      if (info.isSymbolicLink()) throw Error('RUNTIME_DIRECTORY_LINK_UNSUPPORTED')
      if (info.isDirectory()) visit(file)
      else if (info.isFile()) hash.update(JSON.stringify([relative(root, file).split(sep).join('/'), info.size, digest(file)]))
      else throw Error('RUNTIME_DIRECTORY_ENTRY_UNSUPPORTED')
    }
  }
  visit(root); return hash.digest('hex')
}
function bindingsFile(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('RUNTIME_PROJECT_INVALID')
  return join(getPromaHome(), 'software-environments', projectId, 'runtimes.json')
}
function digest(file: string) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(file, 'r')
  try { let length: number; while ((length = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length)); return hash.digest('hex') }
  finally { closeSync(fd) }
}
export function validateManagedRuntime(value: ManagedRuntime): ManagedRuntime {
  const root = realpathSync(join(getPromaHome(), 'software-runtimes')), file = realpathSync(value.executable), rel = relative(root, file)
  if (!['node', 'python', 'electron'].includes(value.kind) || value.platform !== process.platform || value.arch !== process.arch
    || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !/^[a-f0-9]{64}$/.test(value.sha256) || digest(file) !== value.sha256) throw Error('MANAGED_RUNTIME_CHANGED_OR_OUTSIDE_STORE')
  if (value.kind === 'electron' && (!value.directory_sha256 || runtimeDirectoryDigest(dirname(file)) !== value.directory_sha256)) throw Error('MANAGED_RUNTIME_DIRECTORY_CHANGED')
  return value
}
export function managedRuntime(projectId: string, kind: RuntimeKind): ManagedRuntime | undefined {
  const file = bindingsFile(projectId); if (!existsSync(file)) return
  const values = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<RuntimeKind, ManagedRuntime>>
  return values[kind] ? validateManagedRuntime(values[kind]!) : undefined
}
export function bindManagedRuntime(projectId: string, value: ManagedRuntime) {
  validateManagedRuntime(value)
  const file = bindingsFile(projectId), values = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  writeTextFileAtomic(file, JSON.stringify({ ...values, [value.kind]: value }))
}
export function managedRuntimeDirectories(projectId: string): string[] {
  return [...new Set((['node', 'python'] as const).map(kind => managedRuntime(projectId, kind)).filter(Boolean).map(value => dirname(value!.executable)))]
}
export function runtimeBindingVersion(projectId: string) {
  const file = bindingsFile(projectId)
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'none'
}
