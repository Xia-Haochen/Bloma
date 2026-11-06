import { blockingEngineeringReview } from './engineering-design'
export interface DeliveryBlock { code: 'apply_correction'|'correction_review'|'independent'|'investigation'|'defects'|'code_review'|'engineering'|'intent'|'visual_route'|'visual_review'; message:string }
const blocked=(code:DeliveryBlock['code'],message:string):DeliveryBlock=>({code,message})
import { testCorrectionGate } from './test-corrections'
import { readIndependentPolicy, readIndependentDesign, independentDesignVersion } from './independent-design'
import { currentIndependentSemantics } from './independent-quality'
import { qualityIdentity as identity, qualityRulesVersion as rulesVersion, applicableQualityLedger, completedQualityReview, sameIdentity as same } from './quality-ledger'
import { selectQualityCollaboration } from './collaboration-selection'
import { importantFinding, findingNeedsInvestigation, findingNeedsClosure } from './quality-closeout'
import { validateVisualGrant } from './visual-review-material'
import { visualCoverageComplete } from './visual-review-checklist'

export async function deliveryQualityBlock(projectId: string, signal?: AbortSignal, activeRoute?: string): Promise<DeliveryBlock | undefined> {
    const correction=testCorrectionGate(projectId);if(correction)return blocked(correction==='TEST_CORRECTION_APPLY_REQUIRED'?'apply_correction':'correction_review', correction+': 先处理read_test_contract返回的裁定或已批准修改，再重新验证；批准不等于通过。')
    const design=readIndependentPolicy(projectId)?.enabled?readIndependentDesign(projectId):undefined
    if(design?.contract){const semantics=currentIndependentSemantics(projectId,design.contract);if(!semantics.ready)return blocked('independent', `QUALITY_INDEPENDENT_SEMANTICS_UNRESOLVED: B预期或覆盖争议尚待澄清，不能改目标或断言过关：${JSON.stringify(semantics)}`)}
    const current = await identity(projectId, signal), ledger = applicableQualityLedger(projectId)
    const selection = await selectQualityCollaboration(projectId,current,signal)
    const investigations = ledger.findings.filter(f => importantFinding(f) && findingNeedsInvestigation(f,current,rulesVersion(projectId),independentDesignVersion(projectId)))
    if (investigations.length) return blocked('investigation', 'QUALITY_FINDING_REPRODUCTION_REQUIRED: 重要疑点尚无当前候选的实际案例结果。' + JSON.stringify(investigations.map(f => f.id)))
    const open = ledger.findings.filter(f => findingNeedsClosure(f,current,rulesVersion(projectId),independentDesignVersion(projectId)))
    if (open.length) return blocked('defects', 'QUALITY_FINDINGS_OPEN: 先复测已确认缺陷，再重新审阅。' + JSON.stringify(open.map(f => f.id)))
    const latest = completedQualityReview(ledger,'code',current)
    if (blockingEngineeringReview(latest?.engineering)) return blocked('engineering', 'QUALITY_ENGINEERING_UNRESOLVED: ' + JSON.stringify(latest?.engineering))
    if (selection.required.includes('code') && !latest) return blocked('code_review', 'QUALITY_REVIEW_REQUIRED: 当前候选尚无所需的有效结构化C审阅；用start_quality_review，等待并处理台账。')
    const unresolvedIntent = (['code', 'visual'] as const).flatMap(kind => { const r = ledger.reviews.filter(r => (r.kind ?? 'code') === kind).at(-1); return r && same(r.identity, current) && r.status === 'complete' ? [r] : [] }).flatMap(r => r.intent_observations ?? []).filter(o => o.status === 'unverified' || o.status === 'concern' && (!o.finding_ids?.length || o.finding_ids.some(id => { const f = ledger.findings.find(f => f.id === id); return !f || !['closed','not_reproduced'].includes(f.disposition) || f.checks.at(-1)?.outcome !== 'passed' || !same(f.checks.at(-1)!.identity, current) || f.checks.at(-1)!.rules !== (f.independent ? independentDesignVersion(projectId) : rulesVersion(projectId)) })))
    if (unresolvedIntent.length) return blocked('intent', 'QUALITY_INTENT_UNRESOLVED: 核心体验仍有未验证或未闭合观察，先核对实际旅程和对应finding，不以通用界面替代：' + JSON.stringify(unresolvedIntent))
    if (selection.required.includes('visual')) {
      const visual = ledger.reviews.filter(r => r.kind === 'visual').at(-1)
      if (visual?.visual_error === 'MODEL_IMAGE_INPUT_UNSUPPORTED' && visual.visual_route === activeRoute) return blocked('visual_route', 'QUALITY_VISUAL_MODEL_UNSUPPORTED: 当前模型已实际拒绝图片输入，V仍未验证；请更换支持图片的当前制作路由后继续，不能改用文字或自动重试同一路由。')
      if (visual?.status === 'complete' && same(visual.identity, current) && visual.visual && visual.image && visual.child && visual.visual_delivery?.image_hash === visual.visual.image_hash && visualCoverageComplete(visual.visual_observations)) {
        try { validateVisualGrant(visual.visual, visual.child, visual.image); return } catch { /* recapture; old evidence never passes */ }
      }
      return blocked('visual_review', 'QUALITY_VISUAL_REVIEW_REQUIRED: 当前界面候选尚无有效V图片审阅；用start_visual_review，不能用DOM或文件名冒充看图。')
    }
}

/** Text facade for operator messages; routing consumes DeliveryBlock instead. */
export async function deliveryQualityGate(projectId:string,signal?:AbortSignal,activeRoute?:string){return (await deliveryQualityBlock(projectId,signal,activeRoute))?.message}
