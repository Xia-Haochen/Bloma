// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { resetChannelsFetchFlagForTests, channelsListAtom } from '../../../renderer/components/atoms-sprint2'
import { configure, cleanup, render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelSettingsPage } from '../../../renderer/components/ChannelSettingsPage'
import type {
  CategoryRoutingRoleListResult,
  CategoryRoutingRoleUpdateEnvelope,
  Channel,
  ElectronAPI,
  RequestEnvelope,
} from '../../../shared/types'

configure({ testIdAttribute: 'data-ai-id' })

const CHANNELS: Channel[] = [
  {
    id: 'ch-kimi',
    name: 'Kimi 渠道',
    provider_type: 'kimi-api',
    base_url: 'https://kimi.example',
    api_key: '***',
    enabled: true,
    models: [{ id: 'm1', name: 'kimi-k2.6', enabled: true }],
  },
  {
    id: 'ch-zhipu-openai',
    name: '智谱 OpenAI 协议',
    provider_type: 'zhipu',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key: '***',
    enabled: true,
    models: [{ id: 'm2', name: 'glm-5', enabled: true }],
  },
]

function makeViews(overrides: Array<Partial<CategoryRoutingRoleListResult['views'][number]>> = []): CategoryRoutingRoleListResult['views'] {
  const base: CategoryRoutingRoleListResult['views'] = [
    { role: 'guide', label: '需求沟通', description: '澄清需求、提取 PRD 与整理项目记忆', categories: ['guide'], channel_id: 'ch-kimi', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'routed' },
    { role: 'programming', label: '界面与制作', description: '生成草图与完整可运行版本', categories: ['sketch', 'mvp'], channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' },
  ]
  for (const override of overrides) {
    const index = base.findIndex((view) => view.role === override.role)
    if (index >= 0) base[index] = { ...base[index]!, ...override }
  }
  return base
}

function installApi(options: {
  views: CategoryRoutingRoleListResult['views']
  onUpdate?: (input: CategoryRoutingRoleUpdateEnvelope) => CategoryRoutingRoleListResult
}): { updateSpy: ReturnType<typeof vi.fn> } {
  const updateSpy = vi.fn()
  window.electronAPI = {
    channels: {
      list: () => Promise.resolve({ ok: true, request_id: 't', data: CHANNELS }),
      categoryRoutingRoleList: (_input: RequestEnvelope) =>
        Promise.resolve({ ok: true, request_id: 't', data: { version: 3, views: options.views } }),
      categoryRoutingRoleUpdate: (input: CategoryRoutingRoleUpdateEnvelope) => {
        updateSpy(input)
        const data = options.onUpdate ? options.onUpdate(input) : { version: 2, views: options.views }
        return Promise.resolve({ ok: true, request_id: 't', data })
      },
    },
  } as unknown as ElectronAPI
  return { updateSpy }
}

describe('M5 三角色渠道配置区（ChannelSettingsPage）', () => {
  beforeEach(() => { vi.restoreAllMocks(); resetChannelsFetchFlagForTests() })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
  })

  it('渲染三角色与原生Agent支持的渠道（包含智谱协议）', async () => {
    installApi({ views: makeViews() })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)

    await screen.findByLabelText('需求沟通 渠道')
    for (const label of ['需求沟通', '界面与制作']) {
      expect(screen.getByText(label)).toBeDefined()
    }
    expect(screen.queryByText('草图生成')).toBeNull()

    const select = screen.getByLabelText('需求沟通 渠道') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((option) => option.textContent ?? '')
    expect(optionTexts.some((text) => text.includes('智谱 OpenAI 协议'))).toBe(true)
    expect(optionTexts.some((text) => text.includes('Kimi 渠道'))).toBe(true)
    expect(select.value).toBe('ch-kimi')
  })

  it('悬空角色显示警示，「恢复自动」后保存不再携带该角色配置', async () => {
    const restored = makeViews([{ role: 'guide', channel_id: undefined, channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'auto' }])
    const { updateSpy } = installApi({
      views: makeViews([{ role: 'guide', channel_id: 'ch-deleted', channel_name: 'Kimi 渠道', model_name: 'kimi-k2.6', effective: 'dangling' }]),
      onUpdate: () => ({ version: 2, views: restored }),
    })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('保存的渠道引用已失效；未明确选择会话渠道时回退默认')
    await act(async () => fireEvent.click(screen.getByText('恢复自动')))
    await act(async () => fireEvent.click(screen.getByTestId('role-routing-save')))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    const payload = updateSpy.mock.calls[0]![0] as CategoryRoutingRoleUpdateEnvelope
    expect(payload.routing.guide).toEqual({})
    expect(payload.routing.programming).toBeUndefined()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('滚轮悬停角色渠道下拉循环切换自动/各渠道', async () => {
    installApi({ views: makeViews() })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    await waitFor(() => expect(screen.getByText('流程模型路由')).toBeDefined())

    const select = screen.getByLabelText('需求沟通 渠道') as HTMLSelectElement
    expect(select.value).toBe('ch-kimi')
    await act(async () => fireEvent.wheel(select, { deltaY: 100 }))
    expect(select.value).toBe('ch-zhipu-openai')
    await act(async () => fireEvent.wheel(select, { deltaY: 100 }))
    expect(select.value).toBe('')
    expect((screen.getByTestId('role-routing-save') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => fireEvent.wheel(select, { deltaY: -100 }))
    expect(select.value).toBe('ch-zhipu-openai')
    await act(async () => fireEvent.wheel(select, { deltaY: -100 }))
    expect(select.value).toBe('ch-kimi')
  })

  it('历史类别配置不一致时显示 mixed，选择渠道可统一该角色', async () => {
    const { updateSpy } = installApi({
      views: makeViews([{ role: 'guide', channel_id: undefined, fallback_channel_ids: undefined, effective: 'mixed' }]),
      onUpdate: () => ({ version: 2, views: makeViews() }),
    })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('沿用了旧的分项配置')
    const select = screen.getByLabelText('需求沟通 渠道') as HTMLSelectElement
    await act(async () => fireEvent.change(select, { target: { value: 'ch-kimi' } }))
    await act(async () => fireEvent.click(screen.getByTestId('role-routing-save')))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    expect((updateSpy.mock.calls[0]![0] as CategoryRoutingRoleUpdateEnvelope).routing.guide?.channel_id).toBe('ch-kimi')
  })

  it('「恢复全部默认」提交空角色路由表', async () => {
    const { updateSpy } = installApi({ views: makeViews(), onUpdate: () => ({ version: 2, views: makeViews() }) })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    await waitFor(() => expect(screen.getByTestId('role-routing-reset-all')).toBeDefined())
    await act(async () => fireEvent.click(screen.getByTestId('role-routing-reset-all')))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    expect((updateSpy.mock.calls[0]![0] as CategoryRoutingRoleUpdateEnvelope).routing).toEqual({guide:{},programming:{}})
  })

  it('contains no retired judge/compatibility entry and shows candidate route provenance',async()=>{
    installApi({views:makeViews()});render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>);await screen.findByLabelText('需求沟通 渠道')
    expect(screen.queryByTestId('legacy-routing-details')).toBeNull();expect(screen.queryByText(/旧裁判|旧流程兼容/)).toBeNull();expect(screen.queryByText(/生效模型：/)).toBeNull();expect(screen.getByText(/会话明确选择的渠道/)).toBeDefined()
  })
  it('can clear one mixed current group without sending another group',async()=>{
    const {updateSpy}=installApi({views:makeViews([{role:'programming',effective:'mixed',channel_id:undefined}])});render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>);await screen.findByText('统一为自动');fireEvent.click(screen.getByText('统一为自动'));fireEvent.click(screen.getByTestId('role-routing-save'));await waitFor(()=>expect(updateSpy).toHaveBeenCalledTimes(1));expect(updateSpy.mock.calls[0][0].routing).toEqual({programming:{}})
  })
})


