import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DesignAsset } from '../../shared/personal-intent-types'
import type { MaterialContext } from '../../shared/attachment-types'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { resolveAttachments } from '../platform/attachments/composer-store'
import { sessionMaterials } from '../platform/attachments/material-context'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
// Keep original bytes under content-addressed names. Product code may create its own
// authorized derivatives, but never replace the original or inherit an external path.
export function designAssetPath(asset: DesignAsset) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error('DESIGN_ASSET_HASH_INVALID')
  return `assets/user/${asset.sha256}.asset`
}
function safeTarget(root: string, relative: string, create: boolean) {
  let current = root
  for (const part of relative.split('/')) {
    current = join(current, part)
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (info?.isSymbolicLink()) throw Error('DESIGN_ASSET_LINK_DENIED')
    if (current !== join(root, relative)) {
      if (info && !info.isDirectory()) throw Error('DESIGN_ASSET_DIRECTORY_INVALID')
      if (!info && create) mkdirSync(current)
    } else if (info && !info.isFile()) throw Error('DESIGN_ASSET_FILE_INVALID')
  }
  return current
}
export function materializeDesignAssets(root: string, assets: DesignAsset[], materials: MaterialContext, beforeWrite: (path: string) => void) {
  const pending = assets.filter(a => a.role === 'required_asset').map(asset => {
    const info = materials.attachments.find(a => a.attachment_id === asset.attachment_id && a.sha256 === asset.sha256)
    if (!info) throw Error('DESIGN_ASSET_UNAVAILABLE')
    const resolved = resolveAttachments(info, [info])[0]
    const bytes = resolved.dataUrl ? Buffer.from(resolved.dataUrl.slice(resolved.dataUrl.indexOf(',') + 1), 'base64') : Buffer.from(resolved.text ?? '', 'utf8')
    if (sha(bytes) !== asset.sha256) throw Error('DESIGN_ASSET_BYTES_CHANGED')
    const relative = designAssetPath(asset); beforeWrite(relative)
    const target = safeTarget(root, relative, false)
    if (existsSync(target) && sha(readFileSync(target)) !== asset.sha256) throw Error('DESIGN_ASSET_TARGET_CONFLICT')
    return { asset, bytes, relative, mime: info.media_type }
  })
  return pending.map(({ asset, bytes, relative, mime }) => {
    const target = safeTarget(root, relative, true)
    if (!existsSync(target)) writeFileSync(target, bytes, { flag: 'wx' })
    return { attachment_id: asset.attachment_id, sha256: asset.sha256, path: relative, media_type: mime, usage: asset.usage,
      transformations: asset.transformations, note: '原始字节已复制；用正确MIME提供资源，实际呈现与衍生图仍需界面验收。' }
  })
}
export function verifyRequiredDesignAssets(root: string, assets: DesignAsset[] = []) {
  for (const asset of assets.filter(a => a.role === 'required_asset')) {
    const target = safeTarget(root, designAssetPath(asset), false)
    if (!existsSync(target) || sha(readFileSync(target)) !== asset.sha256) throw Error('DESIGN_REQUIRED_ASSET_MISSING_OR_CHANGED: ' + asset.attachment_id)
  }
}
export function buildDesignAssetTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>): AgentLoopTool {
  return { name: 'prepare_design_assets', description: '复制已确认必须使用的用户素材原始字节到产品assets/user目录；返回路径/MIME/用途。仅复制当前授权材料，不联网、不覆盖冲突文件。风格参考不自动作为产品背景，复制成功不代表已在界面使用。',
    input_schema: { type: 'object', additionalProperties: false, properties: {} }, execute: async (input, ctx) => {
      policy.assertCommand(ctx); ctx.signal.throwIfAborted()
      if (ctx.projectId !== projectId || Object.keys(input).length) throw Error('DESIGN_ASSET_TOOL_DENIED')
      const brief = readPrdBackplane(projectId)
      if (!brief.user_confirmed_at) throw Error('DESIGN_ASSET_SCOPE_UNCONFIRMED')
      return { output: JSON.stringify({ assets: materializeDesignAssets(findProject(projectId).root_path, brief.lean_brief?.design_assets ?? [], sessionMaterials(projectId, ctx.sessionId), path => policy.assertFileWrite(path, ctx)), verification: 'not_issued' }) }
    } }
}
