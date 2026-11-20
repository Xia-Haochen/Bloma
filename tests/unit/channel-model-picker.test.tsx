// @vitest-environment jsdom
// 渠道设置页「模型点选列表」（用户 2026-08-30 点名第一优先队列 ①：对齐 proma ChannelModel 勾选列表）。
// 期望行为来源（独立于实现）：notes.md 第一优先队列 —— 每模型 enabled 开关 + 搜索过滤 + 全选/清空 +
// 「阿里云渠道模型多，必须可过滤」；shared/types.ts §4 ChannelModel.enabled 契约 +
// main/channel-manager.ts:150 getEnabledModels 只认 enabled=true（未启用模型不得参与解析）。
// 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../renderer/components/ChannelSettingsPage'
import { resetChannelsFetchFlagForTests } from '../../renderer/components/atoms-sprint2'

configure({ testIdAttribute: 'data-ai-id' })

type ChannelsApi = {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  testDirect: ReturnType<typeof vi.fn>
  fetchModels: ReturnType<typeof vi.fn>
}

let api: ChannelsApi
let store: ReturnType<typeof createStore>

function mountWithChannels(existing: unknown[] = []): void {
  // 每用例一 个 fresh Jotai store：channelsListAtom 是全局原子，不隔离会把上一例创建的渠道泄漏进下一例
  store = createStore()
  resetChannelsFetchFlagForTests()
  api = {
    list: vi.fn().mockResolvedValue({ ok: true, data: existing }),
    create: vi.fn().mockImplementation((input: Record<string, unknown>) =>
      Promise.resolve({
        ok: true,
        data: {
          id: 'ch-1',
          name: input.name,
          provider_type: input.provider_type,
          base_url: input.base_url,
          api_key: 'enc-hex',
          enabled: true,
          models: input.models ?? [],
        },
      }),
    ),
    update: vi.fn().mockResolvedValue({ ok: true, data: { id: 'ch-1' } }),
    remove: vi.fn().mockResolvedValue({ ok: true, data: { ok: true } }),
    testDirect: vi.fn().mockResolvedValue({ ok: true, data: { ok: true, message: '连接正常' } }),
    fetchModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [] } }),
  }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { channels: api }
  render(
    <Provider store={store}>
      <ChannelSettingsPage />
    </Provider>,
  )
}

/** 直达「新建渠道」表单 */
async function openCreateForm(): Promise<void> {
  const add = await screen.findByRole('button', { name: /添加|新增|新建|配置/ })
  fireEvent.click(add)
}

/** 填完 create 模式的必填项（名称 + Key），否则保存按钮禁用 */
function fillRequired(): void {
  fireEvent.change(screen.getByPlaceholderText(/例如：我的 DeepSeek/), { target: { value: '测试渠道' } })
  fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-test-123' } })
}

async function addModels(text: string): Promise<void> {
  const input = await screen.findByTestId('channel-model-add-input')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.click(screen.getByTestId('channel-model-add'))
}

function counts(): string {
  return screen.getByTestId('channel-model-count').textContent ?? ''
}

function boxes(): HTMLInputElement[] {
  return screen.getAllByRole('checkbox') as HTMLInputElement[]
}

function box(name: string): HTMLInputElement {
  return screen.getByTestId(`channel-model-${name}`) as HTMLInputElement
}

