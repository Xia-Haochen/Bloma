/** Offline production UI/preload/IPC + real Electron-main Pi/HTTP harness. Never uses the user's home. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { _electron } from 'playwright'
import { startChannelProtocolServer } from './fixtures/channel-protocol-server.mjs'

const root = resolve('.'), home = mkdtempSync(join(tmpdir(), 'bloma-protocol-electron-'))
const artifacts = join(root, 'run-artifacts', 'channel-protocol-20261117')
const compiled = join(root, 'run-artifacts', 'compiled-fixtures', `channel-protocol-${Date.now()}.mjs`)
mkdirSync(artifacts, { recursive: true }); mkdirSync(resolve(compiled, '..'), { recursive: true })
const service = await startChannelProtocolServer()
const env = { ...process.env, PROMA_HOME: home }
for (const key of Object.keys(env)) if (key.startsWith('BLOMA_')) delete env[key]
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
const report = { checks: [], runtime: [], requests: [], errors: [], boundary: 'Production renderer/preload/IPC; same-source bundled runtime harness in separate isolated Electron main. Not native Cua or real-provider acceptance.' }
let app
function savedChannels() { return JSON.parse(readFileSync(join(home, 'bloma-channels.json'), 'utf8')).channels }
try {
  await build({ entryPoints: [resolve('scripts/fixtures/verify-channel-protocol-runtime.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [`--user-data-dir=${join(home, 'profile')}`, '.'], cwd: root, env, timeout: 30000 })
  let page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message))
  await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  await page.getByRole('button', { name: '添加第一个渠道', exact: true }).click()
  let form = page.locator('form')
  await form.getByLabel('模型提供商', { exact: true }).selectOption('qwen')
  await form.getByPlaceholder('例如：我的 DeepSeek').fill('27B')
  await form.getByLabel('服务地址', { exact: true }).fill(service.origin + '/compatible-mode/v1')
  await form.getByPlaceholder('sk-…').fill('offline-secret-qwen-not-real')
  assert.equal(await form.getByLabel('请求协议', { exact: true }).inputValue(), '')
  await form.getByRole('button', { name: '拉取模型', exact: true }).click()
  await form.locator('[data-ai-id="channel-model-row-qwen3.8-27b"]').waitFor()
  await form.getByLabel('qwen3.8-27b 最大输出', { exact: true }).fill('4096')
  await form.getByRole('button', { name: '保存渠道', exact: true }).click()
  await page.getByTitle('编辑渠道', { exact: true }).waitFor()
  const qwen = savedChannels()[0]
  assert.equal(qwen.provider_type, 'qwen'); assert.equal(qwen.protocol, undefined)
  assert.equal(qwen.models[0].name, 'qwen3.8-27b')
  assert.ok(!JSON.stringify(savedChannels()).includes('offline-secret-qwen-not-real'))
  for (const label of ['需求沟通 渠道', '界面与制作 渠道']) {
    const select = page.getByLabel(label, { exact: true })
    assert.equal(await select.locator(`option[value="${qwen.id}"]`).isDisabled(), false)
    await select.selectOption(qwen.id)
  }
  await page.locator('[data-ai-id="role-routing-save"]').click()
  await page.getByText(/流程默认值已保存/).waitFor()
  const expectedRouting = JSON.parse(readFileSync(join(home, 'category-routing.json'), 'utf8')).routing
  for (const category of ['guide', 'sketch', 'mvp']) assert.equal(expectedRouting[category].channel_id, qwen.id)
  await page.reload(); await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  for (const label of ['需求沟通 渠道', '界面与制作 渠道']) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), qwen.id)
  report.checks.push('Legacy-shaped Qwen 27B: directory -> encrypted save with no protocol migration -> both roles select/save/reload')
  await page.screenshot({ path: join(artifacts, 'qwen-role-routing.png'), fullPage: true })
  const verifyRuntime = async (channelId, runId) => {
    await app.close(); app = undefined
    await promisify(execFile)(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, 'scripts/fixtures/launch-channel-protocol.mjs'), `--user-data-dir=${join(home, 'profile')}`], {
      cwd: root, env: { ...env, CHANNEL_PROTOCOL_FIXTURE_MODULE: compiled, CHANNEL_PROTOCOL_FIXTURE_INPUT: JSON.stringify({ home, origin: service.origin, channelId, runId }) },
      windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024,
    })
    const summary = JSON.parse(readFileSync(join(home, runId + '-runtime.json'), 'utf8'))
    app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: [`--user-data-dir=${join(home, 'profile')}`, '.'], cwd: root, env, timeout: 30000 })
    page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message))
    await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
    return summary
  }
  report.runtime.push(await verifyRuntime(qwen.id, 'qwen-default'))
  report.checks.push('Qwen default: real Pi -> request budgets -> Chat HTTP -> interleaved tools -> actual file reads -> tool results -> final text -> cache-correct ledger')

  await page.getByRole('button', { name: '添加新渠道', exact: true }).click()
  form = page.locator('form')
  await form.getByLabel('模型提供商', { exact: true }).selectOption('custom')
  await form.getByLabel('请求协议', { exact: true }).selectOption('anthropic-messages')
  await form.getByPlaceholder('例如：我的 DeepSeek').fill('自定义协议网关')
  await form.getByLabel('服务地址', { exact: true }).fill(service.origin + '/gateway/v2/messages?tenant=fixture')
  await form.getByPlaceholder('sk-…').fill('offline-custom-not-real')
  await form.getByLabel('手动添加模型', { exact: true }).fill('brand-new-model-id')
  await form.locator('[data-ai-id="channel-model-add"]').click()
  await form.getByLabel('brand-new-model-id 最大输出', { exact: true }).fill('4096')
  await form.getByRole('button', { name: '测试连接', exact: true }).click()
  await form.getByText('连接成功', { exact: true }).waitFor()
  await form.getByRole('button', { name: '保存渠道', exact: true }).click()
  await page.locator('[data-ai-id="channel-settings-page"]').getByText('自定义协议网关', { exact: true }).waitFor()
  const custom = savedChannels().find(channel => channel.provider_type === 'custom')
  assert.equal(custom.protocol, 'anthropic-messages')
  report.runtime.push(await verifyRuntime(custom.id, 'custom-anthropic'))
  report.checks.push('Custom preset + explicit Anthropic: same UI probe and runtime endpoint/query; arbitrary request model ID; real tools and accounting')

  await page.getByTitle('编辑渠道', { exact: true }).nth(1).click()
  form = page.locator('form')
  assert.equal(await form.getByLabel('请求协议', { exact: true }).inputValue(), 'anthropic-messages')
  await page.screenshot({ path: join(artifacts, 'protocol-editor.png'), fullPage: true })
  await form.getByLabel('请求协议', { exact: true }).selectOption('')
  await form.getByLabel('服务地址', { exact: true }).fill(service.origin + '/gateway/v2/chat/completions?tenant=fixture')
  await form.getByRole('button', { name: '保存修改', exact: true }).click()
  await page.getByRole('button', { name: '添加新渠道', exact: true }).waitFor()
  assert.equal(savedChannels().find(channel => channel.id === custom.id).protocol, undefined)
  report.runtime.push(await verifyRuntime(custom.id, 'custom-default-chat'))
  assert.equal(report.runtime.at(-1).protocol, 'openai-chat-completions')
  report.checks.push('Saved override round-trip and explicit clear to provider default; existing encrypted key retained on same origin; custom Chat tool loop works')

  const unavailable = await page.evaluate(async base => window.electronAPI.channels.create({ request_id: crypto.randomUUID(),
    name: 'Responses 尚未实现', provider_type: 'anthropic', protocol: 'openai-responses', base_url: base, api_key: 'offline-unused', models: [{ id: 'm', name: 'm', enabled: true }],
  }), service.origin)
  assert.equal(unavailable.ok, true)
  const denied = await page.evaluate(async id => window.electronAPI.channels.categoryRoutingRoleUpdate({ request_id: crypto.randomUUID(), routing: { guide: { channel_id: id } } }), unavailable.data.id)
  assert.equal(denied.ok, false)
  assert.ok(JSON.stringify(denied).includes('Responses'))
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'category-routing.json'), 'utf8')).routing, expectedRouting)
  await page.reload(); await page.getByRole('button', { name: '设置（模型渠道）', exact: true }).click()
  const disabled = page.getByLabel('需求沟通 渠道', { exact: true }).locator(`option[value="${unavailable.data.id}"]`)
  assert.equal(await disabled.isDisabled(), true); assert.ok((await disabled.textContent()).includes('尚未实现'))
  report.checks.push('Unimplemented protocol remains visible with reason; production IPC rejects role assignment atomically')
  assert.deepEqual(service.errors, []); assert.deepEqual(report.errors, [])
  for (const request of service.requests.filter(row => row.method === 'POST')) {
    if (request.path.includes('/chat/completions')) for (const field of ['thinking', 'output_config', 'reasoning_effort']) assert.ok(!(field in request.body))
  }
  assert.equal(service.requests.filter(row => row.method === 'POST').length, 6)
} catch (error) { report.errors.push(error instanceof Error ? error.stack + String.fromCharCode(10) + JSON.stringify({ code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr }) : String(error)); process.exitCode = 1 }
finally {
  report.requests = service.requests.map(request => ({ path: request.path, method: request.method, model: request.body?.model }))
  writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (app) await app.close().catch(() => {})
  await service.close(); rmSync(compiled, { force: true }); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
