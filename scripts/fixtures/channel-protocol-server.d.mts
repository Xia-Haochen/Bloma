import type { IncomingHttpHeaders } from 'node:http'
export function startChannelProtocolServer(): Promise<{
  origin: string
  requests: Array<{ path?: string; method?: string; headers: IncomingHttpHeaders; body: Record<string, any> }>
  errors: string[]
  close(): Promise<void>
}>