describe('role configuration load/save recovery', () => {
  beforeEach(() => resetChannelsFetchFlagForTests())
  afterEach(() => { cleanup(); delete window.electronAPI })

  it('keeps the entry visible on load failure and retries without losing stored configuration', async () => {
    installApi({ views: makeViews() })
    const list = vi.fn().mockRejectedValue(new Error('offline'))
    window.electronAPI!.channels.categoryRoutingRoleList = list
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    await screen.findByText(/角色配置读取失败/)
    expect(screen.getByText('流程模型路由')).toBeTruthy()
    list.mockResolvedValue({ ok: true, data: { version: 3, views: makeViews() } })
    fireEvent.click(screen.getByTestId('role-routing-reload'))
    await screen.findByLabelText('需求沟通 渠道')
    expect((screen.getByLabelText('需求沟通 渠道') as HTMLSelectElement).value).toBe('ch-kimi')
  })

  it('retains the selected draft and surfaces a failed save instead of claiming success', async () => {
    installApi({ views: makeViews() })
    window.electronAPI!.channels.categoryRoutingRoleUpdate = vi.fn().mockResolvedValue({ ok: false, error: { message: 'CATEGORY_ROUTING_INVALID: 所选渠道已禁用，请刷新', user_visible_message: '这次操作缺少必要信息，请再试一次。' } })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    const select = await screen.findByLabelText('需求沟通 渠道') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'ch-zhipu-openai' } })
    fireEvent.click(screen.getByTestId('role-routing-save'))
    await screen.findByText('所选渠道已禁用，请刷新')
    expect(select.value).toBe('ch-zhipu-openai')
    expect((screen.getByTestId('role-routing-save') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/流程默认值已保存/)).toBeNull()
  })
})


