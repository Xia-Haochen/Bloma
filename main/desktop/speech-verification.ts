import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { mainRootDir } from '../platform/paths'
import { speechModelRoot } from '../platform/speech/model-manifest'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint, declaredVerificationPolicy } from './verification-fingerprint'
import { createHash } from 'node:crypto'
import { isSoftwareProject } from './workflow-policy'
import { resolveSoftwareCommand, softwareEnvironment } from '../software/command-runtime'
import { executionSpeechBinding } from '../software/capability-bindings'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readSoftwareCandidate } from '../software/release-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'

export interface SpeechVerificationSpec { module: string; factory: string; method: string; rate_argument?: boolean; runtime?:'python' }
export interface SpeechVerificationResult {
  status: 'passed' | 'failed' | 'environment_blocked'
  probe_version: number
  real_decode_calls?: number
  tests?: Array<{ passed: boolean; name: string }>
  microphone?: { status: string; rms?: number; text?: string; device?: number; device_name?: string; seconds?: number }
  error?: string
}
function microphonePath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('invalid evidence project id')
  return join(getPromaHome(), 'host-evidence', `${projectId}-microphone.json`)
}
export function microphoneEvidenceVersion(projectId:string):string {
  const paths=[microphonePath(projectId),join(getPromaHome(),'host-evidence/speech-component.json')]
  return createHash('sha256').update(JSON.stringify(paths.map(path=>existsSync(path)?readFileSync(path,'utf8'):null))).digest('hex')
}
export function hasCurrentMicrophoneEvidence(projectId: string, root: string, speech: SpeechVerificationSpec): boolean {
  if (hasAcceptedSpeechComponent(root, speech)) return true
  try {
    const saved = JSON.parse(readFileSync(microphonePath(projectId), 'utf8'))
    const fingerprint = verificationFingerprint(root, null, declaredVerificationPolicy(root))
    return Boolean(fingerprint && saved.fingerprint === fingerprint && saved.spec === JSON.stringify(speech) &&
      (saved.result?.microphone?.status === 'passed' || saved.feedback?.source === 'user_observation'
        && saved.feedback?.accepted === true && saved.result?.status === 'passed'
        && saved.result?.tests?.length === 3 && saved.result.tests.every((test:{passed:boolean})=>test.passed)
        && saved.result?.microphone?.text?.trim() && saved.result?.microphone?.rms >= .001)
      && saved.result?.real_decode_calls >= 4 &&
      Date.now() - Date.parse(saved.at) >= 0 && Date.now() - Date.parse(saved.at) < 24 * 60 * 60 * 1000)
  } catch { return false }
}

/** Only the host's prepared Python capture/decode path can carry physical
 * proof across changes to application JavaScript. Its interpreter, imports,
 * models and bridge remain pinned. The product capture controls, playback,
 * security and release checks still execute against the current candidate. */
