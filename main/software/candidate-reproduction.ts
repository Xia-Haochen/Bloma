import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { readLaunchDeclaration, type LaunchDeclaration } from '../desktop/launch-smoke'
import { parseGuiSuite, type GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import { materializeGuiFixtures, MAX_GUI_FIXTURE_BYTES } from '../desktop/gui-fixtures'
import { verificationFingerprint } from '../desktop/verification-fingerprint'
import { copySoftwareCandidateRuntime, fileDigest, readSoftwareCandidate, runtimeInventory, type RuntimeInventory } from './release-store'
import { runtimeDirectoryDigest, managedRuntime, type ManagedRuntime } from './runtime-bindings'
import { ownedDirectory } from './owned-directory'
import { copyDataForPreview } from './data-update'
import { debugWorkspace } from './debug-workspace'
import { actDebugSession, closeDebugSession, openDebugSession, readDebugSession, retainedDebugObservation, type DebugSnapshot } from './debug-sessions'
import { isolatedBrowserLaunch } from './isolated-launch'

const PROTOCOL = 'software-reproduction-v1', MAX_METADATA = 16 * 1024 * 1024
const HEX = /^[a-f0-9]{64}$/, ID = /^[a-f0-9-]{36}$/
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const REPRODUCTION_CAPABILITIES = {
 protocol: PROTOCOL, verification: 'not_applicable', os_reset: 'not_attested', runtime_installation: 'not_automatic',
 transfer: 'physical candidate bytes including declared dependency files; unchanged LAUNCH.json; pinned host-only relocation overlay',
 limits: { files: 10000, app_bytes: 1024 ** 3, seed_bytes: 64 * 1024 ** 2, metadata_bytes: MAX_METADATA },
 gaps: ['not an OS/network sandbox', 'not a signed origin attestation or independent C/V', 'runtime adjacent libraries are bound only when directory_sha256 is declared; executable hashes alone are not whole-installation proof', 'embedded absolute paths are not rewritten', 'no implicit user data/profile/credential migration']
} as const
interface ReproductionManifest {
 protocol: typeof PROTOCOL; id: string; at: string; verification: 'not_applicable'
 origin: { project_id: string; candidate_id: string; source_digest: string; candidate_runtime_digest: string }
 producer: { platform: string; arch: string }; original_root: string
 app: RuntimeInventory; seed: RuntimeInventory; journey: GuiAcceptanceSuite
 external_files: Array<{ path: string; sha256: string }>; runtime?: ManagedRuntime
}
export interface ReproductionReference { projectId: string; id: string; manifestSha256: string }
function directory(projectId: string, id: string) {
 if (!/^[A-Za-z0-9_-]+$/.test(projectId) || !ID.test(id)) throw Error('REPRODUCTION_ID_INVALID')
 return ownedDirectory(getPromaHome(), ['software-reproductions', projectId, id])
}
function inventoryLimit(inventory: RuntimeInventory, seed = false) {
 if (inventory.files.length > 10000 || inventory.bytes > (seed ? 64 * 1024 ** 2 : 1024 ** 3)) throw Error('REPRODUCTION_SIZE_LIMIT')
}
function transportPreflight(inventory: RuntimeInventory) {
 inventoryLimit(inventory)
 for (const file of inventory.files) {
  // Refuse, do not silently redact/change an immutable candidate's bytes.
  if (file.path.split('/').some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|Local State|Cookies|Login Data)$/i.test(part)) || /\.(?:pem|key)$/i.test(file.path)) throw Error('REPRODUCTION_SECRET_REVIEW_REQUIRED')
 }
}
/** No downloads, publication, model calls or registry updates. Frozen fixture
 * bytes come only from the existing GUI fixture store or explicit suite text. */
