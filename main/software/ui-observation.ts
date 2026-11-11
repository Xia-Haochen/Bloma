import type { Page } from 'playwright'
import { redactSoftwareOutput } from './process-manager'
import { observeSemanticUi, type UiQuery } from './ui-semantics'

/** A diagnostic PNG is separate from business assertions or an explicitly
 * requested visual check. A missing PNG never becomes visual PASS evidence. */
export async function captureDiagnosticScreenshot(page: Page, path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try { await page.screenshot({ path, timeout: 10000 }); signal.throwIfAborted(); return { path, error: undefined } }
  catch (error) { signal.throwIfAborted(); return { path: undefined, error: redactSoftwareOutput(String(error)).slice(-2000) } }
}
/** Host-side, bounded DOM semantics. Legacy CSS hints remain for old sessions;
 * new callers prefer observation-scoped refs. Neither is acceptance evidence. */
export async function observeSoftwareUi(page: Page, query: UiQuery = {}) {
  await page.waitForFunction(() => document.readyState !== 'loading' && document.body !== null, undefined, { timeout: 10000 })
  return observeSemanticUi(page, query)
}
