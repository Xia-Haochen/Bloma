import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeTextFileAtomic } from '../../storage/json-store'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { readPrdBackplane } from '../project/prd-store'
import { findProject } from '../project/project-service'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { componentContract } from './component-contracts'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'

const file = 'COMPONENT_USAGE.json'
type Use = { capability: string; feature_ids: string[]; purpose: string }
export function componentUsage(root: string, featureIds: string[], uses: Use[]) {
  if (!Array.isArray(uses) || uses.length > 32 || new Set(uses.map(u => u?.capability)).size !== uses.length) throw Error('COMPONENT_USAGE_INVALID')
  return uses.map(use => {
    const contract = use && componentContract(use.capability)
    if (!contract || !Array.isArray(use.feature_ids) || !use.feature_ids.length || use.feature_ids.some(f => !featureIds.includes(f))
      || typeof use.purpose !== 'string' || !use.purpose.trim() || use.purpose.length > 2000) throw Error('COMPONENT_USAGE_REFERENCE_INVALID')
    const files = contract.files.map(f => {
      const path = join(root, f.name), info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw Error('COMPONENT_USAGE_FILE_INVALID')
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
      return { path: f.name, sha256, origin: sha256 === f.sha256 ? 'platform' : 'adapted' }
    })
    return { ...use, contract_version: contract.version, source_revision: contract.source_revision,
      runtime: contract.runtime, dependencies: contract.dependencies, behavior: contract.behavior, files, product_verification: 'unverified' }
  })
}
export function verifyComponentUsage(root: string, scope: string, featureIds: string[]) {
  const path = join(root, file)
  if (!existsSync(path)) return // Existing/simple products need not adopt components.
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw Error('COMPONENT_USAGE_INVALID')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  if (record.version !== 1 || record.scope !== scope || !Array.isArray(record.uses)) throw Error('COMPONENT_USAGE_STALE')
  // The recorded provider revision describes preparation time; actual candidate
  // bytes are checked without requiring automatic upgrades to today's platform.
  for (const use of record.uses) {
    if (!Array.isArray(use.feature_ids) || !use.feature_ids.length || use.feature_ids.some((f:string) => !featureIds.includes(f)) || !Array.isArray(use.files) || use.files.length > 128) throw Error('COMPONENT_USAGE_INVALID')
    for (const f of use.files) {
      if (!/^[A-Za-z0-9_.-]+$/.test(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256)) throw Error('COMPONENT_USAGE_PATH_INVALID')
      const path = join(root, f.path), info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(readFileSync(path)).digest('hex') !== f.sha256) throw Error('COMPONENT_USAGE_BYTES_CHANGED')
    }
  }
}
export function buildComponentUsageTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>): AgentLoopTool {
  return { name: 'register_component_usage', description: '组合已有基础组件后记录用途和需求关联，宿主读取实际组件版本/文件hash与错误取消契约；自定义改动标adapted。不是验收证据，不要求用工作台模板。组件或范围变化后更新此清单。',
    input_schema: { type:'object',additionalProperties:false,required:['uses'],properties:{uses:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,required:['capability','feature_ids','purpose'],properties:{capability:{type:'string'},feature_ids:{type:'array',items:{type:'string'}},purpose:{type:'string',maxLength:2000}}}}}},
    execute:async(input,ctx)=>{policy.assertCommand(ctx);ctx.signal.throwIfAborted();if(ctx.projectId!==projectId)throw Error('COMPONENT_USAGE_OWNER');policy.assertFileWrite(file,ctx)
      const brief=readPrdBackplane(projectId),root=findProject(projectId).root_path
      if(!brief.user_confirmed_at)throw Error('COMPONENT_USAGE_UNCONFIRMED')
      const value={version:1,scope:prdScopeFingerprint(brief),uses:componentUsage(root,brief.requirements.map(f=>f.id),input.uses as Use[])}
      const target=join(root,file);if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw Error('COMPONENT_USAGE_LINK_DENIED')
      writeTextFileAtomic(target,JSON.stringify(value,null,2));return{output:JSON.stringify(value)}
    } }
}
