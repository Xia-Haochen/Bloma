/** Test-only harness, never imported by production or exposed over IPC. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgentLoop } from '../../main/agent/loop/agent-loop'
import { createProductionBudget } from '../../main/desktop/production-budget'
import { resolveChannelEnv } from '../../main/platform/llm/runtime-fallback'
import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query'
import { readProjectUsage } from '../../main/platform/llm/request-ledger'

export async function verifyChannelProtocolRuntime(input: { home: string; origin: string; channelId: string; runId: string }) {
  // Refuse before reading channels/decrypting any secret unless this is the caller's isolated home.
  assert.equal(process.env.PROMA_HOME, input.home)
  const origin = new URL(input.origin)
  assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1')
  const route = resolveChannelEnv({ channelId: input.channelId, category: 'guide' })
  assert.ok(route.env, `Configured test route unavailable: ${route.unusableReason}`); assert.equal(route.channel?.id, input.channelId)
  assert.equal(new URL(route.env.ANTHROPIC_BASE_URL).origin, origin.origin)
  const executions: string[] = [], projectId = 'protocol-' + input.runId
  const budget = createProductionBudget(projectId, input.runId, 'desktop-implement')
  const query = budget.wrap(async function* (prompt, options) {
    yield* anthropicMessagesQueryViaProviders(prompt, { ...options, requestGuard: request => {
      assert.equal(new URL(request.url).origin, origin.origin)
      options.requestGuard?.(request)
    } })
  })
  for (const path of ['alpha.txt', 'beta.txt']) writeFileSync(join(input.home, path), 'fixture-' + path)
  let observedProtocol: string | undefined
  const result = await runAgentLoop({ runtimeScope: 'desktop-implement', projectId, sessionId: projectId, requestId: input.runId,
    system: 'Read the two supplied fixture files through the read_file tool, then report.', task: 'Read fixtures.',
    tools: [{ name: 'read_file', description: 'Read one local fixture file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async args => { const path = String(args.path); assert.ok(['alpha.txt', 'beta.txt'].includes(path)); executions.push(path); return { output: readFileSync(join(input.home, path), 'utf8') } } }],
    query, env: route.env, maxTokens: 4096, maxTurns: 4, permissionMode: 'allow-all', signal: AbortSignal.timeout(30000), publish: () => {},
    onRuntimeObservation: observation => { observedProtocol = observation.route.protocol } })
  assert.equal(result.status, 'completed'); assert.equal(result.finalText, '两份文件已读取')
  assert.deepEqual(executions, ['alpha.txt', 'beta.txt'])
  assert.equal(budget.snapshot().requests, 2)
  const usage = readProjectUsage(projectId)
  assert.equal(usage.physical_requests, 2); assert.equal(usage.complete, true)
  assert.equal(usage.reported_input, 200); assert.equal(usage.reported_output, 20); assert.equal(usage.cache_read, 80)
  return { status: result.status, protocol: observedProtocol, executions, requests: budget.snapshot().requests,
    usage: { input: usage.reported_input, output: usage.reported_output, cacheRead: usage.cache_read, complete: usage.complete } }
}