export async function prepareCandidateReproduction(projectId: string, candidateId: string, suite: GuiAcceptanceSuite, signal?: AbortSignal) {
 const candidate = await readSoftwareCandidate(projectId, candidateId, signal)
 if (candidate.speech_resources) throw Error('REPRODUCTION_CAPABILITY_EXPORT_UNSUPPORTED')
 if (suite.native_tests) throw Error('REPRODUCTION_NATIVE_JOURNEY_UNSUPPORTED')
 const checked = parseGuiSuite(suite, { allowActionsOnly: true })
 if (checked.scope_hash !== verificationFingerprint(candidate.root)) throw Error('REPRODUCTION_FIXTURE_SCOPE_MISMATCH')
 let seedBytes=0
 for(const file of checked.fixtures??[]) {
  const bytes=file.text!==undefined?Buffer.byteLength(file.text):file.size
  if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_GUI_FIXTURE_BYTES||(seedBytes+=bytes)>64*1024**2)throw Error('REPRODUCTION_SIZE_LIMIT')
 }
 const id = randomUUID(), root = directory(projectId, id), appRoot = join(root, 'app'), seedRoot = ownedDirectory(root, ['seed'])
 const app = await copySoftwareCandidateRuntime(candidate, appRoot, signal, transportPreflight)
 materializeGuiFixtures(projectId, checked, seedRoot)
 const seed = await runtimeInventory(seedRoot, signal, {}, false, { includeIgnored: true }); inventoryLimit(seed, true)
 const kind = /^node(?:\.exe)?$/i.test(basename(candidate.launch.command[0])) ? 'node' : /^python(?:\.exe)?$/i.test(basename(candidate.launch.command[0])) ? 'python' : undefined
 const runtime = candidate.electron_runtime ?? (kind ? managedRuntime(projectId, kind) : undefined)
 const manifest: ReproductionManifest = {
  protocol: PROTOCOL, id, at: new Date().toISOString(), verification: 'not_applicable',
  origin: { project_id: projectId, candidate_id: candidateId, source_digest: candidate.source.digest, candidate_runtime_digest: app.digest },
  producer: { platform: process.platform, arch: process.arch }, original_root: candidate.root, app, seed,
  journey: { version: 1, scope_hash: checked.scope_hash, covers: checked.covers, steps: checked.steps },
  external_files: candidate.external_files ?? [], ...(runtime && runtime.executable === candidate.launch.command[0] ? { runtime } : {})
 }
 const text = JSON.stringify(manifest)
 if (Buffer.byteLength(text) > MAX_METADATA) throw Error('REPRODUCTION_METADATA_LIMIT')
 signal?.throwIfAborted(); await writeFile(join(root, 'manifest.json'), text, { flag: 'wx' })
 return { projectId, id, manifestSha256: sha(text), directory: root, capabilities: REPRODUCTION_CAPABILITIES }
}
async function pinnedManifest(root: string, expected: string): Promise<ReproductionManifest> {
 if (!HEX.test(expected)) throw Error('REPRODUCTION_MANIFEST_PIN_REQUIRED')
 const path = join(root, 'manifest.json'), info = await lstat(path)
 if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA || info.size < 2) throw Error('REPRODUCTION_METADATA_INVALID')
 const handle = await open(path, 'r')
 let bytes: Buffer
 try {
  const opened = await handle.stat(), buffer = Buffer.allocUnsafe(info.size + 1)
  let count = 0
  while (count < buffer.length) { const next = await handle.read(buffer, count, buffer.length - count, null); if (!next.bytesRead) break; count += next.bytesRead }
  const after = await handle.stat(), named = await lstat(path)
  if (count !== info.size || [opened, after, named].some(value => !value.isFile() || value.isSymbolicLink() || value.ino !== info.ino || value.dev !== info.dev || value.size !== info.size || value.mtimeMs !== info.mtimeMs || value.ctimeMs !== info.ctimeMs)) throw Error('REPRODUCTION_METADATA_CHANGED')
  bytes = buffer.subarray(0, count)
 } finally { await handle.close() }
 if (sha(bytes) !== expected) throw Error('REPRODUCTION_MANIFEST_PIN_MISMATCH')
 try { return JSON.parse(bytes.toString('utf8')) as ReproductionManifest } catch { throw Error('REPRODUCTION_METADATA_INVALID') }
}
/** The pin must arrive independently from the package (e.g. the export receipt).
 * Recomputing a pin from an untrusted package does not authenticate its origin. */
