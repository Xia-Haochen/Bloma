/** All Agent protocols use the SAME host-guarded SSE transport and accounting path. */
import type { ChannelProtocol, ProviderType } from '../../../../shared/types'
import { channelProtocol, channelProtocolUnavailableReason, PROVIDER_PROTOCOL_DEFAULTS, type AgentChannelProtocol } from '../../../../shared/channel-protocol'
import { resolveChatCompletionsUrl, resolveAgentAnthropicUrl, deepseekChatBase } from '../../llm/protocol-url'
import { ANTHROPIC_SSE_ADAPTER, buildAnthropicHeaders } from './anthropic-sse-adapter'
import { OPENAI_LOOP_ADAPTER, openAiLoopBody } from './openai-loop-protocol'
import type { StreamAdapter } from './types'

export { CHANNEL_PROTOCOL_ENV } from '../../../../shared/channel-protocol'
interface Context { provider: ProviderType; baseUrl: string; apiKey: string; vendorThinking: boolean; followsPreset: boolean }
interface AgentProtocolAdapter {
  stream: StreamAdapter
  request(body: Record<string, unknown>, context: Context): { url: string; headers: Record<string, string>; body: string }
}
/** Exhaustiveness enforces that UI execution capability cannot outpace the main adapters. */
const REGISTRY: Record<AgentChannelProtocol, AgentProtocolAdapter> = {
  'anthropic-messages': {
    stream: ANTHROPIC_SSE_ADAPTER,
    request(body, { provider, baseUrl, apiKey, followsPreset }) {
      const preset = PROVIDER_PROTOCOL_DEFAULTS[provider] === 'anthropic-messages' ? provider : 'anthropic-compatible'
      const url = resolveAgentAnthropicUrl(baseUrl, followsPreset ? preset : 'anthropic-compatible')
      return { url, headers: buildAnthropicHeaders(apiKey, preset), body: JSON.stringify(body) }
    },
  },
  'openai-chat-completions': {
    stream: OPENAI_LOOP_ADAPTER,
    request(body, { baseUrl, apiKey, vendorThinking }) {
      return { url: resolveChatCompletionsUrl(baseUrl), headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(openAiLoopBody(body, { vendorThinking })) }
    },
  },
}
export function agentProtocolTransport(input: { provider: ProviderType; protocol?: ChannelProtocol; protocolSource?: string; baseUrl: string; apiKey: string; hasImages: boolean }) {
  const target = { provider_type: input.provider, protocol: input.protocol }
  const reason = channelProtocolUnavailableReason(target)
  if (reason) throw new Error(`CHANNEL_PROTOCOL_UNSUPPORTED: ${reason}`)
  const declared = channelProtocol(target) as AgentChannelProtocol
  // A verified legacy provider quirk, not a second brand allowlist.
  const followsPreset = input.protocol === undefined || input.protocolSource === 'preset'
  const deepseekVision = followsPreset && declared === 'anthropic-messages' && input.provider === 'deepseek' && input.hasImages
  const protocol = deepseekVision ? 'openai-chat-completions' : declared
  const adapter = REGISTRY[protocol]
  const context: Context = { ...input, followsPreset, baseUrl: deepseekVision ? deepseekChatBase(input.baseUrl) : input.baseUrl,
    vendorThinking: input.provider === 'zhipu' || input.provider === 'deepseek' }
  return { protocol, stream: adapter.stream, thinkingControls: protocol === 'anthropic-messages' || context.vendorThinking,
    request: (body: Record<string, unknown>) => adapter.request(body, context) }
}
