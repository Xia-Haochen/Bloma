import { describe, expect, it } from 'vitest'
import { requirementCapabilities } from '../../main/model/requirement-capabilities'
import { deriveAiCapabilities, type PrdBackplane } from '../../main/model/prd-backplane'
import { requirementEvidenceHash } from '../../main/project/requirement-contract'
import { parseOrganizedRequirements } from '../../main/model/requirements-model'
import { organizedPrd } from '../support/organized-prd'
import { parseLeanBrief } from '../../main/guide/lean-brief'
import { independentCategoryRequested } from '../../main/software/independent-semantics'

describe('confirmed verification capabilities', () => {
  it('only schedules additional independent scenarios declared on the confirmed feature', () => {
    const initial = { project_id: 'p', requirements: [], acceptance: {} } as unknown as PrdBackplane
    const brief = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '说明和录入', ui: 'required', requirements: [
      { description: '使用说明中介绍录音、取消和重开', expected: '文档中看得到说明' },
      { description: '支持录入和继续使用', expected: '实际采集成功，重新打开后保留记录',
        capabilities: ['microphone'], acceptance_scenarios: ['reopen'] },
    ] }), { projectId: 'p', sessionId: 's', source: '说明和录入', previous: initial, software: true })
    if (brief?.action !== 'brief') throw Error('fixture')
    const [help, capture] = brief.brief.requirements
    expect([...requirementCapabilities(help)]).toEqual([])
    expect(independentCategoryRequested(brief.brief, help.id, 'cancel')).toBe(false)
    expect(independentCategoryRequested(brief.brief, help.id, 'reopen')).toBe(false)
    expect(independentCategoryRequested(brief.brief, help.id, 'normal')).toBe(true)
    expect(requirementCapabilities(capture).has('microphone')).toBe(true)
    expect(independentCategoryRequested(brief.brief, capture.id, 'reopen')).toBe(true)
    expect(requirementEvidenceHash(brief.brief, capture)).not.toBe(
      requirementEvidenceHash(brief.brief, { ...capture, acceptance_scenarios: undefined }))
  })
  it('does not turn ordinary organization, negated requirements or contact renaming into provider/filesystem work', () => {
    for (const description of ['按日期整理本地文件', '不需要语音识别', '不需要真实模型调用', '联系人按编号前缀筛选并支持给联系人改名']) {
      expect([...requirementCapabilities({ id: 'F-001', description })], description).toEqual([])
      expect(deriveAiCapabilities([{ id: 'F-001', description }])).toBeUndefined()
    }
  })
  it('uses explicit declarations and required implications instead of vocabulary guesses', () => {
    expect([...requirementCapabilities({ id: 'F-001', description: '语音模型简介', capabilities: [] })]).toEqual([])
    expect(requirementCapabilities({ id: 'F-001', description: '通过硬件输入', capabilities: ['microphone'] }).has('speech')).toBe(true)
    expect(requirementCapabilities({ id: 'F-001', description: '用模型整理转写文字' }).has('llm')).toBe(false)
    expect(requirementCapabilities({ id: 'F-001', description: '使用说明介绍麦克风录音' }).has('microphone')).toBe(false)
    expect(requirementCapabilities({ id: 'F-001', description: '撤销刚才的文件操作', capabilities: ['rename_undo'] }).has('prefix_rename')).toBe(true)
    expect(() => requirementCapabilities({ id: 'F-001', description: '旧文档', capabilities: ['invented'] as never })).toThrow('INVALID_REQUIREMENT_CAPABILITIES')
  })
  it('invalidates verification when confirmed capabilities change, without changing legacy versions for absent metadata', () => {
    const item = { id: 'F-001', description: '处理输入' }
    const bp = { requirements: [item] } as PrdBackplane
    const original = requirementEvidenceHash(bp, item)
    expect(requirementEvidenceHash(bp, { ...item, capabilities: undefined })).toBe(original)
    expect(requirementEvidenceHash(bp, { ...item, capabilities: [] })).not.toBe(original)
    expect(requirementEvidenceHash(bp, { ...item, capabilities: ['llm'] })).not.toBe(requirementEvidenceHash(bp, { ...item, capabilities: [] }))
  })
  it('preserves capability declarations in structured PRD parsing and rejects unknown adapters', () => {
    const raw = organizedPrd([{ id: 'F-001', description: '本地管理', capabilities: [] }], '本地管理')
    expect(parseOrganizedRequirements(raw, raw.requirements_model.sources)?.requirements[0].capabilities).toEqual([])
    raw.requirements[0].capabilities = ['invented'] as never
    expect(parseOrganizedRequirements(raw, raw.requirements_model.sources)).toBeUndefined()
  })
  it('does not carry an old adapter declaration across a normalized behavior revision', () => {
    const previous={project_id:'p',name:'测试',positioning:'模型增强',requirements:[{id:'F-002',description:'模型增强',capabilities:['llm']}],acceptance:{'F-002':'生成增强结果'},assumptions:[],out_of_scope:[]} as PrdBackplane
    const revised=parseLeanBrief(JSON.stringify({action:'brief',goal:'整理文件',ui:'none',requirements:[{id:'F-002',description:'按日期整理文件',expected:'文件按日期显示'}]}),{projectId:'p',sessionId:'s',source:'整理文件',previous,software:true})
    expect(revised?.action).toBe('brief')
    if(revised?.action==='brief'){
      expect(revised.brief.requirements[0].capabilities).toBeUndefined()
      expect([...requirementCapabilities(revised.brief.requirements[0])]).toEqual([])
    }
  })
})