export async function inspectCandidateReproduction(reference: ReproductionReference, signal?: AbortSignal) {
 const root = directory(reference.projectId, reference.id), manifest = await pinnedManifest(root, reference.manifestSha256)
 if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.protocol !== PROTOCOL || manifest.id !== reference.id || manifest.origin?.project_id !== reference.projectId || manifest.verification !== 'not_applicable'
  || !HEX.test(manifest.origin?.candidate_id) || !HEX.test(manifest.origin?.source_digest) || !isAbsolute(manifest.original_root)
  || !Array.isArray(manifest.external_files) || manifest.external_files.length > 128 || manifest.external_files.some(file => !isAbsolute(file.path) || !HEX.test(file.sha256))) throw Error('REPRODUCTION_METADATA_INVALID')
 if (manifest.producer?.platform !== process.platform || manifest.producer.arch !== process.arch) throw Error('REPRODUCTION_PLATFORM_MISMATCH')
 const appRoot = ownedDirectory(root, ['app']), seedRoot = ownedDirectory(root, ['seed'])
 const app = await runtimeInventory(appRoot, signal, {}, false, { includeIgnored: true }), seed = await runtimeInventory(seedRoot, signal, {}, false, { includeIgnored: true })
 transportPreflight(app); inventoryLimit(seed, true)
 if (JSON.stringify(app) !== JSON.stringify(manifest.app) || app.digest !== manifest.origin.candidate_runtime_digest || JSON.stringify(seed) !== JSON.stringify(manifest.seed)) throw Error('REPRODUCTION_BYTES_CHANGED')
 const suite = parseGuiSuite(manifest.journey, { allowActionsOnly: true })
 if (suite.native_tests || suite.fixtures?.length || suite.scope_hash !== verificationFingerprint(appRoot)) throw Error('REPRODUCTION_JOURNEY_SCOPE_CHANGED')
 const declaration = readLaunchDeclaration(appRoot)
 if (!declaration?.ok) throw Error('REPRODUCTION_LAUNCH_INVALID')
 return { root, appRoot, seedRoot, manifest, suite, declaration: declaration.launch }
}
async function externalMappings(manifest: ReproductionManifest, runtimePaths: Record<string,string>, signal?:AbortSignal) {
 const mappings = new Map<string, string>()
 for (const file of manifest.external_files) {
  const supplied = runtimePaths[file.sha256]
  if (typeof supplied !== 'string' || !isAbsolute(supplied)) throw Error('REPRODUCTION_RUNTIME_MAPPING_REQUIRED')
  const target = await realpath(supplied)
  if (!(await lstat(target)).isFile() || await fileDigest(target, signal) !== file.sha256) throw Error('REPRODUCTION_RUNTIME_BYTES_CHANGED')
  if (manifest.runtime?.executable === file.path && manifest.runtime.directory_sha256 && runtimeDirectoryDigest(dirname(target)) !== manifest.runtime.directory_sha256) throw Error('REPRODUCTION_RUNTIME_DIRECTORY_CHANGED')
  mappings.set(file.path, target)
 }
 return mappings
}
export async function reproductionLaunch(reference: ReproductionReference, runtimePaths: Record<string, string>, signal?: AbortSignal) {
 const inspected = await inspectCandidateReproduction(reference, signal), { manifest, appRoot } = inspected
 const mappings = await externalMappings(manifest, runtimePaths, signal)
 const within = (base: string, path: string) => { const rel=relative(base,path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : undefined }
 const command = inspected.declaration.command.map(argument => {
  if (isAbsolute(argument)) {
   const rel = within(manifest.original_root, argument)
   if (rel !== undefined) return join(appRoot, rel)
   const mapped = mappings.get(argument)
   if (!mapped) throw Error('REPRODUCTION_EXTERNAL_ARGUMENT_UNDECLARED')
   return mapped
  }
  if (argument.includes(manifest.original_root) || argument.includes(manifest.original_root.replaceAll('\\','/')) || /=(?:[A-Za-z]:[\\/]|[\\/])/.test(argument)) throw Error('REPRODUCTION_EMBEDDED_ABSOLUTE_PATH_UNSUPPORTED')
  return argument
 })
 return { ...inspected, effective: await isolatedBrowserLaunch({ ...inspected.declaration, command }) }
}
/** Explicit one-shot host journey, not a resumable daemon or automatic replay.
 * The original debug/process/fixture evidence remains authoritative. */
export async function runCandidateReproduction(input: ReproductionReference & { executorProjectId: string; runtimePaths: Record<string, string>; signal: AbortSignal }) {
 const prepared = await reproductionLaunch(input, input.runtimePaths, input.signal), executionSession = `reproduction-${randomUUID()}`
 const workspace = debugWorkspace(input.executorProjectId, executionSession)
 await copyDataForPreview(prepared.seedRoot, join(workspace, 'data'))
 let snapshot: DebugSnapshot | undefined, failure: unknown
 try {
  snapshot = await openDebugSession({ projectId: input.executorProjectId, sessionId: executionSession, root: prepared.appRoot, launch: prepared.effective, declaration: prepared.declaration, signal: input.signal })
  if (snapshot.state === 'ready') snapshot = await actDebugSession({ projectId: input.executorProjectId, sessionId: executionSession, id: snapshot.id, steps: prepared.suite.steps, signal: input.signal })
 } catch(error) {
  failure=error
  // openDebugSession already closes and retains a failed startup. Read only
  // this freshly generated owner/session's evidence; never adopt its PID.
  if(!snapshot)try { const retained=retainedDebugObservation(input.executorProjectId,executionSession); if(retained)snapshot=readDebugSession(input.executorProjectId,executionSession,retained.id); if(snapshot?.state==='failed'&&!input.signal.aborted)failure=undefined } catch { /* preserve the original interruption */ }
 }
 finally { if (snapshot) { try { snapshot=await closeDebugSession(input.executorProjectId,executionSession,snapshot.id) } catch(error) { failure??=error } } }
 if(failure)throw Error(`REPRODUCTION_EXECUTION_INTERRUPTED: ${String(failure)}; startup/inputs may have had effects; do not replay; debug_session_id=${snapshot?.id??'unavailable'}`)
 try { const checked=await inspectCandidateReproduction(input,input.signal); await externalMappings(checked.manifest,input.runtimePaths,input.signal) }
 catch (error) { throw Error(`REPRODUCTION_POST_EXECUTION_INVALID: ${String(error)}; startup/inputs may have had effects; do not replay; debug_session_id=${snapshot?.id ?? 'unavailable'}`) }
 if(snapshot)snapshot=readDebugSession(input.executorProjectId,executionSession,snapshot.id,0,{limit:80})
 const attachments:Array<{path:string;bytes:number;sha256:string}>=[]
 let attachmentGap:string|undefined
 if(snapshot?.screenshot)try {
  const evidence=await realpath(join(workspace,'evidence')),path=await realpath(snapshot.screenshot),rel=relative(evidence,path),info=await lstat(snapshot.screenshot)
  if(info.isSymbolicLink()||!info.isFile()||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||info.size>20*1024**2)throw Error('REPRODUCTION_ATTACHMENT_OUTSIDE_SCOPE_OR_LIMIT')
  const digest=await fileDigest(path),after=await lstat(snapshot.screenshot)
  if(after.isSymbolicLink()||after.ino!==info.ino||after.dev!==info.dev||after.size!==info.size||after.ctimeMs!==info.ctimeMs||after.mtimeMs!==info.mtimeMs)throw Error('REPRODUCTION_ATTACHMENT_CHANGED')
  attachments.push({path:`evidence/${rel.split(sep).join('/')}`,bytes:info.size,sha256:digest})
 } catch(error){attachmentGap=String(error)}
 return { protocol: PROTOCOL, manifest_sha256: input.manifestSha256, origin: prepared.manifest.origin,
  evidence: {workspace,attachments,attachment_gap:attachmentGap,visual_review:'not_reviewed_by_model',transfer:'return this JSON and only listed relative attachments; do not copy the complete HOME/data/profile'},
  execution: { project_id: input.executorProjectId, session_id: executionSession, environment: 'directory-isolated', os_reset: 'not_attested', platform: process.platform, arch: process.arch },
  declared_launch: prepared.declaration, effective_launch: prepared.effective, debug: snapshot, verification: 'not_applicable' as const }
}
