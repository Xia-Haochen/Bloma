import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { findProject } from '../main/project/project-service'
import { activeSoftwareRelease, prepareSoftwareRelease, verifyReleaseSource } from '../main/software/release-store'
import { launchSoftwareForUser } from '../main/software/user-launch'
import { stopSoftwareSession } from '../main/software/process-manager'
import { softwareEnvironment } from '../main/software/command-runtime'

/** Expectations come from the trial request. Selectors come from the observed product UI,
 * not its generated acceptance script. Uses the real user data/update path. */
export async function inspectPrimary(projectId: string, folder: string, regression = false) {
  mkdirSync(folder, { recursive: true })
  const project = findProject(projectId), published = await activeSoftwareRelease(projectId)
  const release = published ?? await prepareSoftwareRelease(projectId, project.root_path)
  const report: any = { version: 1, release: release.id, delivery: published ? 'published' : 'unreleased_candidate', kind: regression ? 'regression' : 'baseline', started_at: new Date().toISOString(), checks: [], status: 'running', page_errors: [] }
  const prefix = join(folder, `${report.kind}-${randomUUID()}`)
  let context: BrowserContext | undefined, page!: Page
  const start = async () => {
    context = await chromium.launchPersistentContext(join(folder, 'browser-profile'), { headless: true, env: softwareEnvironment(projectId), viewport: { width: 1366, height: 900 },
      ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
    page = context.pages()[0] ?? await context.newPage()
    page.on('pageerror', error => report.page_errors.push(error.message))
    const result = await launchSoftwareForUser(projectId, project.root_path, release.launch, async url => { await page.goto(url, { waitUntil: 'domcontentloaded' }) })
    if (!result.started) throw Error(result.detail)
    await expect(page.locator('#item-form')).toBeVisible()
  }
  const tab = async (name: string) => page.locator(`[data-tab="${name}"]`).click()
  const item = (name: string) => page.locator('#item-rows tr').filter({ hasText: name })
  const choose = async (selector: string, contains: string) => {
    const options = await page.locator(selector + ' option').allTextContents(), matches = options.filter(s => s.includes(contains))
    if (matches.length !== 1) throw Error(`AMBIGUOUS_OPTION:${selector}:${contains}`)
    await page.locator(selector).selectOption({ label: matches[0] })
  }
  try {
    await start()
    if (!regression) {
      await tab('activities')
      for (const [name, date] of [['验收招新甲', '2026-11-03'], ['验收志愿乙', '2026-12-01']]) {
        await page.locator('#activity-name').fill(name); await page.locator('#activity-date').fill(date)
        await page.locator('#activity-location').fill('活动中心'); await page.locator('#activity-owner').fill('验收负责人')
        await page.locator('#activity-save').click(); await expect(page.locator('#activity-rows')).toContainText(name)
      }
      await tab('items')
      for (const [name, total, repair] of [['验收帐篷', '8', '2'], ['验收椅子', '12', '0']]) {
        await page.locator('#item-name').fill(name); await page.locator('#item-total').fill(total); await page.locator('#item-repair').fill(repair)
        await page.locator('#item-save').click(); await expect(item(name)).toHaveCount(1)
      }
      await expect(item('验收帐篷').locator('td').nth(4)).toHaveText('6')
      await tab('loans'); await choose('#loan-item', '验收帐篷'); await choose('#loan-activity', '验收招新甲')
      await page.locator('#loan-qty').fill('4'); await page.locator('#loan-date').fill('2026-11-03'); await page.locator('#loan-save').click()
      await expect(page.locator('#loan-rows tr')).toHaveCount(1)
      await choose('#loan-item', '验收帐篷'); await choose('#loan-activity', '验收招新甲'); await page.locator('#loan-qty').fill('3'); await page.locator('#loan-save').click()
      await expect(page.locator('#loan-rows tr')).toHaveCount(1)
      await page.locator('#loan-rows .return-qty').fill('1'); await page.locator('#loan-rows .return-btn').click()
      await expect(page.locator('#loan-rows tr td').nth(3)).toHaveText('1')
      await tab('items'); await expect(item('验收帐篷').locator('td').nth(4)).toHaveText('3')
      await expect(item('验收椅子').locator('td').nth(4)).toHaveText('12')
      await item('验收帐篷').getByRole('button', { name: '编辑', exact: true }).click()
      await page.locator('#item-name').fill('验收帐篷改'); await page.locator('#item-save').click()
      await expect(item('验收帐篷改')).toHaveCount(1)
      report.checks.push('活动关联借用、维修不可占用、超量拒绝、分批归还、不同物品不串记录')
      await tab('expenses')
      for (const [title, amount, date, activity] of [['验收采购', '120.50', '2026-11-03', '验收招新甲'], ['验收交通', '30.00', '2026-11-04', '验收招新甲'], ['验收材料', '50.00', '2026-12-01', '验收志愿乙']]) {
        await page.locator('#expense-title').fill(title); await page.locator('#expense-amount').fill(amount); await page.locator('#expense-date').fill(date)
        await choose('#expense-activity', activity); await page.locator('#expense-save').click(); await expect(page.locator('#expense-rows')).toContainText(title)
      }
      await tab('summary'); await expect(page.locator('#summary-total')).toHaveText('200.50')
      await expect(page.locator('#summary-act-rows tr').filter({ hasText: '验收招新甲' })).toContainText('150.50')
      await expect(page.locator('#summary-month-rows tr').filter({ hasText: '2026-11' })).toContainText('150.50')
      await expect(page.locator('#summary-month-rows tr').filter({ hasText: '2026-12' })).toContainText('50.00')
      report.checks.push('活动和月份汇总与三笔真实支出一致')
      await tab('items')
      await page.locator('#import-file').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('名称,总量,维修数量\n验收音箱,2,0\n错误行,-1,0\n') })
      await page.locator('#import-preview-btn').click(); await expect(page.locator('#import-result')).toBeVisible(); await expect(page.locator('#import-commit')).toBeDisabled()
      await expect(page.locator('#item-rows tr')).toHaveCount(2)
      await page.locator('#import-file').setInputFiles({ name: 'valid.csv', mimeType: 'text/csv', buffer: Buffer.from('名称,总量,维修数量\n验收音箱,2,0\n验收灯具,4,0\n') })
      await page.locator('#import-preview-btn').click(); await expect(page.locator('#import-commit')).toBeEnabled(); await page.locator('#import-commit').click()
      await expect(page.locator('#item-rows tr')).toHaveCount(4)
      await page.locator('#item-search').fill('帐篷'); await expect(page.locator('#item-rows tr')).toHaveCount(1); await page.locator('#item-search-clear').click()
      await expect(page.locator('#item-rows tr')).toHaveCount(4)
      await tab('loans'); await expect(page.locator('#loan-rows')).toContainText('验收帐篷改')
      const downloadPromise = page.waitForEvent('download'); await page.locator('#export-ledger').click(); const download = await downloadPromise
      const exported = prefix + '.csv'; await download.saveAs(exported)
      const csv = readFileSync(exported, 'utf8'); if (!csv.includes('验收帐篷改') || !csv.includes('验收招新甲')) throw Error('EXPORTED_ASSOCIATIONS_MISSING')
      report.checks.push('CSV错误时不部分写入、有效文件完整导入、搜索清空、导出保留关联')
    }
    await tab('items'); await expect(page.locator('#item-rows tr')).toHaveCount(4)
    await expect(item('验收帐篷改').locator('td').nth(4)).toHaveText('3')
    await page.screenshot({ path: prefix + '-items.png', fullPage: true })
    await context!.close(); context = undefined; await stopSoftwareSession(projectId, 'user-launch')
    await start(); await expect(page.locator('#item-rows tr')).toHaveCount(4)
    await expect(item('验收帐篷改').locator('td').nth(4)).toHaveText('3')
    await tab('summary'); await expect(page.locator('#summary-total')).toHaveText('200.50')
    await tab('loans'); await expect(page.locator('#loan-rows')).toContainText('验收帐篷改')
    await expect(page.locator('#loan-rows tr td').nth(3)).toHaveText('1')
    report.checks.push('真实关闭浏览器和后端再启动，记录、数量、归还历史和汇总均保留')
    await page.screenshot({ path: prefix + '-reopened.png', fullPage: true })
    await verifyReleaseSource(release)
    if (published && (await activeSoftwareRelease(projectId))?.id !== release.id) throw Error('RELEASE_CHANGED_DURING_ACCEPTANCE')
    if (report.page_errors.length) throw Error('PRODUCT_PAGE_ERRORS')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = String(error)
    if (context && page) { report.visible_text = await page!.locator('body').innerText().catch(() => 'unavailable'); await page!.screenshot({ path: prefix + '-failure.png', fullPage: true }).catch(() => {}) }
  } finally {
    await context?.close(); await stopSoftwareSession(projectId, 'user-launch')
    report.finished_at = new Date().toISOString(); writeFileSync(prefix + '.json', JSON.stringify(report, null, 2))
  }
  return { report: prefix + '.json', status: report.status, checks: report.checks, error: report.error }
}
