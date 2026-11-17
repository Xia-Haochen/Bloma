import { intentSources } from '../model/personal-intent'
import { sessionMaterials } from '../platform/attachments/material-context'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { parseLeanBrief } from '../guide/lean-brief'
import { authorizesSkipPreview, stageLeanScope } from '../guide/lean-scope'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { listDelegations } from '../agent/delegation/agent-collaboration'
import { isSoftwareProject } from './workflow-policy'
import { ACCEPTANCE_SCENARIOS, REQUIREMENT_CAPABILITIES } from '../model/requirement-capabilities'

/** The working agent proposes only a genuine scope change; host pauses before
 * any following tool, then reuses the normal scope confirmation on resume. */
export function buildLeanScopeTool(projectId: string, source: string, emit: Parameters<typeof stageLeanScope>[5], pause: () => void): AgentLoopTool {
  const current = readPrdBackplane(projectId), sourceList = intentSources(source, current.requirements_model?.sources ?? current.lean_brief?.intent_sources)
  return { name: 'propose_scope_change', description: '只有用户改变业务范围或业务预期时使用。提交保留旧F编号的完整短任务单和用户依据。宿主展示差异并暂停等待确认；局部外观或修复不使用。',
    input_schema: { type: 'object', required: ['goal', 'ui', 'requirements'], properties: {
      goal: { type: 'string' }, name: { type: 'string' }, ui: { type: 'string', enum: ['required', 'none'] },
      delivery: { type: 'string', enum: ['desktop', 'browser', 'command'] },
      distribution: { type: 'string', enum: ['local', 'portable', 'installer', 'source'] },
      requirements: { type: 'array', items: { type: 'object', required: ['description', 'expected'], properties: {
        id: { type: 'string' }, description: { type: 'string' }, expected: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string', enum: [...REQUIREMENT_CAPABILITIES] } },
        acceptance_scenarios: { type: 'array', items: { type: 'string', enum: [...ACCEPTANCE_SCENARIOS] } },
      } } },
      constraints: { type: 'array', items: { type: 'string' } }, out_of_scope: { type: 'array', items: { type: 'string' } },
      work_items:{type:'array',items:{type:'string'},description:'建议工作步骤，可随调查调整；不作为验收或开工门禁。'},
      requirements_model: { type: 'object', description: '仅修改已有详细契约时提供；省略则由宿主保留已有模型，来源由宿主回填。' },
      design_assets: { type: 'array', items: { type: 'object' } },
      assumptions: { type: 'array', items: { type: 'string' } },
    } }, execute: async (input, ctx) => {
      if (ctx.projectId !== projectId) return { output: 'SCOPE_PROJECT_MISMATCH', isError: true }
      if (listDelegations(ctx.sessionId).some(row => row.status === 'running')) return { output: '请先等待或停止正在执行的子任务，再更新范围。', isError: true }
      const previous = readPrdBackplane(projectId)
      let issues: string[] = []
      const parsed = parseLeanBrief(JSON.stringify({ ...input, action: 'brief' }), { projectId, sessionId: ctx.sessionId, source, previous, assets: sessionMaterials(projectId, ctx.sessionId).attachments, software: isSoftwareProject(projectId), onIssues: rows => { issues = rows } })
      if (!parsed || parsed.action !== 'brief') return { output: JSON.stringify({ error:'SCOPE_INVALID_BRIEF', issues, sources:sourceList }), isError: true }
      if (prdScopeFingerprint(previous) === prdScopeFingerprint(parsed.brief)) return { output: '范围未变化，直接处理本次局部修改。' }
      if (authorizesSkipPreview(source)) parsed.brief.lean_brief!.preview = 'skip'
      stageLeanScope(projectId, ctx.sessionId, ctx.requestId, previous, parsed.brief, emit)
      pause()
      return { output: '新范围已保留，等待用户确认；本轮停止，不再执行后续工具。' }
    } }
}
