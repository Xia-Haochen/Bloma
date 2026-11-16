import {checkNativeTestBindings} from './native-test-preflight'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { frozenNativeGuiRoot, type NativeGuiTests } from './native-gui-tests'
import { readSoftwareCandidate } from './release-store'

/** Keep the project layout and standard Node module lookup in a fresh owned
 * execution directory. The candidate/dependency bytes remain independently
 * verified; the immutable source snapshot is never edited to repair imports. */
export async function prepareNativeTestRuntime(projectId: string, native: NativeGuiTests, sourceRoot: string, workspace: string, signal?: AbortSignal) {
  const candidatePath = relative(join(getPromaHome(), 'software-releases', projectId), resolve(sourceRoot)).split(sep)
  // Read owned provenance only. Correction probes deliberately stage proposed
  // tests in an unpublished candidate; their caller pins that staged inventory.
  // Native input checks below bind every frozen byte, including both launch
  // identities. Formal verification/publication owns whole-release validation.
  const candidate = candidatePath.length === 2 && /^[a-f0-9]{64}$/.test(candidatePath[0]) && candidatePath[1] === 'app'
    ? await readSoftwareCandidate(projectId, candidatePath[0], signal, false) : undefined
  const frozen = frozenNativeGuiRoot(projectId, native, sourceRoot, candidate)
  checkNativeTestBindings(frozen,native.files.map(f=>f.path),sourceRoot)
  const rel = relative(join(getPromaHome(), 'software-debug-data', projectId), realpathSync(workspace))
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw Error('GUI_NATIVE_EXECUTION_DIRECTORY_INVALID')
  const root = mkdtempSync(join(workspace, 'native-inputs-'))
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
  for (const file of native.files) {
    const target = join(root, file.path)
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(frozen, file.path), target)
  }
  const dependencies = join(sourceRoot, 'node_modules'), link = join(root, 'node_modules')
  const dependencyRoot = existsSync(dependencies) ? realpathSync(dependencies) : undefined
  if (dependencyRoot) symlinkSync(dependencyRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
  const verify = () => {
    frozenNativeGuiRoot(projectId, native, sourceRoot, candidate)
    for (const file of native.files) {
      let cursor = root
      for (const part of file.path.split('/')) {
        cursor = join(cursor, part)
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw Error('GUI_NATIVE_LINK_UNSUPPORTED')
      }
      const target = join(root, file.path)
      if (!existsSync(target) || lstatSync(target).isSymbolicLink() || lstatSync(target).size !== file.size || sha(target) !== file.sha256) throw Error(`GUI_NATIVE_INPUT_CHANGED: ${file.path}`)
    }
    if (dependencyRoot && (!existsSync(link) || !lstatSync(link).isSymbolicLink() || realpathSync(link) !== dependencyRoot)) throw Error('GUI_NATIVE_DEPENDENCY_LINK_CHANGED')
  }
  return { file: join(root, native.entry), verify, close: () => {
    if (dependencyRoot && existsSync(link)) {
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== dependencyRoot) throw Error('GUI_NATIVE_DEPENDENCY_LINK_CHANGED')
      unlinkSync(link)
    }
  } }
}
