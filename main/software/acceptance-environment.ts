import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { isStaticGuiSelector } from './gui-selectors'

export interface LlmSettingsBinding {
  open?: string
  endpoint: string
  model?: string
  api_key: string
  protocol?: string
  save: string
  ready: { selector: string; contains: string }
}
export interface AcceptanceEnvironmentEvidence {
  version: 1
  mode: 'isolated_local' | 'controlled_service'
  configuration_digest: string
  instance_id?: string
  readiness: 'ready' | 'blocked'
  external_model_effects: 'not_required' | 'unverified'
  request_expectation?: 'response' | 'none'
  requests: Array<{ phase: 'setup' | 'case'; valid: boolean; request_hash: string; response_hash?: string }>
}
export interface AcceptanceEnvironment {
  prepare(page: Page, segment: number): Promise<void>
  assess(observations: unknown[]): void
  isControlledResponse(value: unknown): boolean
  evidence(): AcceptanceEnvironmentEvidence
  close(): Promise<void>
}
export class AcceptanceEnvironmentError extends Error {}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code: string): never => { throw new AcceptanceEnvironmentError(code) }

function settingsBinding(value: unknown): LlmSettingsBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('ACCEPTANCE_ENVIRONMENT_SETTINGS_REQUIRED: CORE_CHECK.llm.settings 须登记产品正常模型设置界面')
  const row = value as Record<string, unknown>
  const fields = ['endpoint', 'api_key', 'save'].filter(key => !isStaticGuiSelector(row[key]))
  fields.push(...['open', 'model', 'protocol'].filter(key => row[key] !== undefined && !isStaticGuiSelector(row[key])))
  if (fields.length) return fail('ACCEPTANCE_ENVIRONMENT_SETTINGS_INVALID: 静态 CSS 绑定缺失或无效：' +
    fields.map(key => 'CORE_CHECK.llm.settings.' + key).join('、'))
  const ready = row.ready as Record<string, unknown> | undefined
  if (!ready || Array.isArray(ready) || !isStaticGuiSelector(ready.selector)) {
    return fail('ACCEPTANCE_ENVIRONMENT_READY_BINDING_INVALID: CORE_CHECK.llm.settings.ready.selector 须指向实际保存状态')
  }
  if (typeof ready.contains !== 'string' || !ready.contains.trim() || ready.contains.length > 200) {
    return fail('ACCEPTANCE_ENVIRONMENT_READY_BINDING_INVALID: CORE_CHECK.llm.settings.ready.contains 须填写实际保存成功文案')
  }
  return value as LlmSettingsBinding
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
}

interface AcceptanceSetupInput {
  root: string
  features: string[]
  requiresLlm: boolean
  useDeclaredSettingsOnly?: boolean
}

function readAcceptanceSetup(input: AcceptanceSetupInput) {
  const manifestPath = join(input.root, 'CORE_CHECK.json')
  let llm: Record<string, unknown> | undefined
  if (existsSync(manifestPath)) {
    const info = lstatSync(manifestPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) return fail('ACCEPTANCE_ENVIRONMENT_MANIFEST_INVALID')
    try { llm = JSON.parse(readFileSync(manifestPath, 'utf8')).llm } catch { return fail('ACCEPTANCE_ENVIRONMENT_MANIFEST_INVALID') }
  }
  const covers = llm?.covers
  const hasSettings = llm?.settings !== undefined && llm.input === undefined
  const covered = Array.isArray(covers) && input.features.some(feature => covers.includes(feature))
  const required = input.useDeclaredSettingsOnly
    ? hasSettings && (input.requiresLlm || covered || !Array.isArray(covers) || !covers.length)
    : input.requiresLlm || covered
  if (!required) return undefined
  if (!llm || llm.input !== undefined || !['openai-chat','anthropic-messages'].includes(String(llm.protocol))) {
    return fail('ACCEPTANCE_ENVIRONMENT_PROTOCOL_UNSUPPORTED: 首期支持已声明协议的文本对话依赖')
  }
  return { llm, settings: settingsBinding(llm.settings), anthropic: llm.protocol === 'anthropic-messages' }
}

/** Validate the same declared setup as the executor, without opening a service or test process. */
export function checkAcceptanceSetup(input: AcceptanceSetupInput): void {
  readAcceptanceSetup(input)
}

/** A host-owned dependency lease. No business assertions, product-specific IDs,
 * user data, provider keys or paid route selection are accepted by this API. */
