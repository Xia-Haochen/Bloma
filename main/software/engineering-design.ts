import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ENGINEERING_DESIGN_PATH = 'ARCHITECTURE.md'
export const ENGINEERING_GUIDANCE = '结合当前设计和实际实现，核对职责与依赖、状态归属、错误传播、资源生命周期、兼容和测试。设计入口不限定文件名，可通过仓库上下文查找。评价须引用具体实现与影响；不得把文件长度、文档格式或未来可能扩展当作严重缺陷。concern须给severity；只有有证据的high concern阻止交付，medium/low建议及unverified观察保留为后续工作。'

export function readEngineeringDesign(root: string): string | undefined {
  const file = join(root, ENGINEERING_DESIGN_PATH)
  let stat
  try { stat = lstatSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!stat.isFile() || stat.isSymbolicLink()) return '设计入口不是普通文件，未跟随链接；请核对当前工程的实际设计入口。'
  if (stat.size > 64 * 1024) return '设计文档未附正文：超过上下文摘要容量，请用 read_file 分段读取 ARCHITECTURE.md。大小本身不是质量判定。'
  return readFileSync(file, 'utf8').trim() || undefined
}

export interface EngineeringReview { status: 'supported' | 'concern' | 'unverified'; severity?: 'high' | 'medium' | 'low'; evidence: string; limitations: string }
export function parseEngineeringReview(value: unknown): EngineeringReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('ENGINEERING_REVIEW_REQUIRED')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['status', 'severity', 'evidence', 'limitations'].includes(key)) || !['supported', 'concern', 'unverified'].includes(String(row.status))
    || row.status === 'concern' && !['high','medium','low'].includes(String(row.severity))
    || row.severity !== undefined && !['high','medium','low'].includes(String(row.severity))
    || typeof row.evidence !== 'string' || !row.evidence.trim() || row.evidence.length > 8000 || typeof row.limitations !== 'string' || row.limitations.length > 4000) throw Error('ENGINEERING_REVIEW_INVALID')
  return row as unknown as EngineeringReview
}

export const ENGINEERING_REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['status', 'evidence', 'limitations'], properties: {
  status: { type: 'string', enum: ['supported', 'concern', 'unverified'] }, severity: {type:'string',enum:['high','medium','low'],description:'concern必填；只有具体影响当前交付的严重工程缺陷使用high，普通改进和未评估项不阻断。'}, evidence: { type: 'string', maxLength: 8000 }, limitations: { type: 'string', maxLength: 4000 },
} }

export const blockingEngineeringReview = (review?: EngineeringReview) => review?.status === 'concern' && review.severity === 'high'
