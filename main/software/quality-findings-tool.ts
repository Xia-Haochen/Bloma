import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { deliveryQualityBlock } from './delivery-qualification'
import { independentDesignVersion } from './independent-design'
import { qualityWorkQueue } from './quality-closeout'
import { applicableQualityLedger, qualityIdentity, qualityRulesVersion, readQualityLedger } from './quality-ledger'

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
        return { output: JSON.stringify({ finding }) }
      }
      const block = await deliveryQualityBlock(projectId, ctx.signal, route?.())
      const current = await qualityIdentity(projectId, ctx.signal)
      return { output: JSON.stringify(qualityWorkQueue(applicableQualityLedger(projectId), current, block, qualityRulesVersion(projectId), independentDesignVersion(projectId))) }
    },
  }
}
