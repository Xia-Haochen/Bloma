import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startChannelProtocolServer } from '../../scripts/fixtures/channel-protocol-server.mjs'
import { verifyChannelProtocolRuntime } from '../../scripts/fixtures/verify-channel-protocol-runtime'
import { createChannel, buildSdkEnv, testChannelDirect, fetchModels } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query'
import { readProjectUsage } from '../../main/platform/llm/request-ledger'
import { getSdkQuery } from '../../main/orchestration/stages/sdk-glue'
import { resolveChannelEnv } from '../../main/platform/llm/runtime-fallback'
import { resetCategoryRoutingForTests, updateCategoryRoutingRoles } from '../../main/platform/llm/category-routing'
import { setSseRetryWaitBudgetForTests } from '../../main/platform/upstream/providers/sse-reader'
import type { ChannelProtocol, ProviderType } from '../../shared/types'
import type { SDKQueryOptions, SDKQuery } from '../../main/orchestration/stages/orchestration-contracts'

let home: string, previous: string | undefined, provider: Awaited<ReturnType<typeof startChannelProtocolServer>>
beforeEach(async () => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-protocol-http-')); process.env.PROMA_HOME = home
  setSafeStorageAdapter({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from('enc:' + value), decryptString: value => value.toString().slice(4) })
  resetCategoryRoutingForTests(); setSseRetryWaitBudgetForTests(0)
  provider = await startChannelProtocolServer()
})
afterEach(async () => { await provider.close(); resetCategoryRoutingForTests(); setSseRetryWaitBudgetForTests(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
function seed(provider_type: ProviderType, protocol?: ChannelProtocol) {
  const effective = protocol ?? (provider_type === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions')
  return createChannel({ name: '27B', provider_type, protocol, base_url: provider.origin + (effective === 'anthropic-messages' ? '/prefix/v2/messages?route=fixture' : '/prefix/v1/chat/completions?route=fixture'),
    api_key: 'loopback-only-key', models: [{ id: 'local-any', name: 'any-id-27b', enabled: true, max_output_tokens: 4096 }] })
}
const matrix: Array<[ProviderType, ChannelProtocol | undefined, string]> = [
  ['qwen', undefined, 'openai-chat-completions'], ['custom', undefined, 'openai-chat-completions'],
  ['google', 'openai-chat-completions', 'openai-chat-completions'], ['custom', 'anthropic-messages', 'anthropic-messages'],
  ['anthropic', undefined, 'anthropic-messages'],
]
it.each(matrix)('real Pi tool loop + host budgets + HTTP/SSE + ledger: %s / %s', async (preset, override, protocol) => {
  const channel = seed(preset, override)
  const summary = await verifyChannelProtocolRuntime({ home, origin: provider.origin, channelId: channel.id, runId: 'wire' })
  expect(summary.protocol).toBe(protocol); expect(provider.errors).toEqual([])
  expect(provider.requests).toHaveLength(2)
  for (const request of provider.requests) {
    expect(request.path).toBe(protocol === 'anthropic-messages' ? '/prefix/v2/messages?route=fixture' : '/prefix/v1/chat/completions?route=fixture')
    expect(request.body).toMatchObject({ model: 'any-id-27b', max_tokens: 4096 })
    if (protocol === 'openai-chat-completions') {
      expect(request.headers.authorization).toBe('Bearer loopback-only-key')
      expect(request.headers['x-api-key']).toBeUndefined()
      for (const field of ['thinking', 'output_config', 'reasoning_effort', 'system']) expect(request.body).not.toHaveProperty(field)
      expect(request.body.tools[0].function.name).toBe('read_file')
    } else expect(request.headers['x-api-key']).toBe('loopback-only-key')
  }
}, 45000)

async function drain(options: SDKQueryOptions, query: SDKQuery = anthropicMessagesQueryViaProviders) { const out = []; for await (const row of query('probe', options)) out.push(row); return out }
function options(preset: ProviderType = 'qwen', protocol?: ChannelProtocol): SDKQueryOptions {
  return { env: buildSdkEnv('loopback-only-key', provider.origin + '/v1', 'arbitrary-model', preset, undefined, protocol), sessionId: 'guard', maxTokens: 4096, signal: new AbortController().signal,
    accounting: { projectId: 'guard-project', runId: 'guard-run', role: 'orchestrator', scope: 'loop' } }
}
it.each(['anthropic-messages', 'openai-chat-completions'] as const)('host admission rejects %s before any network request', async protocol => {
  const input = options('custom', protocol)
  input.requestGuard = () => { throw Error('HOST_REQUEST_DENIED') }
  await expect(drain(input)).rejects.toThrow('HOST_REQUEST_DENIED')
  expect(provider.requests).toHaveLength(0)
  expect(readProjectUsage('guard-project').physical_requests).toBe(0)
})
it.each(['openai-responses', 'google-generate-content', 'malformed'] as const)('unsupported protocol %s cannot fall through to another adapter', async protocol => {
  const input = options(); input.env.BLOMA_CHANNEL_PROTOCOL = protocol
  await expect(drain(input)).rejects.toThrow('CHANNEL_PROTOCOL_UNSUPPORTED')
  expect(provider.requests).toHaveLength(0)
})
it('uses the actual channel env protocol/provider even if an old caller passes a stale provider override', async () => {
  const input = options(); input.providerType = 'deepseek'
  await drain(input)
  expect(provider.requests[0].path).toBe('/v1/chat/completions')
  expect(provider.requests[0].body).not.toHaveProperty('thinking')
})
it.each(['anthropic-messages', 'openai-chat-completions'] as const)('monetary ceiling still rejects %s before HTTP', async protocol => {
  const input = options('custom', protocol), path = join(home, 'test-money.json')
  writeFileSync(path, JSON.stringify({ version: 1, models: [{ host: new URL(provider.origin).host, model: 'arbitrary-model', cap_rmb: 0.00001, context_tokens: 1048576, input_rmb_per_million: 10, output_rmb_per_million: 10, cache_rmb_per_million: 0.04 }] }))
  input.monetaryPolicyPath = path
  await expect(drain(input)).rejects.toThrow('MONETARY_BUDGET_EXHAUSTED')
  expect(provider.requests).toHaveLength(0)
})
it.each(['anthropic-messages', 'openai-chat-completions'] as const)('cancellation prevents %s from starting a request', async protocol => {
  const input = options('custom', protocol), controller = new AbortController(); controller.abort(); input.signal = controller.signal
  await expect(drain(input)).rejects.toThrow()
  expect(provider.requests).toHaveLength(0)
})
it.each(['anthropic-messages', 'openai-chat-completions'] as const)('runtime fallback switches away from %s to the backup wire protocol', async primaryProtocol => {
  const primary = createChannel({ name: 'failing', provider_type: 'custom', protocol: primaryProtocol, base_url: 'http://127.0.0.1:1/v1', api_key: 'not-real', models: [{ id: 'a', name: 'unreachable', enabled: true }] })
  const backupProtocol = primaryProtocol === 'anthropic-messages' ? 'openai-chat-completions' : 'anthropic-messages'
  const backup = seed('custom', backupProtocol)
  updateCategoryRoutingRoles({ guide: { channel_id: primary.id, fallback_channel_ids: [backup.id] } })
  const route = resolveChannelEnv({ channelId: primary.id, category: 'guide' })
  const input = options(); input.env = route.env!; input.providerType = 'deepseek'
  // Port 1 is rejected locally; no external traffic or sleeping transport retries.
  const out = await drain(input, getSdkQuery())
  expect(out.at(-1)?.stop_reason).toBe('tool_use')
  expect(provider.requests[0].path).toBe(backupProtocol === 'anthropic-messages' ? '/prefix/v2/messages?route=fixture' : '/prefix/v1/chat/completions?route=fixture')
}, 15000)

it('does not retry an identical generic Chat request when the server mentions a vendor thinking parameter', async () => {
  const input = options(); input.env.ANTHROPIC_BASE_URL = provider.origin + '/reject-thinking/v1'
  await expect(drain(input)).rejects.toThrow('400')
  expect(provider.requests).toHaveLength(1)
  expect(provider.requests[0].body).not.toHaveProperty('thinking')
})
it.each(['anthropic-messages', 'openai-chat-completions'] as const)('missing usage on %s remains unknown, not free', async protocol => {
  const input = options('custom', protocol); input.env.ANTHROPIC_BASE_URL += '?omitUsage=1'
  await drain(input)
  expect(readProjectUsage('guard-project')).toMatchObject({ physical_requests: 1, complete: false, missing_usage_queries: 1 })
})

it.each(['anthropic-messages', 'openai-chat-completions'] as const)('blocks redirects on %s rather than forwarding keys or bypassing physical admission', async protocol => {
  const target = await startChannelProtocolServer(), input = options('custom', protocol)
  let admitted = 0
  input.requestGuard = () => { admitted++ }
  input.env.ANTHROPIC_BASE_URL = provider.origin + '/redirect307/v1?to=' + encodeURIComponent(target.origin + '/stolen')
  try {
    await expect(drain(input)).rejects.toThrow('MODEL_REQUEST_REDIRECT_BLOCKED')
    expect(provider.requests).toHaveLength(1); expect(target.requests).toHaveLength(0); expect(admitted).toBe(1)
    expect(readProjectUsage('guard-project').physical_requests).toBe(1)
  } finally { await target.close() }
})
it('does not impose the GLM Flash thinking profile on a standard Chat gateway sharing that model ID', async () => {
  const input = options('custom'); input.env.ANTHROPIC_MODEL = 'glm-5.3-flash'; input.thinkingLevel = 'off'
  await drain(input)
  expect(provider.requests).toHaveLength(1)
  expect(provider.requests[0].body).not.toHaveProperty('thinking')
})
it('connection and directory probes also refuse redirects instead of forwarding saved-key headers', async () => {
  const target = await startChannelProtocolServer()
  const input = { provider_type: 'custom' as const, protocol: 'anthropic-messages' as const, api_key: 'loopback-only-key', base_url: provider.origin + '/redirect307/v1?to=' + encodeURIComponent(target.origin + '/stolen') }
  try {
    expect((await testChannelDirect(input)).ok).toBe(false)
    expect((await fetchModels(input)).success).toBe(false)
    expect(provider.requests).toHaveLength(2); expect(target.requests).toHaveLength(0)
  } finally { await target.close() }
})
