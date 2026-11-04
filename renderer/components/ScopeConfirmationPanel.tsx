import React from 'react'
import type { LeanScopeView } from '../../shared/types'
import { CardOptions, type CardOption } from './CardOptions'
import '../styles/scope-confirmation.css'

export const ScopeConfirmationPanel: React.FC<{ scope?: LeanScopeView; summary?: string; options: CardOption[]; onSelect: (option: CardOption) => void; busy: boolean }> = ({ scope, summary, options, onSelect, busy }) => {
  const selectionKey = JSON.stringify([scope, options.map(option => option.id)])
  const [selection, setSelection] = React.useState<{ key: string; ids: string[] }>({ key: '', ids: [] })
  const selected = selection.key === selectionKey ? selection.ids : []
  const headingId = React.useId()
  const choices = options.map(option => option.id.startsWith('lean_confirm:') && selected.length ? {
    ...option, id: option.id.replace('lean_confirm:', 'lean_adopt:'), label: `采纳 ${selected.length} 条建议，更新任务单`,
    description: '更新后再核对确认', selectedSuggestionIds: selected,
  } : option)
  return (
  <section className="scope-confirmation" aria-label="需求确认">
    <header><span>需求已整理</span><h2>这次要做的软件</h2><p>看看功能和范围是否符合你的想法。有遗漏可以补充，确认后就按这份做。</p></header>
    <div className="scope-confirmation-content">
      {scope ? <><p className="scope-goal">{scope.goal}</p><span className="scope-usage">{scope.usage}</span><h3>包含这些功能</h3>
        <ol>{scope.features.map(feature => <li key={feature.id}><strong>{feature.description}</strong>{feature.expected && <p>{feature.expected}</p>}</li>)}</ol>
        {scope.intent?.experience && <><h3>核心体验</h3><p>{scope.intent.experience.summary}</p><ul>{scope.intent.experience.commitments.map(c => <li key={c.id}>{c.statement}<p>不能替代为：{c.unacceptable_substitute}</p></li>)}</ul></>}
        {Boolean(scope.intent?.rules.length) && <><h3>关键规则与例外</h3><ul>{scope.intent!.rules.map(r => <li key={r.id}>{r.statement}</li>)}</ul></>}
        {Boolean(scope.design_assets?.length) && <><h3>素材用途</h3><ul>{scope.design_assets!.map(a => <li key={a.attachment_id}>{a.usage}（{{required_asset:'必须使用',style_reference:'风格参考',content:'业务内容'}[a.role]}；{a.transformations}）</li>)}</ul></>}
        {scope.constraints?.length > 0 && <><h3>需要遵守</h3><ul>{scope.constraints.map(text => <li key={text}>{text}</li>)}</ul></>}
        {scope.out_of_scope?.length > 0 && <><h3>这次先不做</h3><ul>{scope.out_of_scope.map(text => <li key={text}>{text}</li>)}</ul></>}
        {Boolean(scope.suggestions?.length) && <div className="scope-suggestions" role="group" aria-labelledby={headingId}>
          <h3 id={headingId}>AI 灵感建议</h3>
          <p>也可以考虑这些点子。不选就按原目标做；采纳后会更新上面的清单，再由你确认。</p>
          {scope.suggestions!.map(suggestion => <label className="scope-suggestion" key={suggestion.id}>
            <input type="checkbox" aria-label={suggestion.title} checked={selected.includes(suggestion.id)} disabled={busy}
              onChange={event => setSelection({ key: selectionKey, ids: event.target.checked ? [...selected, suggestion.id] : selected.filter(id => id !== suggestion.id) })} />
            <span><strong>{suggestion.title}</strong><span>{suggestion.description}</span><span>{suggestion.benefit}</span><span>采纳后：{suggestion.expected}</span></span>
          </label>)}
        </div>}
      </> : <p style={{ whiteSpace: 'pre-wrap' }}>{summary}</p>}
    </div>
    <footer><CardOptions options={choices} onSelect={onSelect} disabled={busy} /></footer>
  </section>
  )
}
