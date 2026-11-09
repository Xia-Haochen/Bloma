import { readVerificationReport } from './verification-report'
import { redactSoftwareOutput } from './process-manager'
import { serializeRedactedJson } from '../../shared/redacted-json'
import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { deliveryQualityBlock } from './delivery-qualification'
import { independentDesignVersion } from './independent-design'
import { qualityWorkQueue } from './quality-closeout'
import { applicableQualityLedger, qualityIdentity, qualityRulesVersion, readQualityLedger } from './quality-ledger'
import {testCorrectionView} from './test-corrections'

/** One read model for makers and engineering peers. The caller owns access;
 * reading findings cannot start a review, change a finding or issue approval. */
export function buildQualityFindingsTool(projectId: string, authorize: (ctx: ToolContext) => void, route?: () => string | undefined): AgentLoopTool {
  return {
    name: 'read_quality_findings',
    description: '只读当前必修/待复现问题及其实际依据；finding_id读取单条完整历史。读取不批准交付，也不把历史建议变成新需求。',
    input_schema: { type: 'object', additionalProperties: false, properties: { finding_id: { type: 'string' } } },
    execute: async (input, ctx) => {
      authorize(ctx)
      ctx.signal.throwIfAborted()
      if (input.finding_id !== undefined) {
        const finding = readQualityLedger(projectId).findings.find(row => row.id === input.finding_id)
        if (!finding) throw Error('QUALITY_FINDING_UNKNOWN')
        return { output: serializeRedactedJson({ finding },redactSoftwareOutput) }
      }
      // Ledger access is independent of execution admission. Never turn a broken
      // test/entry into a reason to hide the evidence needed to repair it.
      const ledger = applicableQualityLedger(projectId)
      let output: unknown
      try {
        const block = await deliveryQualityBlock(projectId, ctx.signal, route?.())
        const current = await qualityIdentity(projectId, ctx.signal)
        output = {...qualityWorkQueue(ledger, current, block, qualityRulesVersion(projectId), independentDesignVersion(projectId)),test_corrections:testCorrectionView(projectId)}
      } catch (error) {
        ctx.signal.throwIfAborted()
        let report: unknown, corrections: unknown
        try { report = readVerificationReport(projectId) } catch (failure) { report = {available:false,error:String(failure)} }
        try { corrections = testCorrectionView(projectId) } catch (failure) { corrections = {available:false,error:String(failure)} }
        output = {status:'needs_work',freshness:'current_identity_unavailable',usable_for_delivery:false,
          admission_error:String(error),findings:ledger.findings,reviews:ledger.reviews,
          finding_count:ledger.findings.length,verification_report:report,test_corrections:corrections,
          boundary:'原始版本与检查记录保留；当前执行身份无法建立，历史通过不能用于交付。'}
      }
      return { output: serializeRedactedJson(output,redactSoftwareOutput) }
    },
  }
}
