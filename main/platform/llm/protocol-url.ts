/** Generic OpenAI-compatible endpoints; preserve gateway prefixes and query parameters. */
import type { ProviderType } from '../../../shared/types'
import { normalizeAnthropicBaseUrl, resolveAnthropicMessagesUrl } from '../upstream/providers/url-utils'

function safeUrl(baseUrl: string): URL {
  let url: URL
  try { url = new URL(baseUrl.trim()) } catch { throw new Error('CHANNEL_URL_INVALID: 服务地址须为完整 HTTP(S) URL。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('CHANNEL_URL_INVALID: 服务地址不允许嵌入凭据或使用非 HTTP(S) 协议。')
  return url
}
function endpoint(baseUrl: string, purpose: 'chat/completions' | 'models'): string {
  const url = safeUrl(baseUrl)
  let path = url.pathname.replace(/\/+$/, '')
  if (/\/messages$/.test(path) || /\/responses$/.test(path) && purpose !== 'models') throw new Error('CHANNEL_PROTOCOL_ENDPOINT_MISMATCH: 地址端点与 Chat Completions 协议不符，请填写对应协议的根地址。')
  path = path.replace(/\/(?:chat\/completions|models|responses)$/, '')
  if (!path) path = '/v1'
  url.pathname = `${path}/${purpose}`
  url.hash = ''
  return url.toString()
}
export const resolveChatCompletionsUrl = (base: string): string => endpoint(base, 'chat/completions')
export const resolveChatModelsUrl = (base: string): string => endpoint(base, 'models')

/** Preserve legacy vendor path quirks without concatenating after a query string. */
export function resolveAgentAnthropicUrl(base: string, provider: ProviderType): string {
  const url = safeUrl(base)
  if (/\/(?:chat\/completions|responses)\/?$/.test(url.pathname)) throw new Error('CHANNEL_PROTOCOL_ENDPOINT_MISMATCH: 地址端点与 Anthropic Messages 协议不符。')
  const clean = url.origin + url.pathname.replace(/\/+$/, '')
  const resolved = provider === 'anthropic-compatible' ? `${normalizeAnthropicBaseUrl(clean)}/messages` : resolveAnthropicMessagesUrl(clean, provider)
  url.pathname = new URL(resolved).pathname
  url.hash = ''
  return url.toString()
}
export function resolveAgentAnthropicModelsUrl(base: string, provider: ProviderType): string {
  const url = new URL(resolveAgentAnthropicUrl(base, provider))
  url.pathname = url.pathname.replace(/\/messages$/, '/models')
  return url.toString()
}
export function deepseekChatBase(base: string): string {
  const url = safeUrl(base)
  url.pathname = url.pathname.replace(/\/anthropic(?:\/v1)?(?:\/messages)?\/?$/, '') || '/'
  return url.toString()
}
