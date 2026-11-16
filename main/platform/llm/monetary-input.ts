interface InputRoute {
  host: string
  model: string
  context_tokens: number
}

const REQUEST_FIELDS = new Set(['model', 'messages', 'max_tokens', 'stream', 'system', 'tools', 'temperature',
  'thinking', 'output_config', 'reasoning_effort', 'stream_options', 'top_p', 'stop', 'tool_choice'])
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function supportsTextEnvelope(rate: InputRoute): boolean {
  return rate.host === 'api.deepseek.com' && rate.model === 'deepseek-flash'
}

function textContent(content: unknown): boolean {
  if (typeof content === 'string' || content === null) return true
  return Array.isArray(content) && content.every(block => {
    if (!object(block)) return false
    if (block.type === 'tool_result') return textContent(block.content)
    return block.type === 'text' || block.type === 'thinking' || block.type === 'tool_use'
  })
}

/**
 * Use the UTF-8 byte count of the whole wire body, including tool schemas
 * and history, with an additional allowance for server prompt framing.
 * The provider does not expose its exact rendered Anthropic prompt. For other
 * routes, attachments, or unfamiliar request shapes keep the context reserve.
 */
export function monetaryInputEnvelope(url: URL, body: string, rate: InputRoute): number {
  const full = rate.context_tokens
  if (!supportsTextEnvelope(rate) || url.protocol !== 'https:') return full
  const anthropic = url.pathname === '/anthropic/v1/messages'
  if (!anthropic && !['/chat/completions', '/v1/chat/completions'].includes(url.pathname)) return full
  const request: unknown = JSON.parse(body)
  if (!object(request) || Object.keys(request).some(key => !REQUEST_FIELDS.has(key)) || !Array.isArray(request.messages)
    || (request.system !== undefined && !textContent(request.system))
    || !request.messages.every(message => object(message) && textContent(message.content))) return full
  const tools = request.tools ?? []
  if (!Array.isArray(tools) || !tools.every(tool => object(tool)
    && (anthropic ? typeof tool.name === 'string' && tool.type === undefined && object(tool.input_schema)
      : tool.type === 'function' && object(tool.function)))) return full
  const frameCount = request.messages.length + tools.length
    + request.messages.reduce((sum: number, message) => sum + (Array.isArray(message.content) ? message.content.length : 0)
      + (Array.isArray(message.tool_calls) ? message.tool_calls.length : 0), 0)
  return Math.min(full, Buffer.byteLength(body, 'utf8') + 8192 + 128 * frameCount)
}
