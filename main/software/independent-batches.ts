/** Keep each model response bounded; aggregate only complete, disjoint feature partitions. */
export function independentBatches(ids: string[]): string[][] {
  if (new Set(ids).size !== ids.length) throw Error('INDEPENDENT_BATCH_FEATURE_DUPLICATE')
  if (ids.length <= 12) return [[...ids]]
  if (ids.length > 192) throw Error('INDEPENDENT_BATCH_LIMIT: 先缩小独立验收设计范围')
  return Array.from({ length: Math.ceil(ids.length / 6) }, (_, i) => ids.slice(i * 6, i * 6 + 6))
}
