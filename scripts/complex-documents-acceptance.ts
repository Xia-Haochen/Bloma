import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { findProject } from '../main/project/project-service'
import { activeSoftwareRelease, prepareSoftwareRelease, verifyReleaseSource } from '../main/software/release-store'
import { launchSoftwareForUser } from '../main/software/user-launch'
import { stopSoftwareSession } from '../main/software/process-manager'
import { softwareEnvironment } from '../main/software/command-runtime'

export async function inspectDocuments(projectId: string, folder: string) {
  mkdirSync(folder, { recursive: true })
  const project = findProject(projectId), published = await activeSoftwareRelease(projectId), release = published ?? await prepareSoftwareRelease(projectId, project.root_path)
  const prefix = join(folder, `documents-${randomUUID()}`), fixtures = join(folder, 'source-fixtures')
  mkdirSync(join(fixtures, 'a'), { recursive: true }); mkdirSync(join(fixtures, 'b'), { recursive: true })
  const alpha = join(fixtures, 'a', '同名资料.txt'), beta = join(fixtures, 'b', '同名资料.txt')
  writeFileSync(alpha, 'ORBIT_ALPHA 网络基础：TCP连接需要握手。\n独立资料甲。')
  writeFileSync(beta, 'ORBIT_BETA 虚拟化基础：二级地址转换。\n独立资料乙。')
  for (const name of ['sample.pdf', 'sample.docx', 'broken.pdf']) cpSync(resolve('tests/fixtures/software-import', name), join(fixtures, name))
  const inputs = [alpha, beta, ...['sample.pdf', 'sample.docx', 'broken.pdf'].map(name => join(fixtures, name))]
  const fingerprint = (file: string) => ({ sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), mtime: statSync(file).mtimeMs })
  const before = inputs.map(fingerprint)
  const report: any = { release: release.id, delivery: published ? 'published' : 'unreleased_candidate', status: 'running', checks: [], page_errors: [] }
  let context: BrowserContext | undefined, page!: Page
  const start = async () => {
    context = await chromium.launchPersistentContext(join(folder, 'browser-profile'), { headless: true, env: softwareEnvironment(projectId), viewport: { width: 1440, height: 1000 },
      ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
    page = context.pages()[0] ?? await context.newPage(); page.on('pageerror', e => report.page_errors.push(e.message))
    const launched = await launchSoftwareForUser(projectId, project.root_path, release.launch, async url => { await page.goto(url, { waitUntil: 'domcontentloaded' }) })
    if (!launched.started) throw Error(launched.detail)
    await expect(page.locator('#open-import')).toBeVisible()
  }
  const cards = () => page.locator('#material-list .material-card')
  try {
    await start()
    for (const name of ['网络原理', '虚拟化']) {
      await page.locator('#new-course-name').fill(name); await page.locator('#new-course-create').click()
      await expect(page.locator('#course-list')).toContainText(name)
    }
    await page.locator('#open-import').click(); await page.locator('#import-course').selectOption({ label: '网络原理' })
    await page.locator('#import-files').setInputFiles(inputs)
    await expect(page.locator('#import-status')).toContainText('可导入 4 份', { timeout: 45000 })
    await expect(page.locator('#import-status')).toContainText('失败 1 份')
    report.import_preview = await page.locator('#staging-list').innerText()
    await page.locator('#import-commit').click(); await expect(page.locator('#stat-total')).toHaveText('4')
    await page.locator('#clear-filters').click(); await expect(cards()).toHaveCount(4)
    await expect(page.locator('.material-source .source-name').filter({ hasText: '同名资料.txt' })).toHaveCount(2)
    await cards().filter({ hasText: 'ORBIT_ALPHA' }).click()
    await page.locator('#detail-title').fill('网络课独立笔记'); await page.locator('#detail-title-save').click()
    await page.locator('#detail-tag-input').fill('验收重点'); await page.locator('#detail-tag-add').click()
    await expect(page.locator('#detail-tags')).toContainText('验收重点')
    await page.locator('#detail-notes').fill('独立验收笔记：TCP状态转换需要复习。'); await page.locator('#detail-notes-save').click()
    await page.locator('#detail-toggle-done').click(); await expect(page.locator('#detail-status-text')).toHaveText('已完成')
    await page.locator('#detail-close').click()
    await cards().filter({ hasText: 'ORBIT_BETA' }).click(); await page.locator('#detail-course').selectOption({ label: '虚拟化' })
    await page.locator('#detail-close').click()
    await page.locator('#course-list button').filter({ hasText: '虚拟化' }).click(); await expect(cards()).toHaveCount(1)
    await expect(cards()).toContainText('ORBIT_BETA')
    await page.locator('#clear-filters').click(); await page.locator('#tag-list button').filter({ hasText: '验收重点' }).click()
    await expect(cards()).toHaveCount(1); await expect(cards()).toContainText('网络课独立笔记')
    await page.locator('#clear-filters').click(); await page.locator('#status-filter').selectOption('done'); await expect(cards()).toHaveCount(1)
    await page.locator('#clear-filters').click()
    report.checks.push('真实混合文件导入、坏文件隔离、同名不同内容共存、课程/标签/完成筛选')
    for (const [text, source] of [['Frozen PDF contract text', 'sample.pdf'], ['Frozen Word contract text', 'sample.docx']]) {
      await page.locator('#search-input').fill(text); await expect(cards()).toHaveCount(1, { timeout: 15000 })
      await expect(cards()).toContainText(source); await cards().click()
      await expect(page.locator('#detail-text')).toContainText(text); await expect(page.locator('#detail-source')).toContainText(source)
      await page.locator('#detail-close').click()
    }
    await page.locator('#search-clear').click(); await expect(cards()).toHaveCount(4)
    await page.locator('#export-toggle').click(); const downloadPromise = page.waitForEvent('download'); await page.locator('#export-md').click()
    const download = await downloadPromise; await download.saveAs(prefix + '.md')
    const exported = readFileSync(prefix + '.md', 'utf8')
    if (!exported.includes('网络课独立笔记') || !exported.includes('TCP状态转换需要复习')) throw Error('EXPORTED_NOTES_MISSING')
    report.checks.push('PDF/Word正文关键词检索、原文与来源关联、导出包含改名和笔记')
    await context!.close(); context = undefined; await stopSoftwareSession(projectId, 'user-launch'); await start()
    await expect(page.locator('#stat-total')).toHaveText('4'); await page.locator('#clear-filters').click()
    await cards().filter({ hasText: '网络课独立笔记' }).click()
    await expect(page.locator('#detail-notes')).toHaveValue('独立验收笔记：TCP状态转换需要复习。')
    await expect(page.locator('#detail-tags')).toContainText('验收重点'); await expect(page.locator('#detail-status-text')).toHaveText('已完成')
    await page.locator('#detail-close').click()
    if (JSON.stringify(inputs.map(fingerprint)) !== JSON.stringify(before)) throw Error('ORIGINAL_FILES_CHANGED')
    await verifyReleaseSource(release)
    report.checks.push('关闭后端与浏览器重开保留资料、笔记、标签、状态，所有原始文件哈希和修改时间不变')
    await page.screenshot({ path: prefix + '.png', fullPage: true })
    if (report.page_errors.length) throw Error('PRODUCT_PAGE_ERRORS')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = String(error)
    if (context && page) { report.visible_text = await page.locator('body').innerText().catch(() => 'unavailable'); await page.screenshot({ path: prefix + '-failure.png', fullPage: true }).catch(() => {}) }
  } finally {
    await context?.close(); await stopSoftwareSession(projectId, 'user-launch')
    report.finished_at = new Date().toISOString(); writeFileSync(prefix + '.json', JSON.stringify(report, null, 2))
  }
  return { status: report.status, report: prefix + '.json', checks: report.checks, error: report.error }
}