describe('渠道模型点选列表（勾选 / 过滤 / 全选清空 / 持久化 enabled）', () => {
  it('persists an explicit million-token proxy window without testing the provider',async()=>{
    mountWithChannels();await openCreateForm();await addModels('proxy-model');fillRequired()
    fireEvent.change(screen.getByLabelText('proxy-model 上下文窗口'),{target:{value:'1000000'}})
    fireEvent.click(screen.getByRole('button',{name:/保存/}))
    await waitFor(()=>expect(api.create).toHaveBeenCalled())
    expect(api.create.mock.calls[0][0].models[0]).toMatchObject({name:'proxy-model',context_window:1000000})
    expect(api.testDirect).not.toHaveBeenCalled()
  })
  beforeEach(() => {
    if (!(window as never as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u-' + Math.random() } })
    }
  })
  afterEach(() => {
    delete (window as never as { electronAPI?: unknown }).electronAPI
    cleanup()
  })

  it('[M1·空态] 逗号文本框已移除，空列表给出添加引导', async () => {
    mountWithChannels()
    await openCreateForm()
    expect(await screen.findByTestId('channel-model-add-input')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/deepseek-chat/)).toBeNull()
    expect(screen.queryByTestId('channel-model-list')).toBeNull() // 空列表不渲染滚动区
    expect(screen.getByText(/还没有模型/)).toBeTruthy()
  })

  it('[M2·手动添加] 逗号批量 + 重名去重 + 默认全部启用', async () => {
    mountWithChannels()
    await openCreateForm()
    await addModels('a, b , a')
    expect(await screen.findByTestId('channel-model-a')).toBeTruthy()
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(counts()).toContain('已启用 2 / 共 2')
  })

  it('[M3·开关持久化] 取消勾选后保存，入参保留 enabled=false（未被重新抹平为 true）', async () => {
    mountWithChannels()
    await openCreateForm()
    await addModels('a,b')
    fireEvent.click(screen.getByTestId('channel-model-a'))
    expect(counts()).toContain('已启用 1 / 共 2')
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /保存渠道/ }))
    await waitFor(() => expect(api.create).toHaveBeenCalled())
    const payload = api.create.mock.calls[0][0]
    expect(payload.models.map((m: { name: string; enabled: boolean }) => [m.name, m.enabled])).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('[M4·全选/清空] 清空后 0 启用、全选恢复全启用（列表仍完整保留，不被删条目）', async () => {
    mountWithChannels()
    await openCreateForm()
    await addModels('a,b,c')
    fireEvent.click(screen.getByTestId('channel-model-clear'))
    expect(counts()).toContain('已启用 0 / 共 3')
    expect(boxes().every((b) => !b.checked)).toBe(true)
    fireEvent.click(screen.getByTestId('channel-model-select-all'))
    await waitFor(() => expect(counts()).toContain('已启用 3 / 共 3'))
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  })

  it('[M5·搜索过滤] 只筛不删：过滤集内的全选/清空不误伤未匹配模型', async () => {
    mountWithChannels()
    await openCreateForm()
    await addModels('qwen-max,qwen-plus,gpt-4o')
    fireEvent.change(screen.getByTestId('channel-model-filter'), { target: { value: 'qwen' } })
    expect(await screen.findByTestId('channel-model-qwen-max')).toBeTruthy()
    expect(screen.queryByTestId('channel-model-gpt-4o')).toBeNull()
    // 列表可见行 = 2，按钮带筛选计数
    expect(screen.getByTestId('channel-model-list').querySelectorAll('input[type=checkbox]')).toHaveLength(2)
    expect(screen.getByTestId('channel-model-select-all').textContent).toContain('全选（2）')
    fireEvent.click(screen.getByTestId('channel-model-clear'))
    await waitFor(() => expect(counts()).toContain('已启用 1 / 共 3'))
    // gpt-4o（未匹配项）保持启用
    fireEvent.change(screen.getByTestId('channel-model-filter'), { target: { value: 'gpt' } })
    expect((screen.getByTestId('channel-model-gpt-4o') as HTMLInputElement).checked).toBe(true)
  })

  it('[M6·拉取合并] 拉取模型不得重置已有启用位，只追加新名（旧文本框实现会全抹成 true）', async () => {
    mountWithChannels()
    await openCreateForm()
    await addModels('a,c')
    fireEvent.click(screen.getByTestId('channel-model-a')) // a 手动禁用
    api.fetchModels.mockResolvedValue({
      ok: true,
      data: { models: [{ id: 'a', name: 'a', enabled: true }, { id: 'd', name: 'd', enabled: true }] },
    })
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /拉取模型/ }))
    await waitFor(() => expect(api.fetchModels).toHaveBeenCalled())
    await waitFor(() => expect(counts()).toContain('共 3'))
    expect((screen.getByTestId('channel-model-a') as HTMLInputElement).checked).toBe(false) // 已有禁用项保持
    expect((screen.getByTestId('channel-model-d') as HTMLInputElement).checked).toBe(true) // 新项默认启用
    expect(counts()).toContain('已启用 2 / 共 3')
  })

  it('[M7·移除≠禁用] 移除的条目从保存入参消失，取消勾选的条目仍保留（两维语义不同）', async () => {
    mountWithChannels()
    await openCreateForm()
    await addModels('a,b,c')
    fireEvent.click(screen.getByTestId('channel-model-b')) // 禁用
    fireEvent.click(screen.getByTestId('channel-model-remove-c')) // 移除
    await waitFor(() => expect(counts()).toContain('已启用 1 / 共 2'))
    expect(screen.queryByTestId('channel-model-c')).toBeNull()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: /保存渠道/ }))
    await waitFor(() => expect(api.create).toHaveBeenCalled())
    const models = api.create.mock.calls[0][0].models as Array<{ name: string; enabled: boolean }>
    expect(models.map((m) => m.name)).toEqual(['a', 'b'])
    expect(models.find((m) => m.name === 'b')?.enabled).toBe(false)
  })
})

