import type { AttachmentInfo } from '../../shared/attachment-types'

import type { DesignAsset } from '../../shared/personal-intent-types'
export type { DesignAsset } from '../../shared/personal-intent-types'

export function bindDesignAssets(raw: unknown, available: Array<Pick<AttachmentInfo, 'attachment_id' | 'sha256'>>, previous: DesignAsset[] = []): DesignAsset[] | undefined {
  if (raw === undefined) return previous.length ? structuredClone(previous) : undefined
  if (!Array.isArray(raw) || raw.length > 32) throw Error('DESIGN_ASSETS_INVALID')
  const seen = new Set<string>()
  return raw.map(row => {
    if (!row || typeof row.attachment_id !== 'string' || seen.has(row.attachment_id)
      || !['required_asset','style_reference','content'].includes(row.role)
      || [row.usage, row.transformations].some(text => typeof text !== 'string' || !text.trim() || text.length > 2000)) throw Error('DESIGN_ASSET_INVALID')
    seen.add(row.attachment_id)
    const source = available.find(a => a.attachment_id === row.attachment_id) ?? previous.find(a => a.attachment_id === row.attachment_id)
    if (!source || row.sha256 !== undefined && row.sha256 !== source.sha256) throw Error('DESIGN_ASSET_SOURCE_INVALID')
    return { attachment_id: source.attachment_id, sha256: source.sha256, role: row.role, usage: row.usage, transformations: row.transformations }
  })
}
