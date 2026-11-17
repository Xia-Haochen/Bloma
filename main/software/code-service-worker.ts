import { parentPort, workerData } from 'node:worker_threads'
import { queryCodeService, type CodeServiceRequest } from './code-service'
// Private host entry, not a model-controlled code execution surface. The compiler
// performs no emit/project scripts/plugins. Worker termination bounds CPU time.
const input = workerData as { root: string; request: CodeServiceRequest }
if (!parentPort) throw Error('CODE_SERVICE_WORKER_ENTRY_REQUIRED')
parentPort.postMessage(queryCodeService(input.root, input.request, { timeoutMs: 10000 }))
