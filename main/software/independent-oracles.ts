export const DERIVED_OPERATIONS = ['sum_decimal', 'count_inputs', 'sorted_unique'] as const
export type DerivedOperation = typeof DERIVED_OPERATIONS[number]

/** Closed deterministic operators only. Never eval expressions from a model. */
export function deriveExpected(operation: DerivedOperation, values: string[]): string {
  if (!values.length || values.length > 32 || values.some(v => typeof v !== 'string' || v.length > 2000)) throw Error('ORACLE_INPUT_INVALID')
  if (operation === 'count_inputs') return String(values.length)
  if (operation === 'sorted_unique') return [...new Set(values)].sort().join('\n')
  if (operation !== 'sum_decimal') throw Error('ORACLE_OPERATION_UNSUPPORTED')
  let total = 0n
  for (const value of values) {
    if (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(value)) throw Error('ORACLE_DECIMAL_INVALID')
    const [integer, fraction = ''] = value.replace(/^-/, '').split('.')
    total += (BigInt(integer) * 1000000n + BigInt(fraction.padEnd(6, '0'))) * (value.startsWith('-') ? -1n : 1n)
  }
  const magnitude = total < 0n ? -total : total
  const fraction = String(magnitude % 1000000n).padStart(6, '0').replace(/0+$/, '')
  return `${total < 0n ? '-' : ''}${magnitude / 1000000n}${fraction ? '.' + fraction : ''}`
}
