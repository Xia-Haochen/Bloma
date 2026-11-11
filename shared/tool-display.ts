/** Bounded host presentation, never verification or a second execution receipt. */
export interface ToolFileChange {
  path: string; after: string; before?: string; created: boolean; omitted: boolean
  line?: number; removed?: string; added?: string
}
export type ToolDisplay = { version: 1; kind: 'changes'; files: ToolFileChange[] }
  | { version: 1; kind: 'process'; id: string; state: string; exit_code?: number; preview: string; truncated: boolean; log_available: boolean; log_complete: boolean }
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
/** Reject malformed/oversized display instead of inventing facts from tool input. */
export function safeToolDisplay(raw: unknown): ToolDisplay | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (r.version !== 1) return undefined
  if (r.kind === 'changes' && Array.isArray(r.files) && r.files.length > 0 && r.files.length <= 8) {
    const files: ToolFileChange[] = []
    for (const value of r.files) {
      if (!value || typeof value !== 'object') return undefined
      const v = value as Record<string, unknown>
      if (typeof v.path !== 'string' || v.path.length > 500 || /(^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$))/i.test(v.path)
        || !hash(v.after) || v.before !== undefined && !hash(v.before) || typeof v.created !== 'boolean' || typeof v.omitted !== 'boolean') return undefined
      if ([v.removed,v.added].some(s=>s!==undefined && (typeof s!=='string'||s.length>1800)) || v.line!==undefined && (!Number.isSafeInteger(v.line)||Number(v.line)<1)) return undefined
      files.push({path:v.path,after:v.after,before:v.before as string|undefined,created:v.created,omitted:v.omitted,line:v.line as number|undefined,removed:v.removed as string|undefined,added:v.added as string|undefined})
    }
    const result: ToolDisplay = {version:1,kind:'changes',files}
    return JSON.stringify(result).length <= 12000 ? result : undefined
  }
  if (r.kind === 'process' && typeof r.id === 'string' && /^[a-z0-9-]{1,96}$/i.test(r.id)
    && typeof r.state === 'string' && ['starting','running','stopping','stopped','exited','failed','interrupted'].includes(r.state)
    && typeof r.preview === 'string' && r.preview.length <= 4000 && typeof r.truncated === 'boolean' && typeof r.log_available === 'boolean' && typeof r.log_complete === 'boolean'
    && (r.exit_code===undefined || Number.isSafeInteger(r.exit_code))) {
    return {version:1,kind:'process',id:r.id,state:r.state,exit_code:r.exit_code as number|undefined,preview:r.preview,truncated:r.truncated,log_available:r.log_available,log_complete:r.log_complete}
  }
  return undefined
}