export async function hasReusableMicrophoneEvidence(projectId: string, root: string, speech: SpeechVerificationSpec, signal?: AbortSignal): Promise<boolean> {
  if (hasCurrentMicrophoneEvidence(projectId, root, speech)) return true
  if (!/^[A-Za-z0-9_-]+$/.test(projectId) || speech.module !== 'speech_runtime'
    || speech.factory !== 'SpeechEngine' || speech.method !== 'transcribe') return false
  try {
    const attempt = JSON.parse(readFileSync(join(getPromaHome(), 'assisted-acceptance', projectId, 'current.json'), 'utf8'))
    const project = findProject(projectId)
    if (attempt.project_id !== projectId || attempt.phase !== 'passed' || attempt.operation_id !== project.lean_operation_id
      || attempt.scope !== prdScopeFingerprint(readPrdBackplane(projectId))) return false
    const currentId = basename(dirname(root))
    if (!/^[a-f0-9]{64}$/.test(currentId) || currentId === attempt.candidate_id) return false
    const previous = await readSoftwareCandidate(projectId, attempt.candidate_id, signal)
    if (!hasCurrentMicrophoneEvidence(projectId, previous.root, speech)) return false
    const current = await readSoftwareCandidate(projectId, currentId, signal)
    if (resolve(current.root) !== resolve(root) || JSON.stringify(current.launch) !== JSON.stringify(previous.launch)) return false
    if (!previous.speech_resources || JSON.stringify(current.speech_resources) !== JSON.stringify(previous.speech_resources)) return false
    const templates = join(mainRootDir(), 'templates', 'tools')
    const components = ['speech_runtime.py', 'speech_locator.py', 'speech_worker.py', 'speech_bridge.cjs']
    if (!components.every(name => readFileSync(join(root, name)).equals(readFileSync(join(templates, name)))
      && readFileSync(join(previous.root, name)).equals(readFileSync(join(templates, name))))) return false
    // The fixed speech probe imports the trusted Python path directly, not
    // the Electron main/renderer or Node diagnostics. Keep dependency trees
    // byte-identical and retain every non-JavaScript input conservatively.
    const inputs = (files: typeof current.runtime.files) => files.filter(file =>
      file.path.startsWith('.venv/') || file.path.startsWith('node_modules/') || !/\.(?:js|mjs|cjs)$/i.test(file.path))
    return JSON.stringify(inputs(current.runtime.files)) === JSON.stringify(inputs(previous.runtime.files))
  } catch (error) {
    if (signal?.aborted) throw error
    return false
  }
}

function hasAcceptedSpeechComponent(root: string, speech: SpeechVerificationSpec): boolean {
  if (speech.module !== 'speech_runtime' || speech.factory !== 'SpeechEngine' || speech.method !== 'transcribe') return false
  try {
    const accepted = JSON.parse(readFileSync(join(getPromaHome(), 'host-evidence/speech-component.json'), 'utf8'))
    const age = Date.now() - Date.parse(accepted.at)
    if (accepted.source !== 'user_acceptance' || accepted.scope !== 'component_capture_and_decode' || age < 0 || age >= 24 * 60 * 60 * 1000) return false
    return ['speech_runtime.py', 'speech_locator.py'].every(name => accepted.component_sha256?.[name] ===
      createHash('sha256').update(readFileSync(join(root, name))).digest('hex'))
  } catch { return false }
}

/** Human acceptance is a separate evidence source; original automatic results remain unchanged. */
export function recordManualSpeechComponentAcceptance(evidencePath: string, reason: string): void {
  const observed = JSON.parse(readFileSync(evidencePath, 'utf8'))
  if (observed.source !== 'user_started_component_gui' || observed.samples <= 0 || !observed.text || observed.errors?.length) throw new Error('No completed capture/decode observation to accept')
  const dir = join(getPromaHome(), 'host-evidence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'speech-component.json'), JSON.stringify({ source: 'user_acceptance', scope: 'component_capture_and_decode',
    at: new Date().toISOString(), reason, component_sha256: observed.component_sha256, automatic_reference_status: observed.status,
    observed_rms: observed.rms, raw_audio_saved: false }, null, 2))
}

