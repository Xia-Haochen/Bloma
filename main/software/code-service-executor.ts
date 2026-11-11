import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mainRootDir } from '../platform/paths'
import type { CodeServiceRequest, CodeServiceResult } from './code-service'
let active = 0
const failure = (code: string, message: string): CodeServiceResult => ({ ok: false, backend: 'typescript-language-service', error: { code, message } })
/** Two read-only compiler workers maximum. Not another business lifecycle or
 * permission source: root comes exclusively from the existing project tool. */
export async function executeCodeService(root: string, request: CodeServiceRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CodeServiceResult> {
  if (options.signal?.aborted) return failure('CANCELLED', 'Semantic query cancelled before starting')
  const timeout = options.timeoutMs ?? 15000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) return failure('INVALID_OPTIONS', 'Worker deadline must be 1..30000ms')
  if (active >= 2) return failure('CODE_SERVICE_BUSY', 'Two semantic workers are already active; no query started')
  const main = mainRootDir(), deployed = join(main, 'software/code-service-worker.mjs')
  // Source tests use the exact same production-built worker, not a fake service.
  const file = existsSync(deployed) ? deployed : join(main, '../dist-main/main/software/code-service-worker.mjs')
  if (!existsSync(file)) return failure('CODE_SERVICE_WORKER_UNBUILT', 'Build the current main/semantic units; do not substitute old or inline code')
  active++
  try {
    return await new Promise<CodeServiceResult>(resolve => {
      let worker: Worker | undefined, settled = false, timer: ReturnType<typeof setTimeout> | undefined
      const finish = async (result: CodeServiceResult) => {
        if (settled) return
        settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
        await worker?.terminate().catch(() => undefined)
        worker?.removeAllListeners(); resolve(result)
      }
      const abort = () => { void finish(failure('CANCELLED', 'Read-only semantic worker terminated; no partial success returned')) }
      try {
        worker = new Worker(file, { name: 'bloma-code-service', workerData: { root, request }, execArgv: [], env: {},
          resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 } })
        worker.once('message', (result: CodeServiceResult) => {
          try {
            if (!result || typeof result.ok !== 'boolean' || result.backend !== 'typescript-language-service' && result.backend !== 'unavailable' || Buffer.byteLength(JSON.stringify(result)) > 65536) throw Error('invalid response')
            void finish(result)
          } catch { void finish(failure('CODE_SERVICE_PROTOCOL_ERROR', 'Compiler worker returned an invalid or oversized response')) }
        })
        worker.once('error', () => { void finish(failure('CODE_SERVICE_WORKER_ERROR', 'Compiler worker failed; no previous result was reused')) })
        worker.once('exit', () => { void finish(failure('CODE_SERVICE_WORKER_EXIT', 'Compiler worker exited before returning a result')) })
        timer = setTimeout(() => { void finish(failure('DEADLINE_EXCEEDED', 'Read-only compiler worker terminated at the host deadline')) }, timeout)
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
      } catch { void finish(failure('CODE_SERVICE_WORKER_ERROR', 'Could not start the production compiler worker')) }
    })
  } finally { active-- }
}
