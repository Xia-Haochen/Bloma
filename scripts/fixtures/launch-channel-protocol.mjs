/** Isolated Electron ESM launcher: no production IPC modifications or test backdoors. */
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// Do not top-level-await whenReady: Electron must finish loading the entry first.
import(pathToFileURL(process.env.CHANNEL_PROTOCOL_FIXTURE_MODULE).href).then(async module => {
  await app.whenReady()
  const input = JSON.parse(process.env.CHANNEL_PROTOCOL_FIXTURE_INPUT)
  const summary = await module.verifyChannelProtocolRuntime(input)
  writeFileSync(join(input.home, input.runId + '-runtime.json'), JSON.stringify(summary))
}).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