export async function prepareAcceptanceEnvironment(input: AcceptanceSetupInput & {
  signal?: AbortSignal
  requestExpectation?: 'response' | 'none'
}): Promise<AcceptanceEnvironment> {
  input.signal?.throwIfAborted()
  const setup = readAcceptanceSetup(input)
  const required = Boolean(setup)
  const evidence: AcceptanceEnvironmentEvidence = { version: 1, mode: required ? 'controlled_service' : 'isolated_local',
    configuration_digest: hash({ version: 1, llm: setup?.llm ?? null, requestExpectation:input.requestExpectation??'response' }), readiness: 'ready',
    ...(required?{request_expectation:input.requestExpectation??'response'}:{}),
    external_model_effects: required ? 'unverified' : 'not_required', requests: [], ...(required?{instance_id:randomUUID()}:{}) }
  if (!setup) return { prepare: async () => {}, assess: () => {}, isControlledResponse: () => false, evidence: () => structuredClone(evidence), close: async () => {} }
  const { settings, anthropic, llm } = setup
  const token = randomUUID(), responses: string[] = []
  let model: string | undefined
  let prepared = false, closed = false
  evidence.readiness = 'blocked'
  const server = createServer((req, res) => {
    // A case gets its own endpoint and credential. Limit work and record only
    // metadata; request bodies and credential values never enter the report.
    if (req.method !== 'POST' || req.url !== (anthropic ? '/v1/messages' : '/v1/chat/completions') || evidence.requests.length >= 16) {
      res.writeHead(400); res.end(); return
    }
    let bytes = 0, body = ''
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) req.destroy(); else body += chunk })
    req.on('end', () => {
      let data: {model?:string;messages?:Array<{role?:string;content?:unknown}>} = {}
      try { data = JSON.parse(body) } catch { /* invalid request remains a failed observation */ }
      const valid = (anthropic ? req.headers['x-api-key'] === token && req.headers['anthropic-version'] === '2023-06-01' : req.headers.authorization === 'Bearer ' + token)
        && validModel(data?.model) && (model === undefined || data.model === model)
        && Array.isArray(data.messages) && data.messages.some(message => message && message.role === 'user'
          && (typeof message.content === 'string' && !!message.content.trim() || Array.isArray(message.content) && message.content.length > 0))
      if (valid && prepared && model === undefined) model = data.model
      const response = '这是一条验收服务回复，编号 ' + randomUUID().slice(0, 8) + '。'
      evidence.requests.push({ phase: prepared ? 'case' : 'setup', valid, request_hash: hash(body), ...(valid ? { response_hash: hash(response) } : {}) })
      if (valid && prepared) responses.push(response)
      res.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(!valid ? {error:'invalid_test_request'} : anthropic
        ? {type:'message',role:'assistant',content:[{type:'text',text:response}],stop_reason:'end_turn',usage:{input_tokens:0,output_tokens:0}}
        : {choices:[{message:{role:'assistant',content:response},finish_reason:'stop'}]}))
    })
  })
  server.requestTimeout = 5000
  const close = async () => {
    if (closed) return
    closed = true
    input.signal?.removeEventListener('abort', aborted)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  const aborted = () => { void close() }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    input.signal?.throwIfAborted()
  } catch (error) {
    await close();input.signal?.throwIfAborted()
    throw new AcceptanceEnvironmentError('ACCEPTANCE_ENVIRONMENT_START_FAILED: 本机受控服务未能启动')
  }
  input.signal?.addEventListener('abort', aborted, { once: true })
  const endpoint = 'http://127.0.0.1:' + (server.address() as {port:number}).port + '/v1'
  return {
    async prepare(page, segment) {
      if (segment > 0) return // A restart must prove persisted configuration; never reset business data or re-save settings.
      let step = '打开正常设置入口（settings.open）'
      try {
        input.signal?.throwIfAborted()
        const entryUrl = page.url()
        const field = page.locator(settings.endpoint)
        const openedSettings = settings.open && !await field.isVisible()
        if (openedSettings) await page.locator(settings.open!).click()
        if (settings.protocol) {
          step = '设置协议（settings.protocol）'
          await page.locator(settings.protocol).selectOption(String(llm.protocol))
        }
        step = '填写服务地址（settings.endpoint）'
        await field.fill(endpoint)
        if (settings.model) {
          step = '读取模型控件（settings.model，可省略）'
          const field = page.locator(settings.model)
          const current = await field.evaluate(element => {
            if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
              return { value: element.value.trim(), editable: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement }
            }
            return { value: '', editable: false }
          })
          if (validModel(current.value)) model = current.value
          else if (current.editable && await field.isEditable()) {
            model = 'bloma-acceptance-text'
            await field.fill(model)
          }
        }
        step = '填写隔离服务凭据（settings.api_key）'
        await page.locator(settings.api_key).fill(token)
        step = '保存配置（settings.save）'
        await page.locator(settings.save).click()
        const ready = page.locator(settings.ready.selector)
        step = '确认保存状态（settings.ready）'
        await ready.filter({hasText:settings.ready.contains}).waitFor({state:'visible',timeout:5000})
        // Provisioning is outside the case. Reset its navigation without
        // changing the isolated data directory or saving settings again.
        step = '回到正常应用入口'
        if (entryUrl !== page.url()) {
          const navigation = await page.goto(entryUrl, { waitUntil: 'load', timeout: 15000 })
          if (!navigation) await page.reload({ waitUntil: 'load', timeout: 15000 })
        } else if (openedSettings) {
          await page.reload({ waitUntil: 'load', timeout: 15000 })
        }
        input.signal?.throwIfAborted()
        prepared = true; evidence.readiness = 'ready'
      } catch (error) {
        input.signal?.throwIfAborted()
        throw new AcceptanceEnvironmentError('ACCEPTANCE_ENVIRONMENT_SETUP_FAILED: ' + step)
      }
    },
    assess(observations) {
      const requests = evidence.requests.filter(request => request.phase === 'case')
      if (input.requestExpectation === 'none') {
        if (requests.length) return fail('ACCEPTANCE_ENVIRONMENT_UNEXPECTED_REQUEST: 本案例要求零请求，但观察到服务调用')
        return
      }
      if (!requests.length) return fail('ACCEPTANCE_ENVIRONMENT_REQUEST_NOT_OBSERVED: 未观察到业务步骤调用准备好的服务，不能以非空气泡判通过')
      if (requests.some(request => !request.valid)) return fail('ACCEPTANCE_ENVIRONMENT_REQUEST_INVALID: 实际请求未遵守声明的服务协议')
      if (!observations.some(value => typeof value === 'string' && responses.some(response => value.includes(response)))) return fail('ACCEPTANCE_ENVIRONMENT_RESPONSE_NOT_OBSERVED: 未在业务观察中读回本次服务响应')
    },
    isControlledResponse: value => typeof value === 'string' && responses.some(response => value.includes(response)),
    evidence: () => structuredClone(evidence), close,
  }
}
