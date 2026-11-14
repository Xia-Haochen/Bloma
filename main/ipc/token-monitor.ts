import { session, shell, type BrowserWindow, type IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { getPromaHome } from '../../storage/config-paths'
import { PricingCatalog, officialPricingUrl } from '../../token monitor/pricing'
import { collectUsage } from '../../token monitor/usage'
import { safeInvoke } from './shared'

export function registerTokenMonitorIpc(ipc: IpcMain, window: BrowserWindow): void {
  const home = getPromaHome()
  let catalog: PricingCatalog | undefined
  const prices = () => catalog ??= new PricingCatalog(home, (url, options) =>
    session.fromPartition('token-monitor-pricing').fetch(url, options))
  const access = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('PERMISSION_DENIED: Token 用量仅供 Bloma 主界面访问')
    }
  }
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_READ, event => safeInvoke('token-monitor-read', async () => {
    access(event)
    const data = await collectUsage(home)
    const source = prices()
    source.refreshOnce()
    return { ...data, pricing: source.snapshot() }
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_REFRESH, event => safeInvoke('token-monitor-refresh', () => {
    access(event)
    return prices().refresh()
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_OPEN_SOURCE, (event, provider: unknown) => safeInvoke('token-monitor-source', async () => {
    access(event)
    const url = typeof provider === 'string' && officialPricingUrl(provider)
    if (!url) throw new Error('VALIDATION_ERROR: 未知的价格来源')
    await shell.openExternal(url)
  }))
}
