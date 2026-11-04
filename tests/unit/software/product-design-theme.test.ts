import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { generateUxSketch } from '../../../main/guide/ux-sketch'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { productionContext } from '../../../main/desktop/production-context'
import { productDesignPolicy } from '../../../main/project/product-design-policy'
import { DEFAULT_PRODUCT_THEME, snapshotProductTheme, workspaceThemeVariables } from '../../../shared/product-design-theme'
import type { PrdBackplane } from '../../../main/model/prd-backplane'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-design-theme-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'theme', mode: 'quick' }, { workflowVersion: 'software-v1' })
})
afterEach(() => {
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  rmSync(home, { recursive: true, force: true })
})
function parse(previous = readPrdBackplane(project.project_id), extra: object = {}) {
  const result = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '记录', ui: 'required',
    requirements: [{ description: '保存', expected: '重开保留' }], constraints: ['黑白漫画风格，使用我的原图'], ...extra }),
    { previous, projectId: project.project_id, sessionId: 'theme', source: '记录', software: true })
  if (result?.action !== 'brief') throw Error('fixture')
  return result.brief
}
it('pins host defaults, ignores model-forged theme and preserves explicit style in all context views', () => {
  const brief = parse(undefined, { design_theme: { id: 'forged' } })
  expect(brief.lean_brief?.design_theme).toEqual(DEFAULT_PRODUCT_THEME)
  const policy = productDesignPolicy(brief)!
  expect(policy.priority[0]).toBe('explicit_user_style_and_assets')
  expect(policy.user_constraints).toContain('黑白漫画风格，使用我的原图')
  for (const topic of ['features', 'overview']) expect(productionContext(brief, topic)).toMatchObject({ design_policy: policy })
  expect(workspaceThemeVariables()['--color-primary']).toBe(policy.theme?.colors.primary)
})
it('keeps project palette snapshots on revision and binds them to confirmation scope', () => {
  const brief = parse(), old = snapshotProductTheme(); old.id = 'prior-brand'; old.colors.primary = '#123456'
  brief.lean_brief!.design_theme = old
  const revised = parse(brief)
  expect(revised.lean_brief?.design_theme).toEqual(old)
  const before = prdScopeFingerprint(revised)
  revised.lean_brief!.design_theme!.colors.primary = '#654321'
  expect(prdScopeFingerprint(revised)).not.toBe(before)
  expect(brief.lean_brief!.design_theme!.colors.primary).toBe('#123456')
})
it('preserves legacy design and leaves command-only projects without palette obligations', () => {
  const legacy = parse(); delete legacy.lean_brief!.design_theme
  expect(parse(legacy).lean_brief?.design_theme).toBeUndefined()
  expect(productDesignPolicy(parse(legacy))?.mode).toBe('legacy_preserve')
  const cli = parse(undefined, { ui: 'none', delivery: 'command' })
  expect(cli.lean_brief?.design_theme).toBeUndefined(); expect(productDesignPolicy(cli)).toBeUndefined()
  expect(() => snapshotProductTheme({ ...DEFAULT_PRODUCT_THEME, colors: {} })).toThrow('INVALID')
})
it('passes the pinned palette and user priority into the actual lean sketch request', async () => {
  const brief = parse(); let seen = 0
  const result = await generateUxSketch({ project_id: project.project_id, session_id: 'theme', backplane: brief,
    positioning: brief.positioning, requirements: brief.requirements, env: {}, maxTokens: 2048,
    query: async function* (prompt) {
      seen++; expect(prompt).toContain(DEFAULT_PRODUCT_THEME.id); expect(prompt).toContain('黑白漫画风格')
      expect(prompt).toContain('explicit_user_style_and_assets')
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<!DOCTYPE html><html><body>记录</body></html>' }] } }
      yield { type: 'result', subtype: 'success' }
    } })
  expect(seen).toBe(1); expect(result.source).toBe('llm')
})