// Upstream alignment regressions use fake IPC only: no credentials or paid calls.
describe('model configuration consistency', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    cleanup()
  })

  it('saves maximum output separately from context and keeps fetched metadata', async () => {
    mountWithChannels(); await openCreateForm(); fillRequired()
    api.fetchModels.mockResolvedValue({ ok: true, data: { success: true, models: [{ id: 'api-model', name: 'api-model', display_name: 'Friendly Model', context_window: 1048576, max_output_tokens: 8192, supports_tools: false, enabled: true }] } })
    fireEvent.click(screen.getByRole('button', { name: /拉取模型/ }))
    await screen.findByTestId('channel-model-api-model')
    expect((screen.getByLabelText('api-model 上下文窗口') as HTMLInputElement).value).toBe('1048576')
    expect(screen.getByText('Friendly Model')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('api-model 最大输出'), { target: { value: '4096' } })
    fireEvent.click(screen.getByRole('button', { name: /保存渠道/ }))
    await waitFor(() => expect(api.create).toHaveBeenCalled())
    expect(api.create.mock.calls[0][0].models[0]).toMatchObject({ name: 'api-model', display_name: 'Friendly Model', context_window: 1048576, max_output_tokens: 4096, supports_tools: false })
  })

  it('shows inner fetch failure instead of replacing it with a generic empty-list message', async () => {
    mountWithChannels(); await openCreateForm(); fillRequired(); await addModels('keep-me')
    api.fetchModels.mockResolvedValue({ ok: true, data: { success: false, message: '供应商拒绝访问，请检查权限', models: [] } })
    fireEvent.click(screen.getByRole('button', { name: /拉取模型/ }))
    expect(await screen.findByText('供应商拒绝访问，请检查权限')).toBeTruthy()
    expect(screen.getByTestId('channel-model-keep-me')).toBeTruthy()
  })

  it('switches default URL and clears old models and results when provider changes', async () => {
    mountWithChannels(); await openCreateForm(); fillRequired(); await addModels('old-model')
    // First switch sets a default URL. Second switch must not retain that old default.
    const provider = screen.getAllByRole('combobox')[0]!
    fireEvent.change(provider, { target: { value: 'openai' } })
    fireEvent.change(provider, { target: { value: 'google' } })
    const url = screen.getByDisplayValue('https://generativelanguage.googleapis.com')
    expect(url).toBeTruthy()
    expect(screen.queryByTestId('channel-model-old-model')).toBeNull()
    expect((screen.getByPlaceholderText('sk-…') as HTMLInputElement).value).toBe('')
  })

  it('discards stale directory responses after changing the service URL', async () => {
    mountWithChannels(); await openCreateForm(); fillRequired()
    let resolve!: (value: unknown) => void
    api.fetchModels.mockReturnValue(new Promise(r => { resolve = r }))
    fireEvent.click(screen.getByRole('button', { name: /拉取模型/ }))
    const url = screen.getByPlaceholderText(/留空使用/)
    fireEvent.change(url, { target: { value: 'https://new.example' } })
    resolve({ ok: true, data: { success: true, models: [{ id: 'stale', name: 'stale', enabled: true }] } })
    await waitFor(() => expect(screen.getByRole('button', { name: /拉取模型/ }).textContent).toContain('拉取模型'))
    expect(screen.queryByTestId('channel-model-stale')).toBeNull()
  })

  it('does not allow blank saved credentials to be used on a changed host', async () => {
    mountWithChannels([{ id: 'saved', name: 'Saved', provider_type: 'anthropic', base_url: 'https://saved.example', api_key: '***', enabled: true, models: [] }])
    fireEvent.click(await screen.findByTitle('编辑渠道'))
    fireEvent.change(screen.getByDisplayValue('https://saved.example'), { target: { value: 'https://new.example' } })
    const save = screen.getByRole('button', { name: /保存修改/ }) as HTMLButtonElement
    expect((within(save.closest('form')!).getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(true)
    expect(save.disabled).toBe(true)
    expect(screen.getByText(/重新填写 API Key/)).toBeTruthy()
  })
})

