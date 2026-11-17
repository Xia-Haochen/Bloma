/** Summarize only recognized host stop reasons. The complete record stays available. */
export function productionNotice(reason: string): string | undefined {
  const repeated = /^连续(\d+)次验证得到相同失败观察，尚无可见改善，已停止自动重试并保留现场：\s*/.exec(reason)
  if (repeated) {
    const headline = `连续 ${repeated[1]} 次验收得到相同的失败结果，已停止自动重试。进度已保留。`
    const payload = reason.slice(repeated[0].length)
    if (!payload.startsWith('{')) return headline
    try {
      const report = JSON.parse(payload)
      const evidence = report?.evidence
      const counts = evidence?.counts
      const numbers = [evidence?.case_count, counts?.passed, counts?.failed, counts?.unverified]
      const validCounts = numbers.every(value => Number.isSafeInteger(value) && value >= 0)
        && numbers[0] > 0 && numbers[0] === numbers[1] + numbers[2] + numbers[3]
      const failures: Array<{ status?: unknown; cases?: unknown }> = Array.isArray(evidence?.failure_distribution) ? evidence.failure_distribution : []
      const failedCases: unknown[] = failures.flatMap(group => group?.status === 'failed' && Array.isArray(group.cases) ? group.cases : [])
      const features = [...new Set(failedCases.flatMap(name => typeof name === 'string' ? name.match(/^F-\d+\b/) ?? [] : []))].slice(0, 4)
      const modelCheck = typeof report?.summary === 'string' && report.summary.includes('模型功能本机 HTTP 探针未通过')
      return [
        headline,
        validCounts && `最近一次验收共 ${evidence.case_count} 项，${counts.passed} 项通过、${counts.failed} 项失败、${counts.unverified} 项未验证。`,
        features.length > 0 && `未通过的用例涉及 ${features.join('、')}。`,
        modelCheck && 'AI 调用的本机检查也未通过。',
      ].filter(Boolean).join('\n\n')
    } catch {
      return headline
    }
  }
  const budget = /^(?:模型请求额度已到，宿主检查未通过，未再调用模型：|当前(?:费用预留不足以放行下一次调用|累计输出额度未放行调用|请求次数额度未放行调用)，宿主检查未通过，未再调用模型：|(?:HARNESS_(?:REQUEST|OUTPUT)_BUDGET_EXHAUSTED|REQUEST_BUDGET_EXHAUSTED|MONETARY_(?:BUDGET|OPERATION)_EXHAUSTED)\b)/.test(reason)
  if (!budget) return undefined
  const audio = reason.includes('ASR_CAPABILITY_PREPARATION_REQUIRED')
  return '本轮制作额度不足，任务已暂停。'
    + (audio ? '\n\n语音功能还未通过实际检查，运行所需的语音组件也需要准备。' : '')
    + '\n\n需要先调整制作额度，再继续处理未完成的工作。直接重试不会重置用量。'
}
