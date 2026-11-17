/** Wire-protocol contract. Provider names are presets, never runtime permissions. */
import type { ChannelProtocol, ProviderType } from './types'

export const CHANNEL_PROTOCOL_ENV = 'BLOMA_CHANNEL_PROTOCOL'
export const CHANNEL_PROTOCOL_SOURCE_ENV = 'BLOMA_CHANNEL_PROTOCOL_SOURCE'
export const AGENT_CHANNEL_PROTOCOLS = ['anthropic-messages', 'openai-chat-completions'] as const
export type AgentChannelProtocol = typeof AGENT_CHANNEL_PROTOCOLS[number]
export const CHANNEL_PROTOCOL_LABELS: Record<ChannelProtocol, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-chat-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'google-generate-content': 'Google Gemini GenerateContent',
}
/** Defaults are compatibility metadata only; an explicit channel protocol wins. */
export const PROVIDER_PROTOCOL_DEFAULTS: Record<ProviderType, ChannelProtocol> = {
  anthropic: 'anthropic-messages', 'anthropic-compatible': 'anthropic-messages',
  deepseek: 'anthropic-messages', 'kimi-api': 'anthropic-messages', 'kimi-coding': 'anthropic-messages',
  minimax: 'anthropic-messages', xiaomi: 'anthropic-messages', 'xiaomi-token-plan': 'anthropic-messages',
  'qwen-anthropic': 'anthropic-messages', 'qwen-token-plan': 'anthropic-messages',
  'zhipu-coding': 'anthropic-messages', 'zhipu-coding-team': 'anthropic-messages', 'ark-coding-plan': 'anthropic-messages',
  openai: 'openai-chat-completions', custom: 'openai-chat-completions', qwen: 'openai-chat-completions',
  zhipu: 'openai-chat-completions', doubao: 'openai-chat-completions', 'opencode-go-openai': 'openai-chat-completions',
  'openai-responses': 'openai-responses', google: 'google-generate-content',
}
export interface ChannelProtocolTarget { provider_type: ProviderType; protocol?: ChannelProtocol }
export function isChannelProtocol(value: unknown): value is ChannelProtocol {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CHANNEL_PROTOCOL_LABELS, value)
}
export function channelProtocol(channel: ChannelProtocolTarget): ChannelProtocol {
  const protocol = channel.protocol === undefined ? PROVIDER_PROTOCOL_DEFAULTS[channel.provider_type] : channel.protocol
  if (!isChannelProtocol(protocol)) throw new Error('CHANNEL_PROTOCOL_INVALID: 请求协议无效，请编辑渠道重新选择。')
  return protocol
}
export function isAgentChannelProtocol(protocol: ChannelProtocol): protocol is AgentChannelProtocol {
  return (AGENT_CHANNEL_PROTOCOLS as readonly string[]).includes(protocol)
}
export function channelProtocolUnavailableReason(channel: ChannelProtocolTarget): string | undefined {
  try {
    const protocol = channelProtocol(channel)
    if (!isAgentChannelProtocol(protocol)) return `${CHANNEL_PROTOCOL_LABELS[protocol]} 尚未实现 Agent 执行适配器；可保留配置或选择服务实际支持的协议。`
  } catch { return '请求协议无效，请编辑渠道重新选择。' }
}
export function isAgentChannel(channel: ChannelProtocolTarget): boolean {
  return channelProtocolUnavailableReason(channel) === undefined
}