describe('role drafts and channel availability', () => {
  beforeEach(() => resetChannelsFetchFlagForTests())
  afterEach(() => { cleanup(); delete window.electronAPI })

  it('refreshes after channel changes while preserving an unsaved selection', async () => {
    installApi({ views: makeViews() })
    const list = vi.fn().mockResolvedValue({ ok: true, data: { version: 3, views: makeViews() } })
    window.electronAPI!.channels.categoryRoutingRoleList = list
    const store = createStore()
    render(<Provider store={store}><ChannelSettingsPage /></Provider>)
    const select = await screen.findByLabelText('需求沟通 渠道') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'ch-zhipu-openai' } })
    const count = list.mock.calls.length
    await act(async () => { store.set(channelsListAtom, [...CHANNELS, { ...CHANNELS[0]!, id: 'new', name: '新增渠道' }]) })
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(count))
    expect(select.value).toBe('ch-zhipu-openai')
    expect(Array.from(select.options).some(option => option.value === 'new')).toBe(true)
    expect((screen.getByTestId('role-routing-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not let a backup-only edit erase mixed legacy primary channels', async () => {
    installApi({ views: makeViews([{ role: 'programming', effective: 'mixed', channel_id: undefined }]) })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    const row = await screen.findByTestId('role-routing-row-programming')
    fireEvent.click(within(row).getByRole('button', { name: '备用顺序' }))
    const checkbox = within(row).getAllByRole('checkbox')[0] as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    fireEvent.click(within(row).getByText('统一为自动'))
    expect(checkbox.disabled).toBe(false)
  })

  it('shows an unavailable saved choice explicitly and excludes disabled/no-model alternatives', async () => {
    installApi({ views: makeViews([{ role: 'guide', effective: 'dangling' }]) })
    window.electronAPI!.channels.list = vi.fn().mockResolvedValue({ ok: true, data: [
      { ...CHANNELS[0]!, enabled: false }, { ...CHANNELS[1]!, models: [] },
    ] })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    const select = await screen.findByLabelText('需求沟通 渠道') as HTMLSelectElement
    await screen.findByText(/没有可用于角色 Agent 的渠道/)
    expect(select.value).toBe('ch-kimi')
    expect(select.selectedOptions[0]!.disabled).toBe(true)
    expect(Array.from(select.options).find(option => option.value === 'ch-zhipu-openai')?.disabled).toBe(true)
  })
})


describe('unavailable backup repair', () => {
 beforeEach(() => resetChannelsFetchFlagForTests())
 afterEach(() => { cleanup(); delete window.electronAPI })
 it('lets a user remove a hidden/invalid backup without resetting other roles', async () => {
  const { updateSpy } = installApi({ views: makeViews([{ role: 'guide', fallback_channel_ids: ['deleted-backup'] }]) })
  render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
  const row = await screen.findByTestId('role-routing-row-guide')
  fireEvent.change(within(row).getByLabelText('需求沟通 渠道'), { target: { value: 'ch-zhipu-openai' } })
  fireEvent.click(within(row).getByRole('button', { name: /备用顺序/ }))
  expect(within(row).getByText('不可用备用渠道：deleted-backup（已删除）')).toBeTruthy()
  fireEvent.click(within(row).getByRole('button', { name: '需求沟通 移除不可用备用 deleted-backup' }))
  fireEvent.click(screen.getByTestId('role-routing-save'))
  await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
  expect(updateSpy.mock.calls[0]![0].routing).toEqual({ guide: { channel_id: 'ch-zhipu-openai' } })
 })
})

describe('role selection follows channel protocol, not brand', () => {
  beforeEach(() => { vi.restoreAllMocks(); resetChannelsFetchFlagForTests() })
  afterEach(() => { cleanup(); delete window.electronAPI })
  it('makes legacy Qwen 27B and custom overrides selectable and explains unavailable protocols', async () => {
    const { updateSpy } = installApi({ views: makeViews() })
    window.electronAPI!.channels.list = vi.fn().mockResolvedValue({ ok: true, data: [
      ...CHANNELS,
      { ...CHANNELS[0], id: '27b', name: '27B', provider_type: 'qwen', models: [{ id: 'arbitrary-id', name: 'qwen3.8-27b', enabled: true }] },
      { ...CHANNELS[0], id: 'custom', name: 'Any Gateway', provider_type: 'google', protocol: 'anthropic-messages' },
      { ...CHANNELS[0], id: 'not-ready', name: 'Responses Channel', provider_type: 'anthropic', protocol: 'openai-responses' },
    ] })
    render(<Provider store={createStore()}><ChannelSettingsPage /></Provider>)
    const select = await screen.findByLabelText('需求沟通 渠道') as HTMLSelectElement
    await waitFor(() => expect(Array.from(select.options).some(option => option.value === '27b')).toBe(true))
    for (const id of ['27b', 'custom']) expect(Array.from(select.options).find(option => option.value === id)?.disabled).toBe(false)
    const unsupported = Array.from(select.options).find(option => option.value === 'not-ready')!
    expect(unsupported.disabled).toBe(true); expect(unsupported.textContent).toContain('Responses'); expect(unsupported.textContent).toContain('尚未实现')
    fireEvent.change(select, { target: { value: '27b' } })
    fireEvent.click(screen.getByTestId('role-routing-save'))
    await waitFor(() => expect(updateSpy).toHaveBeenCalledOnce())
    expect(updateSpy.mock.calls[0]![0].routing).toEqual({ guide: { channel_id: '27b' } })
  })
})
