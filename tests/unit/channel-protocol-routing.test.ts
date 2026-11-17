import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChannel, getChannelByIdRaw, getFirstEnabledChannel, updateChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { resolveChannelEnv } from '../../main/platform/llm/runtime-fallback'
import { resetCategoryRoutingForTests, updateCategoryRoutingRoles, resolveRoutedChannelId } from '../../main/platform/llm/category-routing'
import { resolveDelegationChannelOverride } from '../../main/agent/delegation/delegation-channel'
import { resolveIndependentRoute } from '../../main/software/independent-design'
import { getBlomaChannelsPath } from '../../storage/config-paths'
import type { ChannelProtocol, ProviderType } from '../../shared/types'

let home: string, previous: string | undefined
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-channel-protocol-')); process.env.PROMA_HOME = home
  resetCategoryRoutingForTests()
  setSafeStorageAdapter({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`enc:${value}`), decryptString: value => value.toString().replace(/^enc:/, '') })
})
afterEach(() => { resetCategoryRoutingForTests(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
function seed(provider: ProviderType, protocol?: ChannelProtocol) {
  return createChannel({ name: '27B', provider_type: provider, protocol, base_url: 'https://gateway.example/prefix/v2', api_key: 'offline-only',
    models: [{ id: 'local-id', name: 'arbitrary-model-27b', enabled: true, context_window: 262144, max_output_tokens: 4096 }] })
}

describe('full-channel protocol routing and legacy compatibility', () => {
  it.each(['qwen', 'openai', 'custom', 'doubao'] as const)('%s legacy channels are selectable without rewriting their file', provider => {
    const channel = seed(provider), before = readFileSync(getBlomaChannelsPath(), 'utf8')
    expect(getFirstEnabledChannel()?.id).toBe(channel.id)
    const resolved = resolveChannelEnv({ channelId: channel.id, category: 'guide' })
    expect(resolved.env).toMatchObject({ ANTHROPIC_BASE_URL: channel.base_url, ANTHROPIC_MODEL: 'arbitrary-model-27b', BLOMA_CHANNEL_PROTOCOL: 'openai-chat-completions' })
    expect(readFileSync(getBlomaChannelsPath(), 'utf8')).toBe(before)
    updateCategoryRoutingRoles({ guide: { channel_id: channel.id }, programming: { channel_id: channel.id } })
    for (const category of ['guide', 'sketch', 'mvp'] as const) expect(resolveRoutedChannelId(category)).toBe(channel.id)
  })
  it('persists an override, preserves it through unrelated edits and distinguishes clearing it', () => {
    const channel = seed('custom', 'anthropic-messages')
    updateChannel(channel.id, { name: 'renamed' })
    expect(getChannelByIdRaw(channel.id)?.protocol).toBe('anthropic-messages')
    expect(resolveChannelEnv({ channelId: channel.id, category: 'guide' }).env?.BLOMA_CHANNEL_PROTOCOL).toBe('anthropic-messages')
    updateChannel(channel.id, { protocol: null })
    expect(getChannelByIdRaw(channel.id)?.protocol).toBeUndefined()
    expect(resolveChannelEnv({ channelId: channel.id, category: 'guide' }).env?.BLOMA_CHANNEL_PROTOCOL).toBe('openai-chat-completions')
  })
  it('rejects invalid overrides atomically and blocks unsupported protocols independently of provider branding', () => {
    const channel = seed('anthropic', 'google-generate-content'), before = readFileSync(getBlomaChannelsPath(), 'utf8')
    expect(() => updateCategoryRoutingRoles({ guide: { channel_id: channel.id } })).toThrow('Gemini')
    expect(resolveChannelEnv({ channelId: channel.id, category: 'guide' }).unusableReason).toBe('unsupported_protocol')
    expect(() => updateChannel(channel.id, { protocol: 'invalid' as never })).toThrow('CHANNEL_PROTOCOL_INVALID')
    expect(readFileSync(getBlomaChannelsPath(), 'utf8')).toBe(before)
    expect(() => seed('qwen', 'invalid' as never)).toThrow('CHANNEL_PROTOCOL_INVALID')
    expect(readFileSync(getBlomaChannelsPath(), 'utf8')).toBe(before)
  })
  it('carries the protocol through explicit delegation and pinned independent-design routes, without fallback metadata', () => {
    const channel = seed('google', 'openai-chat-completions')
    const child = resolveDelegationChannelOverride({ channelId: channel.id })!
    const independent = resolveIndependentRoute({ channel_id: channel.id, model: 'arbitrary-model-27b' } as never)
    for (const env of [child.env, independent.env]) {
      expect(env.BLOMA_CHANNEL_PROTOCOL).toBe('openai-chat-completions')
      expect(env.ANTHROPIC_BASE_URL).toBe(channel.base_url)
      expect(Object.keys(env).some(key => key.includes('FALLBACK'))).toBe(false)
    }
    updateChannel(channel.id, { protocol: 'openai-responses' })
    expect(() => resolveDelegationChannelOverride({ channelId: channel.id })).toThrow('Responses')
    expect(() => resolveIndependentRoute({ channel_id: channel.id, model: 'arbitrary-model-27b' } as never)).toThrow('INDEPENDENT_CAPABILITY_MISSING')
  })
  it('picks a compatible cross-protocol backup while skipping an unimplemented override', () => {
    const unsupported = seed('anthropic', 'openai-responses'), backup = seed('qwen')
    const resolved = resolveChannelEnv({ channelId: unsupported.id, category: 'mvp' })
    expect(resolved.channel?.id).toBe(backup.id)
    expect(resolved.env?.BLOMA_CHANNEL_PROTOCOL).toBe('openai-chat-completions')
  })
})
