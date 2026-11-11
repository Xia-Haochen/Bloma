import { createHash, randomUUID } from 'node:crypto'
import type { ElementHandle, Frame, JSHandle, Page } from 'playwright'

export interface UiQuery { selector?: string; role?: string; name?: string; query?: string; frame?: number; cursor?: string; limit?: number }
export interface UiControl { ref: string; kind: 'click' | 'fill' | 'select' | 'press' | 'scroll'; value?: string; key?: string }
interface Row { role: string; name: string; depth: number; parent?: number; selector: string; has_text?: string; value?: string; state: Record<string, boolean | string>; index: number }
interface Scan { rows: Row[]; elements: Element[]; dirty: boolean; document: Document; visited: number; capped: boolean; canvas: number; dispose: () => void }
interface Capture { frame: Frame; handle: JSHandle<Scan>; rows: Row[]; frameIndex: number }
interface Held { id: string; captures: Capture[]; refs: Map<string, { capture: Capture; index: number; element: ElementHandle<Element> }>; signature: string }
const current = new WeakMap<Page, Held>()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const SOFTWARE_UI_CAPABILITIES = Object.freeze({
  semantics: 'bounded DOM-derived roles/names/states; not a complete accessibility-tree implementation',
  references: 'current observation only; document, mutation, geometry and element identity checked before input',
  queries: ['selector', 'role', 'name', 'query', 'frame', 'cursor'],
  actions: ['click', 'fill', 'select', 'press', 'scroll'],
  frames: 'owned page frames including cross-origin via Playwright; at most 16 frames',
  shadow: 'open shadow roots only', canvas: 'screenshot needed; drawn content has no semantic controls',
  virtual_lists: 'rendered nodes only; scroll then observe again', native_dialogs: 'not DOM; use the owned native adapter',
  runtime_update: 'restart normal declared entry and retain isolated data; not framework hot reload',
  max_visited_per_frame: 4000, max_depth: 32, max_returned: 80,
})
async function release(held?: Held) {
  if (!held) return
  await Promise.allSettled([...held.refs.values()].map(ref => ref.element.dispose()))
  await Promise.allSettled(held.captures.map(async capture => {
    await capture.handle.evaluate(value => value.dispose()).catch(() => {})
    await capture.handle.dispose()
  }))
}
export async function invalidateSoftwareUi(page: Page) { const held = current.get(page); current.delete(page); await release(held) }
function queryArgs(value: UiQuery) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('UI_QUERY_INVALID')
  for (const key of ['selector','role','name','query'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key]!.trim() || value[key]!.length > 512)) throw Error('UI_QUERY_INVALID')
  if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 80)) throw Error('UI_QUERY_LIMIT_INVALID')
  if (value.frame !== undefined && (!Number.isInteger(value.frame) || value.frame < 0 || value.frame > 15)) throw Error('UI_QUERY_FRAME_INVALID')
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 1000)) throw Error('UI_CURSOR_INVALID')
  return { selector: value.selector, role: value.role, name: value.name, query: value.query, frame: value.frame }
}
async function scan(frame: Frame, selector?: string) {
  return frame.evaluateHandle(({ selector }): Scan => {
    const roots = selector ? document.querySelectorAll(selector) : [document.body]
    if (roots.length !== 1 || !roots[0]) throw Error(roots.length ? 'UI_REGION_AMBIGUOUS' : 'UI_REGION_NOT_FOUND')
    const result: Scan = { rows: [], elements: [], dirty: false, document, visited: 0, capped: false, canvas: 0, dispose: () => {} }
    const observer = new MutationObserver(() => { result.dirty = true })
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    result.dispose = () => observer.disconnect()
    const nativeRole = (element: Element) => {
      const tag = element.tagName.toLowerCase()
      if (tag === 'input') return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button' } as Record<string, string>)[element.getAttribute('type') ?? ''] ?? 'textbox'
      return ({ button:'button', a: element.hasAttribute('href') ? 'link' : '', textarea:'textbox', select:'combobox', option:'option', h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading', dialog:'dialog', summary:'button', details:'group', nav:'navigation', main:'main', aside:'complementary', tr:'row', td:'cell', th:'columnheader', table:'table', ul:'list', ol:'list', li:'listitem', progress:'progressbar' } as Record<string,string>)[tag] ?? (element.hasAttribute('contenteditable') ? 'textbox' : element.hasAttribute('data-testid') ? 'generic' : '')
    }
    const walk = (element: Element, depth: number, parent?: number) => {
      if (++result.visited > 4000 || depth > 32) { result.capped = true; return }
      const style = getComputedStyle(element)
      const visible = element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.closest('[aria-hidden="true"]')
      if (visible && element.tagName.toLowerCase() === 'canvas') result.canvas++
      const role = (element.getAttribute('role')?.split(/\s+/)[0] || nativeRole(element)).slice(0,100)
      let nextParent = parent
      if (visible && role && role !== 'none' && role !== 'presentation') {
        const root = element.getRootNode() as Document | ShadowRoot
        const labelled = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).slice(0,8).map(id => id ? root.querySelector(`#${CSS.escape(id)}`)?.textContent?.slice(0,160) ?? '' : '').join(' ').trim()
        const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        const labels = field ? [...(element.labels ?? [])].slice(0,4).map(label => label.textContent?.slice(0,160) ?? '').join(' ').trim() : ''
        const text = (element as HTMLElement).innerText?.trim().slice(0,160) ?? ''
        const contentsName = ['button','link','heading','option','cell','columnheader','rowheader','tab','menuitem','checkbox','radio'].includes(role) ? text : ''
        const buttonValue = element instanceof HTMLInputElement && ['button','submit','reset'].includes(element.type) ? element.value : ''
        const name = (labelled || element.getAttribute('aria-label') || labels || element.getAttribute('placeholder') || element.getAttribute('title') || buttonValue || contentsName || element.id || role).slice(0,160)
        const sensitive = /password|secret|token|api.?key|\bkey\b|密钥|密码|令牌/i.test(`${element.id} ${element.getAttribute('name') ?? ''} ${element.getAttribute('type') ?? ''} ${name}`)
        const state: Row['state'] = { disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true', inert: Boolean(element.closest('[inert]')) }
        for (const key of ['checked','selected','expanded','pressed','invalid','readonly','required','modal']) if (element.hasAttribute(`aria-${key}`)) state[key] = element.getAttribute(`aria-${key}`)!.slice(0,80)
        if (element instanceof HTMLInputElement && ['checkbox','radio'].includes(element.type)) state.checked = element.checked
        if (element instanceof HTMLOptionElement) state.selected = element.selected
        if (element instanceof HTMLDialogElement) state.modal = element.matches(':modal')
        if (element instanceof HTMLDetailsElement) state.expanded = element.open
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) state.readonly = element.readOnly
        const tag = element.tagName.toLowerCase(), test = element.getAttribute('data-testid')
        const id = element.id.length <= 200 ? element.id : '', testId = test && test.length <= 200 ? test : ''
        const css = id ? `#${CSS.escape(id)}` : testId ? `[data-testid=${JSON.stringify(testId)}]` : tag
        const index = result.rows.length
        result.rows.push({ role, name, depth, parent, selector: css, ...(!id && !testId && text ? { has_text: text.slice(0,100) } : {}), state,
          ...(field ? { value: sensitive ? '[REDACTED]' : element.value.slice(0,200) } : {}), index })
        result.elements.push(element); nextParent = index
      }
      if (element.shadowRoot) {
        observer.observe(element.shadowRoot, { subtree: true, childList: true, attributes: true, characterData: true })
        for (let child = element.shadowRoot.firstElementChild; child && result.visited < 4000; child = child.nextElementSibling) walk(child, depth + 1, nextParent)
      }
      for (let child = element.firstElementChild; child && result.visited < 4000; child = child.nextElementSibling) walk(child, depth + 1, nextParent)
      if (result.visited >= 4000) result.capped = true
    }
    try { walk(roots[0], 0); return result } catch (error) { observer.disconnect(); throw error }
  }, { selector })
}
/** No business DOM writes or application-injected IDs. Handles stay on the host;
 * observers are disconnected on replacement/action/close. Never a PASS source. */
export async function observeSemanticUi(page: Page, query: UiQuery = {}) {
  const args = queryArgs(query), q = digest(args)
  if (query.cursor) {
    const prior = current.get(page)
    if (!prior) throw Error('UI_CURSOR_STALE: current observation no longer exists')
    for (const capture of prior.captures) if (!await capture.handle.evaluate(value => !value.dirty && value.document === document).catch(() => false)) throw Error('UI_CURSOR_STALE: view mutated')
  }
  await invalidateSoftwareUi(page)
  const held: Held = { id: randomUUID(), captures: [], refs: new Map(), signature: '' }
  const gaps: string[] = [], frames = page.frames()
  try {
    if (frames.length > 16) gaps.push('FRAME_LIMIT: frames after index 15 were not inspected')
    for (const [index, frame] of frames.slice(0,16).entries()) {
      if (args.frame !== undefined && args.frame !== index) continue
      try {
        const handle = await scan(frame, args.selector)
        const data = await handle.evaluate(value => ({ rows: value.rows, visited: value.visited, capped: value.capped, canvas: value.canvas,
          url: location.href, timeOrigin: performance.timeOrigin, geometry: [innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY] }))
        held.captures.push({ frame, frameIndex: index, handle, rows: data.rows })
        if (data.capped) gaps.push(`FRAME_${index}_SCAN_LIMIT`)
        if (data.canvas) gaps.push(`FRAME_${index}_CANVAS: ${data.canvas} drawn surfaces need visual review`)
      } catch (error) {
        if (index === 0 || args.frame === index) throw error
        gaps.push(`FRAME_${index}_UNAVAILABLE: ${String(error).slice(0,160)}`)
      }
    }
    if (!held.captures.length) throw Error('UI_FRAME_UNAVAILABLE')
    const identities = await Promise.all(held.captures.map(c => c.handle.evaluate(value => ({ rows: value.rows, url: location.href, origin: performance.timeOrigin, geometry: [innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY] }))))
    held.signature = digest(identities)
    let offset = 0
    if (query.cursor) {
      let cursor: { q: string; signature: string; offset: number }
      try { cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) } catch { throw Error('UI_CURSOR_INVALID') }
      if (cursor.q !== q || cursor.signature !== held.signature) throw Error('UI_CURSOR_STALE: observe the changed view again')
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw Error('UI_CURSOR_INVALID')
      offset = cursor.offset
    }
    const matching = held.captures.flatMap(c => c.rows.map(row => ({ row, capture: c }))).filter(({row}) =>
      (!args.role || row.role === args.role) && (!args.name || row.name.toLocaleLowerCase().includes(args.name.toLocaleLowerCase())) &&
      (!args.query || `${row.role} ${row.name}`.toLocaleLowerCase().includes(args.query.toLocaleLowerCase())))
    const selected = matching.slice(offset, offset + (query.limit ?? 32))
    const nodes: Array<Row & { ref: string; frame: number }> = []
    for (const { row, capture } of selected) {
      const value = await capture.handle.getProperty('elements'), handle = await value.getProperty(String(row.index)), element = handle.asElement() as ElementHandle<Element> | null
      await value.dispose()
      if (!element) { await handle.dispose(); throw Error('UI_ELEMENT_UNAVAILABLE') }
      const ref = `${held.id}:${capture.frameIndex}:${row.index}`
      held.refs.set(ref, { capture, index: row.index, element }); nodes.push({ ...row, ref, frame: capture.frameIndex })
    }
    const text = await page.locator('body').innerText({ timeout: 3000 }).then(text => text.slice(0,1600))
    const result = { snapshot_id: held.id, title: (await page.title()).slice(0,200), text, nodes,
      // Retain the old compact CSS hints for old sessions; refs are the safer new path.
      controls: nodes.filter(node => node.frame === 0).slice(0,40).map(({ selector, has_text, name, value }) => ({ selector, has_text, name, value })),
      total: matching.length, offset, next_cursor: undefined as string | undefined, gaps, capabilities: SOFTWARE_UI_CAPABILITIES }
    while ((JSON.stringify(result).length > 15000 || Buffer.byteLength(JSON.stringify(result)) > 45000) && nodes.length) {
      nodes.pop(); result.controls = nodes.filter(node => node.frame === 0).slice(0,40).map(({ selector, has_text, name, value }) => ({ selector, has_text, name, value }))
    }
    const keep = new Set(nodes.map(node => node.ref))
    for (const [ref, value] of held.refs) if (!keep.has(ref)) { await value.element.dispose(); held.refs.delete(ref) }
    if (offset + nodes.length < matching.length) result.next_cursor = Buffer.from(JSON.stringify({ q, signature: held.signature, offset: offset + nodes.length })).toString('base64url')
    current.set(page, held)
    return result
  } catch (error) { await release(held); throw error }
}
export async function actSemanticUi(page: Page, action: UiControl, signal: AbortSignal) {
  if (!action || typeof action.ref !== 'string' || action.ref.length > 160 || !SOFTWARE_UI_CAPABILITIES.actions.includes(action.kind)) throw Error('UI_CONTROL_INVALID')
  if (action.kind === 'fill' || action.kind === 'select') { if (typeof action.value !== 'string' || action.value.length > 4096) throw Error('UI_CONTROL_VALUE_REQUIRED') }
  if (action.kind === 'press' && (typeof action.key !== 'string' || !action.key || action.key.length > 128)) throw Error('UI_CONTROL_KEY_REQUIRED')
  signal.throwIfAborted()
  const held = current.get(page), target = held?.refs.get(action.ref)
  if (!held || !target || !action.ref.startsWith(`${held.id}:`)) throw Error('UI_REF_STALE: observe again')
  try {
    for (const c of held.captures) if (!await c.handle.evaluate(value => !value.dirty && value.document === document)) throw Error('UI_REF_STALE: view mutated; observe again')
    const identities = await Promise.all(held.captures.map(c => c.handle.evaluate(value => ({ rows: value.rows, url: location.href, origin: performance.timeOrigin, geometry: [innerWidth,innerHeight,devicePixelRatio,scrollX,scrollY] }))))
    if (digest(identities) !== held.signature) throw Error('UI_REF_STALE: geometry or route changed')
    const valid = await target.element.evaluate((element, row) => {
      if (!element.isConnected || element.ownerDocument !== document || !element.getClientRects().length) return false
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const sensitive = row.value === '[REDACTED]'
        if (!sensitive && element.value.slice(0,200) !== row.value) return false
        if (element instanceof HTMLInputElement && ['checkbox','radio'].includes(element.type) && element.checked !== row.state.checked) return false
      }
      return !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true' && !element.closest('[inert]')
    }, target.capture.rows[target.index])
    if (!valid) throw Error('UI_REF_STALE_OR_DISABLED')
    signal.throwIfAborted()
    // Playwright input APIs have no AbortSignal. Closing this owned page on
    // abort prevents an auto-waiting click from firing later; already dispatched
    // input cannot be undone and must never be automatically replayed.
    const abort = () => { void page.close({ runBeforeUnload: false }).catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const opts = { timeout: 4000 }
      if (action.kind === 'click') await target.element.click(opts)
      else if (action.kind === 'fill') await target.element.fill(action.value!, opts)
      else if (action.kind === 'select') await target.element.selectOption({ value: action.value! }, opts)
      else if (action.kind === 'press') await target.element.press(action.key!, opts)
      else await target.element.scrollIntoViewIfNeeded(opts)
      signal.throwIfAborted()
    } catch (error) {
      if (signal.aborted) throw Error('UI_CONTROL_CANCELLED_OUTCOME_UNKNOWN: owned page closed; inspect state before any new action, do not replay')
      throw error
    } finally { signal.removeEventListener('abort', abort) }
    return { ref: action.ref, kind: action.kind, execution: 'completed', verification: 'not_applicable' }
  } finally { await invalidateSoftwareUi(page) }
}
