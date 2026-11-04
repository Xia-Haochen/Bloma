import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { organizedPrd } from '../../support/organized-prd'
import { createProject, updateProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdStructureIssues } from '../../../main/model/requirements-model'
import { intentSources } from '../../../main/model/personal-intent'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { leanScopeDecision } from '../../../main/guide/lean-scope'
import { productionContext } from '../../../main/desktop/production-context'
import { renderSoftwareWorkingContext } from '../../../main/software/working-context'
import { generateUxSketch } from '../../../main/guide/ux-sketch'
import { importAttachment } from '../../../main/platform/attachments/composer-store'

let home: string, old: string | undefined, project: ReturnType<typeof createProject>
const source = '让我的收藏开辩论会，但纪念品不能被建议丢弃；改名后也要保留这个例外。'
beforeEach(() => { old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-intent-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'r', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true }) })
function fixture() {
  const data = organizedPrd([{ id: 'F-001', description: '收藏辩论和纪念品例外' }], source)
  data.requirements_model.rules = [{ id: 'BR-001', statement: '纪念品豁免绑定对象身份，改名后仍有效', source_ids: ['S-001'], feature_ids: ['F-001'], origin: 'user' }]
  data.requirements_model.scenarios[0].rule_ids = ['BR-001']
  data.requirements_model.experience = { summary: '收藏以不同立场辩论', commitments: [{ id: 'EXP-001', statement: '收藏以不同立场辩论',
    source_ids: ['S-001'], feature_ids: ['F-001'], scenario_ids: ['AC-001'], unacceptable_substitute: '只列清单并加聊天框' }] }
  return { ...data, action: 'brief', goal: source, ui: 'required', requirements: [{ description: data.requirements[0].description, expected: source }] }
}
function parse(data = fixture(), previous = readPrdBackplane(project.project_id), assets?: Parameters<typeof parseLeanBrief>[1]['assets']) {
  return parseLeanBrief(JSON.stringify(data), { projectId: project.project_id, sessionId: 'intent', source, previous, software: true, assets })
}
it('retains core experience and exceptions through persistence, confirmation, production and recovery', () => {
  const result = parse(); if (result?.action !== 'brief') throw Error('fixture')
  expect(prdStructureIssues(result.brief)).toEqual([])
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 'intent', checkpoint: 'requirement_confirmed' }, result.brief)
  markPrdUserConfirmed(project.project_id); updateProject(project.project_id, { last_session_id: 'intent' })
  const saved = readPrdBackplane(project.project_id)
  for (const view of [leanScopeDecision(saved), productionContext(saved, 'features'), renderSoftwareWorkingContext(project.project_id)]) {
    expect(JSON.stringify(view)).toContain('只列清单并加聊天框'); expect(JSON.stringify(view)).toContain('改名后仍有效')
  }
  const before = prdScopeFingerprint(saved)
  saved.requirements_model!.experience!.commitments[0].unacceptable_substitute = '仅改标题也不行'
  expect(prdScopeFingerprint(saved)).not.toBe(before)
})
it('host supplies source text; forged references and missing prior model cannot pass', () => {
  const data = fixture(); data.requirements_model.sources[0].text = '模型伪造的用户授权'
  const result = parse(data); if (result?.action !== 'brief') throw Error('fixture')
  expect(result.brief.requirements_model!.sources[0].text).toBe(source)
  const missing = { ...data }; delete (missing as { requirements_model?: unknown }).requirements_model
  expect(parse(missing, result.brief)).toBeUndefined()
  data.requirements_model.experience!.commitments[0].source_ids = ['S-999']
  expect(parse(data)).toBeUndefined()
  expect(intentSources(source + '\n\n只在今天温柔说话', result.brief.requirements_model!.sources).map(s => s.id)).toEqual(['S-001', 'S-002'])
})
it('binds a real reference attachment to the sketch request and rejects wrong ownership or missing bytes', async () => {
  const info = importAttachment({ request_id: 'img', project_id: project.project_id, session_id: 'intent', draft_id: 'draft', name: 'reference.png', media_type: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=' })
  const data = { ...fixture(), design_assets: [{ attachment_id: info.attachment_id, role: 'style_reference', usage: '参考色调', transformations: '不作为背景图片' }] }
  const result = parse(data, undefined, [info]); if (result?.action !== 'brief') throw Error('fixture')
  expect(result.brief.lean_brief?.design_assets?.[0].sha256).toBe(info.sha256)
  let seen = false
  const options = { project_id: project.project_id, session_id: 'intent', backplane: result.brief, positioning: source, requirements: result.brief.requirements, env: {}, maxTokens: 2048,
    materials: { project_id: project.project_id, owner_session_id: 'intent', attachments: [info] },
    query: (async function* (_prompt: string, options: { images?: unknown[] }) { seen = true; expect(options.images).toHaveLength(1)
      yield { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: '<!DOCTYPE html><html><body>收藏辩论</body></html>' }] } }
      yield { type: 'result' as const, subtype: 'success' as const } }) }
  await generateUxSketch(options); expect(seen).toBe(true)
  await expect(generateUxSketch({ ...options, materials: undefined })).rejects.toThrow('UNAVAILABLE')
  await expect(generateUxSketch({ ...options, materials: { ...options.materials, owner_session_id: 'other' } })).rejects.toThrow('OWNER')
})