describe('explicit protocol editor', () => {
  afterEach(() => { cleanup(); delete (window as unknown as { electronAPI?: unknown }).electronAPI })
  it('passes the same explicit protocol to test, directory and create requests', async () => {
    mountWithChannels(); await openCreateForm()
    fireEvent.change(screen.getByLabelText('模型提供商'), { target: { value: 'custom' } }); fillRequired(); await addModels('free-form-model')
    fireEvent.change(screen.getByLabelText('服务地址'), { target: { value: 'https://gateway.example/v2' } })
    fireEvent.change(screen.getByLabelText('请求协议'), { target: { value: 'anthropic-messages' } })
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(api.testDirect).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    await waitFor(() => expect(api.fetchModels).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '保存渠道' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce())
    expect(api.testDirect.mock.calls[0]![0].input.protocol).toBe('anthropic-messages')
    expect(api.fetchModels.mock.calls[0]![0].input.protocol).toBe('anthropic-messages')
    expect(api.create.mock.calls[0]![0].protocol).toBe('anthropic-messages')
  })
  it('reads a saved override and can clear it back to provider default', async () => {
    mountWithChannels([{ id: 'saved', name: 'Saved', provider_type: 'custom', protocol: 'anthropic-messages', base_url: 'https://saved.example', api_key: '***', enabled: true, models: [] }])
    fireEvent.click(await screen.findByTitle('编辑渠道'))
    expect((screen.getByLabelText('请求协议') as HTMLSelectElement).value).toBe('anthropic-messages')
    fireEvent.change(screen.getByLabelText('请求协议'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.update).toHaveBeenCalledOnce())
    expect(api.update.mock.calls[0]![0].input.protocol).toBe(null)
  })
  it('invalidates an in-flight directory response when the protocol changes', async () => {
    mountWithChannels(); await openCreateForm(); fillRequired()
    let resolve!: (value: unknown) => void
    api.fetchModels.mockReturnValue(new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }))
    fireEvent.change(screen.getByLabelText('请求协议'), { target: { value: 'openai-chat-completions' } })
    resolve({ ok: true, data: { success: true, models: [{ id: 'stale', name: 'stale', enabled: true }] } })
    await waitFor(() => expect(screen.getByRole('button', { name: '拉取模型' }).textContent).toContain('拉取模型'))
    expect(screen.queryByTestId('channel-model-stale')).toBeNull()
  })
})

describe('connection test model identity', () => {
  afterEach(() => { cleanup(); delete (window as unknown as { electronAPI?: unknown }).electronAPI })
  it('discards a model-specific probe result after the enabled model changes', async () => {
    mountWithChannels(); await openCreateForm(); fillRequired(); await addModels('model-a,model-b')
    let resolve!: (value: unknown) => void
    api.testDirect.mockReturnValue(new Promise(done => { resolve = done }))
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(api.testDirect.mock.calls[0]![0].input.model_id).toBe('model-a')
    fireEvent.click(screen.getByTestId('channel-model-model-a'))
    resolve({ ok: true, data: { ok: true, message: 'stale-model-a-success' } })
    await waitFor(() => expect((screen.getByRole('button', { name: '测试连接' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('stale-model-a-success')).toBeNull()
  })
})