/** Only an explicitly authorized caller passes microphone=true. Normal delivery never records. */
export async function runHostSpeechProbe(options: { projectId: string; root: string; speech: SpeechVerificationSpec; microphone?: boolean; controlDir?: string; persistEvidence?: boolean; spawn?: DriverSpawn; signal?: AbortSignal }): Promise<SpeechVerificationResult> {
  const { root, speech } = options
  try {
    options.signal?.throwIfAborted()
    if(speech.runtime!==undefined&&speech.runtime!=='python')throw Error('ASR_RUNTIME_UNSUPPORTED: 当前支持Python provider；Node产品可用已准备的文件转写桥')
    if (!speech || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(speech.module) ||
        !/^[A-Za-z_]\w*$/.test(speech.factory) || !/^[A-Za-z_]\w*$/.test(speech.method) ||
        !existsSync(join(root, ...speech.module.split('.'))) && !existsSync(join(root, `${speech.module.replace(/\./g, '/')}.py`))) {
      throw new Error('语音模块/工厂/方法声明不可用')
    }
    const policy = declaredVerificationPolicy(root), fingerprint = verificationFingerprint(root, null, policy)
    if (!fingerprint) throw new Error('语音源码版本不可确认')
    const tools = join(mainRootDir(), 'templates/tools')
    const arguments_ = ['python', '-I', '-B', '-X', 'utf8', join(tools, 'speech_probe.py'),
      '--root', root, '--module', speech.module, '--factory', speech.factory, '--method', speech.method,
      '--fixture', join(tools, 'voice-golden.wav'), ...(speech.rate_argument ? ['--rate-argument'] : []),
      ...(options.microphone ? ['--microphone'] : []), ...(options.controlDir ? ['--control-dir', options.controlDir] : [])]
    let software=false
    try{software=isSoftwareProject(options.projectId)}catch{/* standalone/legacy probes retain their explicit environment */}
    if(software&&!executionSpeechBinding(options.projectId,root))throw Error('ASR_CAPABILITY_PREPARATION_REQUIRED: 先prepare_software_capability绑定项目Python与模型资源')
    const env = software?softwareEnvironment(options.projectId,undefined,root):buildDriverEnv({ env_whitelist: ['BLOMA_SPEECH_MODEL_DIR'] } as never, process.env)
    const command=software?resolveSoftwareCommand(root,arguments_,env).command:resolveDriverVenvCommand(arguments_,root)
    if (software && env.BLOMA_SPEECH_PYTHON) command[0] = env.BLOMA_SPEECH_PYTHON
    env.BLOMA_SPEECH_MODEL_DIR ||= speechModelRoot()
    env.BLOMA_SPEECH_OFFLINE = '1'
    const execution = await (options.spawn ?? execFileDriverSpawn)({ command, cwd: root, env, timeoutMs: options.controlDir ? 300000 : 90000, signal: options.signal })
    options.signal?.throwIfAborted()
    const last = execution.stdout.trim().split(/\r?\n/).at(-1) ?? ''
    const result = JSON.parse(last) as SpeechVerificationResult
    if (result.probe_version !== 1 || !['passed', 'failed', 'environment_blocked'].includes(result.status)) throw new Error('宿主音频探针未返回有效报告')
    if (result.status === 'passed' && (execution.code !== 0 || (result.real_decode_calls ?? 0) < 3 || result.tests?.length !== 3 || !result.tests.every(test => test.passed))) {
      throw new Error('缺少真实模型解码与固定反例通过证据')
    }
    if (verificationFingerprint(root, null, policy) !== fingerprint) throw new Error('探针期间语音源码变化，本轮作废')
    if (options.persistEvidence !== false && options.microphone && result.status === 'passed' && result.microphone?.status === 'passed') {
      saveMicrophoneEvidence(options.projectId, root, speech, result)
    }
    return result
  } catch (error) {
    if (options.signal?.aborted) throw error
    return { status: 'environment_blocked', probe_version: 1, error: error instanceof Error ? error.message : String(error) }
  }
}

export function saveMicrophoneEvidence(projectId: string, root: string, speech: SpeechVerificationSpec, result: SpeechVerificationResult, feedback?: {attempt_id:string;candidate_id:string}) {
  const confirmed=feedback && result.tests?.length===3 && result.tests.every(test=>test.passed)
    && !!result.microphone?.text?.trim() && (result.microphone?.rms??0)>=.001
  if (result.status !== 'passed' || result.microphone?.status !== 'passed' && !confirmed || (result.real_decode_calls ?? 0) < 4) throw Error('MICROPHONE_EVIDENCE_INCOMPLETE')
  const path = microphonePath(projectId)
  mkdirSync(join(getPromaHome(), 'host-evidence'), {recursive:true})
  const fingerprint = verificationFingerprint(root,null,declaredVerificationPolicy(root))
  if (!fingerprint) throw Error('MICROPHONE_SOURCE_UNVERIFIED')
  writeTextFileAtomic(path, JSON.stringify({fingerprint,spec:JSON.stringify(speech),at:new Date().toISOString(),result,
    ...(feedback?{feedback:{...feedback,source:'user_observation',accepted:true}}:{})}))
}
