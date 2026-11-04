/** Summarize only recognized host stop reasons. The complete record stays available. */
export function productionNotice(reason: string): string | undefined {
  const budget = /^(?:模型请求额度已到，宿主检查未通过，未再调用模型：|当前(?:费用预留不足以放行下一次调用|累计输出额度未放行调用|请求次数额度未放行调用)，宿主检查未通过，未再调用模型：|(?:HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED|REQUEST_BUDGET_EXHAUSTED|MONETARY_(?:BUDGET|OPERATION)_EXHAUSTED)\b)/.test(reason)
  if (!budget) return undefined
  const audio = reason.includes('ASR_CAPABILITY_PREPARATION_REQUIRED')
  return '本轮制作额度不足，任务已暂停。'
    + (audio ? '\n\n语音功能还未通过实际检查，运行所需的语音组件也需要准备。' : '')
    + '\n\n需要先调整制作额度，再继续处理未完成的工作。直接重试不会重置用量。'
}
