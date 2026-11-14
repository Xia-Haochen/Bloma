import React from 'react'
import { useAtomValue } from 'jotai'
import { currentProjectAtom, hasActiveStreamAtom } from '../agent-atoms'
import type { SoftwareModelSettings, SoftwareModelSettingsSave } from '../../shared/types'
import '../styles/software-model-settings.css'

export function SoftwareModelSettingsPanel() {
  const project = useAtomValue(currentProjectAtom)
  if (!project || project.workflow_version !== 'software-v1') return <div className="model-settings"><h2>验收设计</h2><p>进入一个新流程项目后，可在这里设置该项目的验收方式。</p></div>
  return <ProjectModelSettings key={project.project_id} projectId={project.project_id} name={project.name} />
}
function ProjectModelSettings({ projectId, name }: { projectId: string; name: string }) {
  const running = useAtomValue(hasActiveStreamAtom)
  const [data, setData] = React.useState<SoftwareModelSettings>()
  const [variant, setVariant] = React.useState<'single'|'independent'>('single')
  const [funding, setFunding] = React.useState<'project'|'independent'>('project')
  const [channel, setChannel] = React.useState(''), [model, setModel] = React.useState('')
  const [cap, setCap] = React.useState(''), [context, setContext] = React.useState('')
  const [inputPrice, setInputPrice] = React.useState(''), [outputPrice, setOutputPrice] = React.useState('')
  const [consent, setConsent] = React.useState(false), [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState(''), [error, setError] = React.useState('')
  const alive = React.useRef(true)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const apply = (value: SoftwareModelSettings) => {
    setData(value); setVariant(value.variant); setChannel(value.channel_id ?? ''); setModel(value.model ?? '')
    setFunding(value.funding ?? (value.channel_id ? 'independent' : 'project'))
    setCap(value.budget ? String(value.budget.cap_rmb) : ''); setConsent(false)
    setContext(value.pricing ? String(value.pricing.context_tokens) : ''); setInputPrice(value.pricing ? String(value.pricing.input_rmb_per_million) : ''); setOutputPrice(value.pricing ? String(value.pricing.output_rmb_per_million) : '')
  }
  const load = async () => {
    setPending(true); setError('')
    try {
      const api = window.electronAPI?.projectDeliverables
      if (!api?.modelSettings) throw Error('当前应用尚未加载配置接口，请正常重启 Bloma。')
      const result = await api.modelSettings({ request_id: crypto.randomUUID(), project_id: projectId })
      if (!alive.current) return
      if (result.ok) apply(result.data); else { setData(undefined); setError(result.error.user_visible_message || result.error.message) }
    } catch (error) { if (alive.current) { setData(undefined); setError(String(error)) } }
    finally { if (alive.current) setPending(false) }
  }
  React.useEffect(() => { void load() }, [projectId])
  const locked = !data || data.locked || running || pending
  const enabled = variant === 'independent'
  const edit = (setter: (value: string) => void, value: string) => { setter(value); setConsent(false); setMessage('') }
  const valid = !enabled || funding==='project' || data?.channels.find(item => item.id === channel)?.models.includes(model) && [cap,context,inputPrice,outputPrice].every(value => value.trim() !== '' && Number.isFinite(Number(value)))
    && Number(cap) > 0 && Number.isSafeInteger(Number(context)) && Number(context) > 0 && Number(inputPrice) >= 0 && Number(outputPrice) >= 0 && consent
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (locked || !valid || !data) return
    setPending(true); setError(''); setMessage('')
    const payload: SoftwareModelSettingsSave = { request_id: crypto.randomUUID(), project_id: projectId, revision: data.revision, variant }
    if(enabled)payload.funding=funding
    if (enabled&&funding==='independent') Object.assign(payload, { channel_id: channel, model, authorize_budget: consent,
      budget: { cap_rmb: Number(cap), context_tokens: Number(context), input_rmb_per_million: Number(inputPrice), output_rmb_per_million: Number(outputPrice) } })
    try {
      const api = window.electronAPI?.projectDeliverables
      if (!api?.saveModelSettings) throw Error('配置接口不可用')
      const result = await api.saveModelSettings(payload)
      if (!alive.current) return
      if (result.ok) { apply(result.data); setMessage('配置已保存；未调用模型。实际开工时仍会检查渠道、预算和预留。') }
      else setError(result.error.user_visible_message || result.error.message)
    } catch { if (alive.current) setError('保存未确认，请刷新核对后再操作。') }
    finally { if (alive.current) setPending(false) }
  }
  const reason = data?.lock_reason?.includes('READ_ONLY') ? '项目已归档或放弃，配置只读。' : '本轮已开始或已登记对照，配置只读；已有版本、预算和记录保留。'
  return <form className="model-settings" aria-label="项目验收模型配置" onSubmit={event => void save(event)}>
    <header><div><h2>验收设计</h2><p>{name || '当前项目'} · 仅影响这个项目</p></div><button type="button" disabled={pending} onClick={() => void load()}>刷新</button></header>
    <p>新 GUI 项目默认由 B 在独立上下文中设计验收案例，沿用制作模型和项目预算。也可单独配置 B 的渠道、模型与额度，由平台执行检查。</p>
    {error && <p role="alert">{error}</p>}
    {data?.locked && <p role="status">{reason}</p>}
    {running && <p role="status">项目正在运行，暂不能修改配置。</p>}
    <fieldset disabled={locked}><legend>验收方式</legend>
      <label className="model-choice"><input type="radio" name="verification-mode" checked={!enabled} onChange={() => { setVariant('single'); setConsent(false); setMessage('') }} /><span><strong>仅使用制作模型 A</strong><small>沿用 A 完成制作与按需协作；这里不关闭子任务，平台执行验收。</small></span></label>
      <label className="model-choice"><input type="radio" name="verification-mode" checked={enabled} onChange={() => { setVariant('independent'); setConsent(false); setMessage('') }} /><span><strong>A＋B 独立验收设计</strong><small>B 只读确认需求与界面，设计关键业务案例；A 实现，平台裁决。</small></span></label>
      {enabled && <label>B 配置方式<select aria-label="B 配置方式" value={funding} onChange={event=>{setFunding(event.target.value as 'project'|'independent');setConsent(false);setMessage('')}}><option value="project">沿用制作模型与项目预算</option><option value="independent">单独配置渠道、模型与额度</option></select></label>}
      {enabled&&funding==='project'&&<p>B 只读取确认资料，在独立上下文中生成案例。调用计入项目共享额度，单次输出沿用制作配置。</p>}
      {enabled&&funding==='independent' && <div className="model-settings-fields">
        <label>B 的渠道<select aria-label="B 的渠道" value={channel} onChange={event => { edit(setChannel,event.target.value); setModel('') }}><option value="">选择已启用渠道</option>{data?.channels.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>B 的模型<select aria-label="B 的模型" value={model} onChange={event => edit(setModel,event.target.value)}><option value="">选择模型</option>{data?.channels.find(item => item.id === channel)?.models.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        {!data?.channels.length && <p>暂无可用渠道，请先在“模型渠道”中配置并启用。</p>}
        <p>B 必须与 A 使用不同模型，运行时核对。当前支持 GUI 关键案例，每批设计最多一次请求。</p>
        <label>B 独立设计预算（元，不含 A）<input aria-label="B 独立设计预算" type="number" min="0.000001" max="10000" step="any" value={cap} onChange={event => edit(setCap,event.target.value)} /></label>
        <details open={!data?.budget}><summary>计价与保守预留</summary><p>按供应商现行价格填写；平台未核对供应商余额。缓存输入按普通输入单价保守计入。</p>
          <div className="model-settings-grid">
            <label>上下文上限（token）<input aria-label="上下文上限" type="number" min="1" max="2000000" value={context} onChange={event => edit(setContext,event.target.value)} /></label>
            <label>输入单价（元／百万 token）<input aria-label="输入单价" type="number" min="0" step="any" value={inputPrice} onChange={event => edit(setInputPrice,event.target.value)} /></label>
            <label>输出单价（元／百万 token）<input aria-label="输出单价" type="number" min="0" step="any" value={outputPrice} onChange={event => edit(setOutputPrice,event.target.value)} /></label>
          </div><p>按当前任务最多 {data?.design_request_limit??1} 次独立设计请求，共用下列总预算；每次按完整上下文与最多4096输出token预留，预算不足会拒绝保存。</p>
        </details>
        <label className="model-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我确认上述计价，授权当前项目本轮 B 独立设计最多使用 {cap || '所填金额'} 元。保存不立即调用模型。</label>
      </div>}
    </fieldset>
    {data?.budget && <p>已保存的 B 预算：{data.budget.cap_rmb} 元 · 已计责任上界 {data.budget.accounted_upper_rmb} 元 · 剩余 {data.budget.remaining_rmb} 元</p>}
    {data?.budget_error && <p role="alert">{data.budget_error}</p>}
    {data && <p>预算准入：开工时检查 · 设计：{({not_prepared:'尚未准备',frozen:'已冻结',blocked:'受阻',disabled:'未启用'} as Record<string,string>)[data.design_status] ?? '记录待核对'}</p>}
    <footer><button type="submit" disabled={locked || !valid}>{pending ? '处理中…' : enabled ? funding==='project'?'保存 B 配置':'保存并授权 B 预算' : '保存仅 A 的验收配置'}</button><span>已有账本和失败记录保留。</span></footer>
    {message && <p role="status">{message}</p>}
  </form>
}
