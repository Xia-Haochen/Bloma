/** Normalize an unambiguous identifier alias, never infer an ID from prose or
 * discard a conflict. All remaining fields still pass the normal strict parser. */
export function canonicalFindingReference(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('QUALITY_FINDING_INVALID')
  const { requirement_id, ...row } = value as Record<string, unknown>
  if (requirement_id !== undefined) {
    if (typeof requirement_id !== 'string' || row.requirement !== undefined && row.requirement !== requirement_id) throw Error('QUALITY_REQUIREMENT_REFERENCE_CONFLICT')
    row.requirement = requirement_id
  }
  return row
}
