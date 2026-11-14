import type { MonitorPrices, UsageSnapshot } from '../../shared/token-monitor'

export function mountTokenMonitor(root: ShadowRoot | HTMLElement, transport: {
  read(): Promise<UsageSnapshot>
  refreshPrices(): Promise<MonitorPrices>
  openSource(provider: string, url?: string): unknown
}): () => void
