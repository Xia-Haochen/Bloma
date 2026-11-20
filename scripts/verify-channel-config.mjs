/** Offline channel configuration: production Electron/preload/IPC, fake loopback provider. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'

const root = resolve('.')
const home = mkdtempSync(join(tmpdir(), 'bloma-channel-electron-'))
const artifacts = join(root, 'run-artifacts', 'channel-config-20261117')
mkdirSync(artifacts, { recursive: true })
const requests = []
const server = createServer((req, res) => {
  requests.push({ path: req.url, method: req.method, key: req.headers['x-api-key'] ?? req.headers.authorization })
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ id: 'offline-model', display_name: '离线验证模型' }] }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, PROMA_HOME: home }
for (const key of Object.keys(env)) if (key.startsWith('BLOMA_')) delete env[key]
delete env.ELECTRON_RUN_AS_NODE
delete env.VITE_DEV_SERVER_URL
const report = { checks: [], errors: [], providerRequests: [], nativeCua: 'not covered; Playwright Electron integration only' }
let app
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [`--user-data-dir=${join(home, 'profile')}`, '.'], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  await page.getByRole('button', { name: '添加第一个渠道', exact: true }).click()
  let form = page.locator('form')
  await form.getByLabel('模型提供商', { exact: true }).selectOption('anthropic')
  await form.getByPlaceholder('例如：我的 DeepSeek').fill('离线验证渠道')
  await form.getByPlaceholder(/留空使用/).fill(origin)
  await form.getByPlaceholder('sk-…').fill('offline-secret-not-real')
  await form.getByRole('button', { name: '拉取模型', exact: true }).click()
  await form.getByText('离线验证模型', { exact: true }).waitFor()
  await form.getByLabel('offline-model 上下文窗口', { exact: true }).fill('1048576')
  await form.getByLabel('offline-model 最大输出', { exact: true }).fill('4096')
  await form.getByRole('button', { name: '保存渠道', exact: true }).click()
  await page.getByTitle('编辑渠道', { exact: true }).waitFor()
  let saved = JSON.parse(readFileSync(join(home, 'bloma-channels.json'), 'utf8')).channels[0]
  assert.equal(saved.models[0].name, 'offline-model')
  assert.equal(saved.models[0].display_name, '离线验证模型')
  assert.equal(saved.models[0].context_window, 1048576)
  assert.equal(saved.models[0].max_output_tokens, 4096)
  assert.ok(!JSON.stringify(saved).includes('offline-secret-not-real'))
  report.checks.push('real form -> preload -> IPC -> encrypted storage retains request ID, label and both limits')

  for (const label of ['需求沟通 渠道', '界面与制作 渠道']) {
    await page.getByLabel(label, { exact: true }).selectOption(saved.id)
  }
  await page.locator('[data-ai-id="role-routing-save"]').click()
  await page.getByText(/流程默认值已保存/).waitFor()
  const routing = JSON.parse(readFileSync(join(home, 'category-routing.json'), 'utf8')).routing
  for (const category of ['guide', 'sketch', 'mvp']) assert.equal(routing[category].channel_id, saved.id)
  const invalidRole = await page.evaluate(() => window.electronAPI.channels.categoryRoutingRoleUpdate({
    request_id: crypto.randomUUID(), routing: { guide: { channel_id: 'non-existent' } },
  }))
  assert.equal(invalidRole.ok, false)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'category-routing.json'), 'utf8')).routing, routing)
  report.checks.push('role form persists guide/sketch/mvp through real IPC; invalid selection fails atomically')
  await page.evaluate(async (channelId) => {
    const api = window.electronAPI.channels
    const backup = await api.create({ request_id: crypto.randomUUID(), name: '离线备用', provider_type: 'anthropic', base_url: 'http://127.0.0.1:1', api_key: 'offline-backup-not-real', models: [{ id: 'backup', name: 'backup', enabled: true }] })
    if (!backup.ok) throw new Error('offline backup creation failed')
    const result = await api.categoryRoutingRoleUpdate({ request_id: crypto.randomUUID(), routing: { guide: { channel_id: channelId, fallback_channel_ids: [backup.data.id] } } })
    if (!result.ok) throw new Error('offline backup routing failed')
    await api.delete({ request_id: crypto.randomUUID(), channel_id: backup.data.id })
  }, saved.id)
  await page.reload()
  await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  await page.getByLabel('需求沟通 渠道', { exact: true }).selectOption('')
  await page.locator('[data-ai-id="role-routing-save"]').click()
  await page.getByText(/所选备用渠道.*不存在/).waitFor()
  const guideRow = page.locator('[data-ai-id="role-routing-row-guide"]')
  await guideRow.getByRole('button', { name: /备用顺序/ }).click()
  await guideRow.getByRole('button', { name: /需求沟通 移除不可用备用/ }).click()
  await page.getByLabel('需求沟通 渠道', { exact: true }).selectOption(saved.id)
  await page.locator('[data-ai-id="role-routing-save"]').click()
  await page.getByText(/流程默认值已保存/).waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'category-routing.json'), 'utf8')).routing, routing)
  report.checks.push('deleted backup remains visible/removable; per-role repair preserves other role configuration')

  await page.getByTitle('编辑渠道', { exact: true }).click()
  form = page.locator('form')
  assert.equal(await form.locator('input[type=password]').inputValue(), '')
  await form.getByRole('button', { name: '测试连接', exact: true }).click()
  await form.getByText('连接成功', { exact: true }).waitFor()
  assert.equal(requests.length, 2)
  assert.ok(requests.every(req => req.key === 'offline-secret-not-real'))
  report.checks.push('edit uses saved key only inside main for same-origin test; no plaintext returned')

  await form.getByPlaceholder(/留空使用/).fill('https://other.invalid')
  assert.equal(await form.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true)
  assert.equal(await form.getByRole('button', { name: '保存修改', exact: true }).isDisabled(), true)
  await form.getByText(/重新填写 API Key/).waitFor()
  const bypass = await page.evaluate(async () => {
    const listed = await window.electronAPI.channels.list({ request_id: crypto.randomUUID() })
    return window.electronAPI.channels.testDirect({ request_id: crypto.randomUUID(), input: { channel_id: listed.data[0].id, provider_type: 'anthropic', base_url: 'https://other.invalid', api_key: '' } })
  })
  assert.equal(bypass.ok, true)
  assert.equal(bypass.data.ok, false)
  assert.ok(bypass.data.message.includes('重新填写 API Key'))
  assert.equal(requests.length, 2)
  report.checks.push('form blocks changed-target reuse; direct production IPC independently rejects it without HTTP')
  await form.getByPlaceholder(/留空使用/).fill(origin)
  await form.getByLabel('offline-model 最大输出', { exact: true }).fill('2048')
  await form.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.getByTitle('编辑渠道', { exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  for (const label of ['需求沟通 渠道', '界面与制作 渠道']) {
    assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), saved.id)
  }
  report.checks.push('role selections survive a real renderer reload')
  await page.getByTitle('编辑渠道', { exact: true }).click()
  form = page.locator('form')
  assert.equal(await form.getByLabel('offline-model 最大输出', { exact: true }).inputValue(), '2048')
  assert.equal(await form.getByLabel('offline-model 上下文窗口', { exact: true }).inputValue(), '1048576')
  report.checks.push('production reload retains separate limits after real update')
  await form.getByLabel('offline-model 最大输出', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifacts, 'channel-editor.png'), fullPage: true, animations: 'disabled' })
  await form.getByLabel('模型提供商', { exact: true }).selectOption('openai')
  assert.equal(await form.locator('input[type=password]').inputValue(), '')
  assert.equal(await form.getByPlaceholder(/留空使用/).inputValue(), 'https://api.openai.com/v1')
  assert.equal(await form.locator('[data-ai-id="channel-model-list"]').count(), 0)
  report.checks.push('provider change resets credentials, URL, model list and probe status')
  const disabledRole = await page.evaluate(async (channelId) => {
    await window.electronAPI.channels.update({ request_id: crypto.randomUUID(), channel_id: channelId, input: { enabled: false } })
    return window.electronAPI.channels.categoryRoutingRoleUpdate({ request_id: crypto.randomUUID(), routing: { guide: { channel_id: channelId } } })
  }, saved.id)
  assert.equal(disabledRole.ok, false)
  await page.reload()
  await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  await page.locator('[data-ai-id="role-routing-dangling-guide"]').waitFor()
  assert.equal(await page.getByLabel('需求沟通 渠道', { exact: true }).inputValue(), saved.id)
  assert.equal(await page.getByLabel('需求沟通 渠道', { exact: true }).locator(`option[value="${saved.id}"]`).isDisabled(), true)
  await page.screenshot({ path: join(artifacts, 'role-routing-unavailable.png'), fullPage: true, animations: 'disabled' })
  report.checks.push('disabled role target is rejected by IPC and shown explicitly instead of fake auto success')
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : String(error))
  throw error
} finally {
  report.providerRequests = requests.map(({ path, method }) => ({ path, method }))
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await app.close().catch(() => {})
  }
  await new Promise(resolve => server.close(resolve))
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  // A unique temp home owned exclusively by this test; never touches ~/.proma.
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
console.log(JSON.stringify(report, null, 2))
