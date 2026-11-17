import { mkdtempSync, writeFileSync } from 'node:fs'
import { getBlomaChannelsPath } from '../../storage/config-paths'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createChannel, fetchModels, getChannelByIdRaw, testChannelDirect, updateChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { buildAnthropicHeaders } from '../../main/platform/upstream/providers/anthropic-sse-adapter'
import { restorePromaHome } from '../support/proma-home-guard'

let originalHome: string | undefined
beforeEach(() => {
  originalHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-channel-align-'))
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`enc:${text}`),
    decryptString: data => data.toString().replace(/^enc:/, ''),
  })
})
afterEach(() => { restorePromaHome(originalHome); vi.unstubAllGlobals() })

function savedChannel() {
  return createChannel({ name: 'original', provider_type: 'anthropic', base_url: 'https://original.example/v1', api_key: 'saved-secret' })
}

describe('saved credential target binding', () => {
  it.each([
    { base_url: 'https://other.example/v1', provider_type: 'anthropic' as const },
    { base_url: 'http://original.example/v1', provider_type: 'anthropic' as const },
    { base_url: 'https://original.example/v1', provider_type: 'openai' as const },
    { base_url: 'https://user:pass@original.example/v1', provider_type: 'anthropic' as const },
  ])('does not send saved secrets to changed targets: %o', async target => {
    const channel = savedChannel()
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    const input = { ...target, api_key: '', channel_id: channel.id }
    const tested = await testChannelDirect(input)
    const fetched = await fetchModels(input)
    expect(tested.ok).toBe(false)
    expect(fetched.success).toBe(false)
    expect(tested.message).toContain('重新填写 API Key')
    expect(fetched.message).toContain('重新填写 API Key')
    expect(network).not.toHaveBeenCalled()
    expect(() => updateChannel(channel.id, target)).toThrow(/重新填写 API Key/)
    expect(getChannelByIdRaw(channel.id)?.base_url).toBe('https://original.example/v1')
  })

  it('allows same-origin endpoint edits without returning the saved secret', async () => {
    const channel = savedChannel()
    const network = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', network)
    const result = await testChannelDirect({ provider_type: 'anthropic', base_url: 'https://ORIGINAL.example:443/v1/messages', api_key: '', channel_id: channel.id })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('saved-secret')
    expect(network).toHaveBeenCalledOnce()
    expect(updateChannel(channel.id, { base_url: 'https://original.example/another-path' })?.api_key).toBe('***')
  })

  it('allows explicitly supplied replacement credentials on a new target', async () => {
    const channel = savedChannel()
    const network = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', network)
    expect((await testChannelDirect({ provider_type: 'openai', base_url: 'https://other.example', api_key: 'replacement', channel_id: channel.id })).ok).toBe(true)
    expect(JSON.stringify(network.mock.calls)).not.toContain('saved-secret')
    expect(updateChannel(channel.id, { provider_type: 'openai', base_url: 'https://other.example', api_key: 'replacement' })?.provider_type).toBe('openai')
  })
})

describe('model directory identity and metadata', () => {
  it('repairs old fetched Google labels but never changes manual request names', () => {
    const channel = createChannel({ name: 'Google', provider_type: 'google', base_url: 'https://google.example', api_key: 'fake' })
    const raw = getChannelByIdRaw(channel.id)!
    writeFileSync(getBlomaChannelsPath(), JSON.stringify({ version: 1, channels: [{ ...raw, models: [
      { id: 'gemini-example', name: 'Friendly Label', source: 'fetched', enabled: false },
      { id: 'local-id', name: 'manual-request-id', source: 'manual', enabled: true },
    ] }] }))
    expect(getChannelByIdRaw(channel.id)?.models).toEqual([
      { id: 'gemini-example', name: 'gemini-example', display_name: 'Friendly Label', source: 'fetched', enabled: false },
      { id: 'local-id', name: 'manual-request-id', source: 'manual', enabled: true },
    ])
  })

  it('keeps Google request ID distinct from display label and retains limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'models/gemini-example', displayName: 'Gemini Friendly Label', inputTokenLimit: 1048576, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] }] }))))
    const result = await fetchModels({ provider_type: 'google', base_url: 'https://google.example', api_key: 'fake' })
    expect(result.models[0]).toMatchObject({ id: 'gemini-example', name: 'gemini-example', display_name: 'Gemini Friendly Label', context_window: 1048576, max_output_tokens: 8192 })
  })

  it('keeps Anthropic request ID and display label distinct', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'claude-example', display_name: 'Claude Friendly Label' }] }))))
    const result = await fetchModels({ provider_type: 'anthropic', base_url: 'https://anthropic.example', api_key: 'fake' })
    expect(result.models[0]).toMatchObject({ name: 'claude-example', display_name: 'Claude Friendly Label' })
  })
})

describe('coding plan authentication uses the runtime headers', () => {
  it.each(['kimi-coding', 'zhipu-coding', 'zhipu-coding-team'] as const)('%s uses User-Agent for tests and directory requests', async provider_type => {
    const network = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', network)
    const input = { provider_type, base_url: 'https://coding.example', api_key: 'plain-token' }
    await testChannelDirect(input)
    await fetchModels(input)
    expect(network).toHaveBeenCalledTimes(2)
    for (const call of network.mock.calls as unknown as Array<[string, RequestInit]>) {
      const headers = call[1].headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer plain-token')
      expect(headers['User-Agent']).toBeTruthy()
    }
  })

  it.each(['plain-token', '{"apiKey":"plain-token","organization":"org"}', 'API-TOKEN=plain-token;project=project'])('extracts actual team token for runtime and tests: %s', async secret => {
    expect(buildAnthropicHeaders(secret, 'zhipu-coding-team').Authorization).toBe('Bearer plain-token')
    const network = vi.fn(async () => new Response('{"error":{"message":"invalid token"}}', { status: 401 }))
    vi.stubGlobal('fetch', network)
    const result = await testChannelDirect({ provider_type: 'zhipu-coding-team', base_url: 'https://coding.example', api_key: secret })
    expect(network).toHaveBeenCalledOnce()
    expect(result.ok).toBe(false)
    expect(result.errorType).toBe('auth')
    const call = network.mock.calls[0] as unknown as [string, RequestInit]
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer plain-token')
  })
})

describe('protocol-consistent directory and connection probes', () => {
  it.each([
    ['anthropic', 'openai-chat-completions', '/proxy/v2/models'],
    ['deepseek', 'openai-chat-completions', '/proxy/v2/models'],
    ['custom', 'anthropic-messages', '/proxy/v2/models'],
    ['google', 'anthropic-messages', '/proxy/v2/models'],
  ] as const)('honors %s -> %s instead of its branded preset', async (provider_type, protocol, path) => {
    const network = vi.fn(async () => new Response('{"data":[{"id":"any-id"}]}', { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', network)
    const input = { provider_type, protocol, base_url: 'https://gateway.example/proxy/v2?tenant=fixture', api_key: 'not-real' }
    expect((await testChannelDirect(input)).ok).toBe(true)
    expect((await fetchModels(input)).models[0]?.name).toBe('any-id')
    for (const [url, request] of network.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe('https://gateway.example' + path + '?tenant=fixture')
      expect(request.method).toBe('GET')
      if (protocol === 'openai-chat-completions') expect((request.headers as Record<string, string>).Authorization).toBe('Bearer not-real')
    }
  })
})
