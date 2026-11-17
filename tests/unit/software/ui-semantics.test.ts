import { existsSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { actSemanticUi, invalidateSoftwareUi, observeSemanticUi } from '../../../main/software/ui-semantics'
let browser: Browser, page: Page
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }) }) })
beforeEach(async () => { page = await browser.newPage(); await page.setContent(`<!doctype html><title>Semantic fixture</title><main aria-label="Editor"><label for="draft">Draft title</label><input id="draft" value="one"><label for="pwd">Password</label><input type="password" id="pwd" value="HIDDEN_CREDENTIAL"><button id="save">Save</button><input type="checkbox" id="enabled" aria-label="Enabled"><output id="count">0</output><section id="region" aria-label="Repeated rows"><button>Duplicate</button><button>Duplicate</button></section></main><canvas width="40" height="40"></canvas><div id="shadow"></div><script>document.querySelector('#save').onclick=()=>document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1);document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button aria-label="Shadow action">go</button>'</script>`) })
afterEach(async () => { await invalidateSoftwareUi(page); await page.close() })
afterAll(async () => { await browser?.close() })
const signal = () => new AbortController().signal
it('returns bounded hierarchical roles, accessible-label hints, state and redacted sensitive values without DOM writes', async () => {
  const before = await page.locator('body').innerHTML(), view = await observeSemanticUi(page)
  expect(view.nodes.find(node => node.selector === '#draft')).toMatchObject({ role: 'textbox', name: 'Draft title', value: 'one', parent: 0 })
  expect(view.nodes.find(node => node.selector === '#enabled')?.state.checked).toBe(false)
  expect(JSON.stringify(view)).not.toContain('HIDDEN_CREDENTIAL')
  expect(view.gaps.join(' ')).toContain('CANVAS'); expect(view.capabilities.shadow).toContain('open')
  expect(await page.locator('body').innerHTML()).toBe(before)
})
it('queries open shadow controls and actions target exact element handles, not the first duplicate', async () => {
  const view = await observeSemanticUi(page, { role: 'button', name: 'Duplicate' })
  expect(view.total).toBe(2); expect(view.nodes[0].ref).not.toBe(view.nodes[1].ref)
  await page.locator('#region button').nth(1).evaluate(element => element.addEventListener('click', () => { element.textContent = 'second only' }))
  // Listener addition does not alter DOM; it should not invalidate the snapshot.
  await actSemanticUi(page, { ref: view.nodes[1].ref, kind: 'click' }, signal())
  expect(await page.locator('#region button').nth(0).innerText()).toBe('Duplicate')
  expect(await page.locator('#region button').nth(1).innerText()).toBe('second only')
  const shadow = await observeSemanticUi(page, { role: 'button', name: 'Shadow action' })
  expect(shadow.total).toBe(1); await actSemanticUi(page, { ref: shadow.nodes[0].ref, kind: 'click' }, signal())
})
it('rejects changed/replaced controls, old observations and references from another page', async () => {
  let view = await observeSemanticUi(page, { name: 'Save' }), old = view.nodes[0].ref
  await page.locator('#save').evaluate(element => element.replaceWith(element.cloneNode(true)))
  await expect(actSemanticUi(page, { ref: old, kind: 'click' }, signal())).rejects.toThrow('UI_REF_STALE')
  view = await observeSemanticUi(page, { name: 'Save' }); old = view.nodes[0].ref
  await observeSemanticUi(page, { role: 'textbox' })
  await expect(actSemanticUi(page, { ref: old, kind: 'click' }, signal())).rejects.toThrow('UI_REF_STALE')
  const other = await browser.newPage()
  try { await other.setContent('<button>Save</button>'); await expect(actSemanticUi(other, { ref: old, kind: 'click' }, signal())).rejects.toThrow('UI_REF_STALE') } finally { await other.close() }
  expect(await page.locator('#count').innerText()).toBe('0')
})
it('rejects programmatic form-state and geometry changes even without attribute mutations', async () => {
  const view = await observeSemanticUi(page, { name: 'Enabled' })
  await page.locator('#enabled').evaluate(element => { (element as HTMLInputElement).checked = true })
  await expect(actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'click' }, signal())).rejects.toThrow('STALE')
  const next = await observeSemanticUi(page, { name: 'Save' }); await page.setViewportSize({ width: 700, height: 500 })
  await expect(actSemanticUi(page, { ref: next.nodes[0].ref, kind: 'click' }, signal())).rejects.toThrow('STALE')
})
it('supports scoped literal search and content/view-bound pagination without silently accepting ambiguous regions', async () => {
  const first = await observeSemanticUi(page, { role: 'button', limit: 1 })
  expect(first.nodes).toHaveLength(1); expect(first.next_cursor).toBeTruthy()
  const second = await observeSemanticUi(page, { role: 'button', limit: 1, cursor: first.next_cursor })
  expect(second.offset).toBe(1); expect(second.nodes[0].name).not.toBe(first.nodes[0].name)
  await page.locator('#save').evaluate(element => element.textContent = 'changed')
  await expect(observeSemanticUi(page, { role: 'button', cursor: second.next_cursor })).rejects.toThrow('UI_CURSOR_STALE')
  await expect(observeSemanticUi(page, { selector: 'button' })).rejects.toThrow('UI_REGION_AMBIGUOUS')
  const scoped = await observeSemanticUi(page, { selector: '#region', query: 'duplicate' }); expect(scoped.total).toBe(2)
})
it('observes iframe-owned controls and refuses stale references after frame removal', async () => {
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.srcdoc = '<button aria-label="Frame action">Frame</button>'; document.body.append(frame) })
  await expect.poll(() => page.frames().length).toBe(2)
  const view = await observeSemanticUi(page, { frame: 1, name: 'Frame action' }); expect(view.nodes[0]).toMatchObject({ frame: 1, role: 'button' })
  await page.locator('iframe').evaluate(frame => frame.remove())
  await expect(actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'click' }, signal())).rejects.toThrow()
})
it('bounds a long virtualized/current DOM list and reports scan gaps rather than claiming complete coverage', async () => {
  await page.evaluate(() => { const list = document.createElement('div'); for (let i = 0; i < 5000; i++) { const button = document.createElement('button'); button.textContent = 'Long row ' + i; list.append(button) }; document.body.append(list) })
  const view = await observeSemanticUi(page, { role: 'button', limit: 80 })
  expect(view.nodes.length).toBeLessThanOrEqual(80); expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(48000)
  expect(JSON.stringify(view).length).toBeLessThanOrEqual(16000); expect(view.gaps).toContain('FRAME_0_SCAN_LIMIT')
})
it('uses actual modal/disabled semantics, fill, select and cancellation without granting stale click authority', async () => {
  await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.innerHTML = '<button disabled>Blocked</button><input aria-label="Modal text"><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>'; document.body.append(dialog); dialog.showModal() })
  let view = await observeSemanticUi(page, { name: 'Blocked' })
  await expect(actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'click' }, signal())).rejects.toThrow('DISABLED')
  view = await observeSemanticUi(page, { name: 'Modal text' }); await actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'fill', value: 'real value' }, signal())
  expect(await page.getByRole('textbox', { name: 'Modal text' }).inputValue()).toBe('real value')
  view = await observeSemanticUi(page, { name: 'Choice' }); await actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'select', value: 'b' }, signal())
  expect(await page.getByRole('combobox').inputValue()).toBe('b')
  view = await observeSemanticUi(page, { name: 'Choice' }); const abort = new AbortController(); abort.abort()
  await expect(actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'select', value: 'a' }, abort.signal)).rejects.toThrow()
  expect(await page.getByRole('combobox').inputValue()).toBe('b')
})
it('cancels an input still waiting behind an overlay by closing only its owned page, reports unknown and never fires a late click', async () => {
  let receipts = 0
  await page.exposeFunction('clickReceipt', () => { receipts++ })
  await page.evaluate(() => {
    document.querySelector('#save')!.addEventListener('click', () => { void (window as unknown as { clickReceipt: () => Promise<void> }).clickReceipt() })
    const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white'; document.body.append(overlay)
  })
  const view = await observeSemanticUi(page, { role: 'button', name: 'Save' }), abort = new AbortController()
  const pending = actSemanticUi(page, { ref: view.nodes[0].ref, kind: 'click' }, abort.signal)
  const timer = setTimeout(() => abort.abort(), 100)
  try { await expect(pending).rejects.toThrow('UI_CONTROL_CANCELLED_OUTCOME_UNKNOWN') } finally { clearTimeout(timer) }
  expect(page.isClosed()).toBe(true); expect(receipts).toBe(0)
})
