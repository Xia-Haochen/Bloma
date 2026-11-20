import { describe, expect, it } from 'vitest'
import { channelProtocol, channelProtocolUnavailableReason, isAgentChannel, PROVIDER_PROTOCOL_DEFAULTS } from '../../shared/channel-protocol'
import { isAgentProtocolProvider, PROVIDER_LABELS, type ProviderType } from '../../shared/types'
import { resolveChatCompletionsUrl, resolveChatModelsUrl } from '../../main/platform/llm/protocol-url'

describe('channel protocols, independent of brand/model ID', () => {
  it('has an explicit default for every preset, without using preset names as the execution allowlist', () => {
    expect(Object.keys(PROVIDER_PROTOCOL_DEFAULTS).sort()).toEqual(Object.keys(PROVIDER_LABELS).sort())
    for (const provider of ['qwen', 'openai', 'custom', 'doubao', 'opencode-go-openai', 'zhipu'] as const) {
      expect(channelProtocol({ provider_type: provider })).toBe('openai-chat-completions')
      expect(isAgentProtocolProvider(provider)).toBe(true)
    }
    expect(isAgentChannel({ provider_type: 'a-new-brand' as ProviderType, protocol: 'openai-chat-completions' })).toBe(true)
  })
  it('uses the explicit wire protocol, including custom Anthropic and non-default presets', () => {
    expect(channelProtocol({ provider_type: 'custom', protocol: 'anthropic-messages' })).toBe('anthropic-messages')
    expect(isAgentChannel({ provider_type: 'google', protocol: 'openai-chat-completions' })).toBe(true)
    expect(isAgentChannel({ provider_type: 'anthropic', protocol: 'google-generate-content' })).toBe(false)
  })
  it('explains unimplemented protocols and never falls back to another protocol on malformed input', () => {
    expect(channelProtocolUnavailableReason({ provider_type: 'google' })).toContain('Gemini')
    expect(channelProtocolUnavailableReason({ provider_type: 'openai-responses' })).toContain('Responses')
    expect(() => channelProtocol({ provider_type: 'custom', protocol: 'surprise' as never })).toThrow('CHANNEL_PROTOCOL_INVALID')
    expect(isAgentChannel({ provider_type: 'custom', protocol: 'surprise' as never })).toBe(false)
  })
})

describe('protocol endpoints preserve gateway prefixes and URL components', () => {
  it.each([
    ['https://gateway.example', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/models'],
    ['https://gateway.example/compatible-mode/v1/', 'https://gateway.example/compatible-mode/v1/chat/completions', 'https://gateway.example/compatible-mode/v1/models'],
    ['https://gateway.example/api/paas/v4', 'https://gateway.example/api/paas/v4/chat/completions', 'https://gateway.example/api/paas/v4/models'],
    ['https://gateway.example/v1/chat/completions?route=a', 'https://gateway.example/v1/chat/completions?route=a', 'https://gateway.example/v1/models?route=a'],
  ])('%s', (base, chat, models) => { expect(resolveChatCompletionsUrl(base)).toBe(chat); expect(resolveChatModelsUrl(base)).toBe(models) })
  it('rejects embedded credentials and conflicting endpoints rather than sending secrets to a guessed protocol', () => {
    expect(() => resolveChatCompletionsUrl('https://user:pass@gateway.example/v1')).toThrow('CHANNEL_URL_INVALID')
    expect(() => resolveChatCompletionsUrl('https://gateway.example/v1/messages')).toThrow('CHANNEL_PROTOCOL_ENDPOINT_MISMATCH')
  })
})

it('does not leak prior Anthropic reasoning blocks into generic Chat history', async () => {
  const { openAiLoopBody } = await import('../../main/platform/upstream/providers/openai-loop-protocol')
  const body = openAiLoopBody({ model: 'any-model', messages: [
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'public result' }] },
  ], thinking: { type: 'disabled' }, output_config: { effort: 'high' } }, { vendorThinking: false })
  expect(body.messages).toEqual([{ role: 'assistant', content: 'public result' }])
  for (const field of ['thinking', 'output_config', 'reasoning_effort']) expect(body).not.toHaveProperty(field)
})

it('explicit Anthropic overrides cannot be silently switched to DeepSeek Chat for images', async () => {
  const { agentProtocolTransport } = await import('../../main/platform/upstream/providers/agent-protocol-registry')
  const input = { provider: 'deepseek' as const, protocol: 'anthropic-messages' as const, baseUrl: 'https://gateway.example/prefix/anthropic/v1/messages?route=private', apiKey: 'fake', hasImages: true }
  const explicit = agentProtocolTransport(input)
  expect(explicit.protocol).toBe('anthropic-messages')
  expect(explicit.request({ messages: [] }).url).toBe(input.baseUrl)
  const legacy = agentProtocolTransport({ ...input, protocolSource: 'preset' })
  expect(legacy.protocol).toBe('openai-chat-completions')
  expect(legacy.request({ model: 'any-model', messages: [] }).url).toBe('https://gateway.example/prefix/chat/completions?route=private')
})
it('explicit Xiaomi Anthropic gateways preserve their prefix instead of rewriting to the branded path', async () => {
  const { agentProtocolTransport } = await import('../../main/platform/upstream/providers/agent-protocol-registry')
  const input = { provider: 'xiaomi' as const, protocol: 'anthropic-messages' as const, baseUrl: 'https://gateway.example/team/prefix/v1/messages?route=x', apiKey: 'fake', hasImages: false }
  expect(agentProtocolTransport(input).request({ messages: [] }).url).toBe(input.baseUrl)
})
