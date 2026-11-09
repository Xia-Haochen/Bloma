import {chromium, type Page} from 'playwright'
import { expect, it, vi } from 'vitest'
import { observeSoftwareUi, captureDiagnosticScreenshot } from '../../../main/software/ui-observation'

it('records diagnostic screenshot failure without inventing an image or losing user cancellation', async () => {
  const screenshot = vi.fn(async () => { throw Error('font wait timeout api_key=PRIVATE_KEY') })
  const result = await captureDiagnosticScreenshot({ screenshot } as unknown as Page, '/owned/evidence.png', new AbortController().signal)
  expect(result.path).toBeUndefined(); expect(result.error).toContain('font wait timeout'); expect(result.error).not.toContain('PRIVATE_KEY')
  expect(screenshot).toHaveBeenCalledWith({ path: '/owned/evidence.png', timeout: 10000 })
  const controller = new AbortController(), reason = Error('explicit cancellation')
  const cancelled = { screenshot: async () => { controller.abort(reason); throw Error('capture aborted') } } as unknown as Page
  await expect(captureDiagnosticScreenshot(cancelled, '/owned/evidence.png', controller.signal)).rejects.toBe(reason)
})

it('waits for the owned document body before observing instead of inventing an empty successful snapshot',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await page.setContent('<title>owned</title><body>initial</body>')
  await page.evaluate(()=>{document.body.remove();setTimeout(()=>{const body=document.createElement('body');body.textContent='ready body';document.documentElement.append(body)},150)})
  expect((await observeSoftwareUi(page)).text).toContain('ready body')
 }finally{await browser.close()}
})
