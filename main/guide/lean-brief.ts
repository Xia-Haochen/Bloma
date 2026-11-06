import { bindDesignAssets } from '../model/design-assets'
import type { AttachmentInfo } from '../../shared/attachment-types'
import { intentSources, validateIntentAssessment } from '../model/personal-intent'
import { validateRequirementsModel, projectRequirementsModel, type RequirementsModel } from '../model/requirements-model'
import { snapshotProductTheme } from '../../shared/product-design-theme'
import { validateProjectPlan } from '../software/project-plan'
import { createHash } from 'node:crypto'
import type { PrdBackplane, SketchRequirement } from '../model/prd-backplane'
import { bindAcceptance } from '../project/requirement-contract'
import type { LeanScopeSuggestion } from '../../shared/types'
import { parseLeanSuggestions } from './lean-suggestions'
import { requirementCapabilities, validRequirementCapabilities } from '../model/requirement-capabilities'

const texts = (value: unknown): string[] => Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()) ? value : []
const object = (x: unknown): x is Record<string, unknown> => Boolean(x && typeof x === 'object' && !Array.isArray(x))

export const LEAN_BRIEF_PROMPT = `把用户目标整理为简短、可执行的工作约定。先保留原话、资料、明确边界和特殊业务规则；只问真正影响结果且无法调查确定的问题，不问内部技术选型。
目标明确时输出JSON：{"action":"brief","name":"简短名称","goal":"要做成什么","ui":"required|none","requirements":[{"id":"已有编号可保留，新项可省略","description":"必须实现的能力","expected":"可观察的完成标准"}],"constraints":[],"out_of_scope":[],"assumptions":[],"work_items":["下一步要调查、实验、实现或验证什么"]}。
工作清单只列现在有用的少量主项，可以先调查资料和现有环境、运行最小实验，再逐步细化；不是流程门禁，不按固定功能数、阶段数或正常/边界/异常类别凑条目。完成标准不能用“清单已勾完”代替实际结果。
新任务无需intent_assessment、requirements_model、来源编号或关系图。业务规则、例外、关键体验及不能接受的替代方案，用自然语言写进完成标准和constraints；不要为省字段弱化用户原意。sources由宿主保留。已有确认的详细契约由宿主沿用；确实修改它时才提交更新的requirements_model，不得悄悄丢弃原规则。
保留已有功能编号和范围；未采纳的建议不得混入必需功能。必要时可单列suggestions:[{title,description,benefit,expected}]。未知技术能力优先列入调查/实验，不要求用户回答。只有缺少业务决定才输出{"action":"clarify","question":"具体缺少的决定","options":["选项"]}。
材料引用可用design_assets:[{attachment_id,role:required_asset|style_reference|content,usage,transformations}]，只引用宿主提供的附件，不编造来源或hash。不要输出实现代码、完整验收用例库或其他文档。只输出JSON。`

export function parseLeanBrief(raw: string, context: { projectId: string; sessionId: string; source: string; previous: PrdBackplane; software?: boolean; assets?: AttachmentInfo[]; onIssues?: (issues: string[]) => void }):
  { action: 'clarify'; question: string; options: string[] } | { action: 'brief'; brief: PrdBackplane; suggestions: LeanScopeSuggestion[] } | undefined {
  const fail=(message:string)=>{context.onIssues?.([message]);return undefined}
  let value: unknown
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { return fail('任务单不是完整JSON，请只返回一个完整对象。') }
  if (!object(value)) return fail('任务单必须是对象。')
  if (value.action === 'clarify' && typeof value.question === 'string' && value.question.trim()) {
    return { action: 'clarify', question: value.question, options: texts(value.options) }
  }
  if (value.action !== 'brief' || typeof value.goal !== 'string' || !value.goal.trim() || !['required', 'none'].includes(String(value.ui))
    || !Array.isArray(value.requirements) || !value.requirements.length) return fail('需要明确目标、界面类型和至少一项带完成标准的业务能力。')
  const delivery = value.delivery ?? context.previous.lean_brief?.delivery ?? (value.ui === 'none' ? 'command' : 'desktop')
  const distribution = value.distribution ?? context.previous.lean_brief?.distribution
  if (context.software && distribution !== undefined && !['local', 'portable', 'installer', 'source'].includes(String(distribution))) return
  if (context.software && (!['desktop', 'browser', 'command'].includes(String(delivery)) || value.ui === 'none' && delivery !== 'command' || value.ui === 'required' && delivery === 'command')) return
  let next = Math.max(0, ...context.previous.requirements.map(row => Number(/^F-(\d+)$/.exec(row.id)?.[1] ?? 0))) + 1
  const used = new Set<string>(), requirements: SketchRequirement[] = [], acceptance: Record<string, string> = {}
  for (const row of value.requirements) {
    if (!object(row) || typeof row.description !== 'string' || !row.description.trim() || typeof row.expected !== 'string' || !row.expected.trim()) return fail(`第${requirements.length+1}项需要说明能力和可观察的完成标准。`)
    const prior = context.previous.requirements.find(old => old.id === row.id || old.description === row.description)
    const id = prior?.id ?? `F-${String(next++).padStart(3, '0')}`
    if (used.has(id)) return
    used.add(id)
    if(row.capabilities!==undefined&&!validRequirementCapabilities(row.capabilities))return
    const feature:SketchRequirement={id,description:row.description,priority:'P0',behavior_assertions:[row.expected]}
    const declared=row.capabilities??(prior?.description===row.description&&context.previous.acceptance[prior.id]===row.expected?prior.capabilities:undefined)
    if(declared!==undefined)feature.capabilities=[...new Set([...requirementCapabilities(feature),...(declared as NonNullable<SketchRequirement['capabilities']>)])]
    requirements.push(feature)
    acceptance[id] = row.expected
  }
  for(const field of ['constraints','out_of_scope','assumptions'] as const) {
    if(value[field]!==undefined&&(!Array.isArray(value[field])||!(value[field] as unknown[]).every(x=>typeof x==='string'&&x.trim())))return fail(`${field}需要明确的文本条目，不能丢失业务边界。`)
  }
  let plan
  try { plan = validateProjectPlan(value.project_plan === undefined ? context.previous.project_plan : value.project_plan, requirements.map(r => r.id)) } catch { return fail('已有阶段范围与本次功能不一致；新任务可使用不绑定阶段的work_items。') }
  const sources = intentSources(context.source, context.previous.requirements_model?.sources ?? context.previous.lean_brief?.intent_sources)
  const assessment = context.previous.lean_brief?.intent_assessment
  if ((assessment !== undefined) && !validateIntentAssessment(assessment, sources)) {
    context.onIssues?.(['保存的来源关联无效，原记录需要核对；不会生成新的结构路由问卷']); return
  }
  let model: RequirementsModel | undefined
  if (value.requirements_model !== undefined) {
    if (!object(value.requirements_model)) return
    model = { ...structuredClone(value.requirements_model), sources } as unknown as RequirementsModel
    const issues = validateRequirementsModel(model, requirements)
    if (issues.length || model.open_questions.length) { context.onIssues?.([...issues, ...model.open_questions]); return }
  } else if (context.previous.requirements_model) {
    model={...structuredClone(context.previous.requirements_model),sources}
    const issues=validateRequirementsModel(model,requirements)
    if(issues.length||model.open_questions.length){context.onIssues?.(['已有确认的详细规则与本次范围不一致，请明确保留或修改相关业务内容。',...issues,...model.open_questions]);return}
  }
  let assets
  try { assets = bindDesignAssets(value.design_assets, context.assets ?? [], context.previous.lean_brief?.design_assets) } catch { return }
  const priorTheme = context.previous.lean_brief?.design_theme
  const designTheme = (context.software || priorTheme) && value.ui === 'required'
    ? priorTheme ? snapshotProductTheme(priorTheme) : !context.previous.lean_brief || context.previous.lean_brief.ui === 'none' ? snapshotProductTheme() : undefined
    : undefined
  return { action: 'brief', suggestions: parseLeanSuggestions(value.suggestions, requirements.map(row => row.description)), brief: projectRequirementsModel(bindAcceptance({ project_id: context.projectId,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : context.previous.name,
    positioning: value.goal, requirements, acceptance, ...(model ? { requirements_model: model } : {}), ...(plan ? { project_plan: plan } : {}), constraints: value.constraints===undefined?context.previous.constraints??[]:texts(value.constraints), out_of_scope: value.out_of_scope===undefined?context.previous.out_of_scope:texts(value.out_of_scope), assumptions: value.assumptions===undefined?context.previous.assumptions:texts(value.assumptions),
    lean_brief: { ...(validateIntentAssessment(assessment, sources) && (assessment.mode==='direct'||model) ? { intent_assessment: assessment } : {}), ...(assets ? { design_assets: assets } : {}), ...(designTheme ? { design_theme: designTheme } : {}), intent_sources: sources, work_items: value.work_items === undefined ? context.previous.lean_brief?.work_items : texts(value.work_items), version: 1, ui: value.ui as 'required' | 'none', source_session_id: context.sessionId,
      ...(context.software ? { delivery: delivery as 'desktop' | 'browser' | 'command' } : {}),
      ...(context.software && distribution !== undefined ? { distribution: distribution as 'local' | 'portable' | 'installer' | 'source' } : {}),
      source_sha256: createHash('sha256').update(context.source).digest('hex') } })) }
}

export function renderLeanBrief(brief: PrdBackplane): string {
  return [brief.positioning, ...(brief.lean_brief?.work_items?.length ? ['建议工作步骤（可随调查调整，不作为验收通过条件）：'+brief.lean_brief.work_items.join(' → ')] : []), ...(brief.project_plan ? ["实施顺序（全部功能仍须交付）：" + brief.project_plan.stages.map(s => s.title + "（" + s.feature_ids.join("、") + "）").join(" → ")] : []), ...brief.requirements.map(row => `${row.id} ${row.description}\n完成应看到：${brief.acceptance[row.id] ?? ''}`),
    ...(brief.lean_brief?.delivery ? ['使用方式：' + ({ desktop: '桌面软件，一键启动', browser: '在本机浏览器使用', command: '命令工具' }[brief.lean_brief.delivery])] : []),
    ...(brief.lean_brief?.distribution ? ['交付方式：' + ({ local: '在本机直接使用', portable: '可复制到其他电脑直接使用', installer: '可在其他电脑安装使用', source: '移交源码' }[brief.lean_brief.distribution])] : []),
    ...(brief.lean_brief?.preview === 'reuse' ? ['界面沿用已确认外观，在制作时按新增功能调整。'] : []),
    ...(brief.lean_brief?.preview === 'skip' ? ['按你的授权直接制作，不再生成草图。'] : []),
    ...(brief.requirements_model?.experience ? ['核心体验：' + brief.requirements_model.experience.summary, ...brief.requirements_model.experience.commitments.map(c => c.statement + '；不能替代为：' + c.unacceptable_substitute)] : []),
    ...(brief.requirements_model ? ['关键规则：' + brief.requirements_model.rules.map(r => r.statement).join('；')] : []),
    ...(brief.lean_brief?.design_assets?.length ? ['素材用途：' + brief.lean_brief.design_assets.map(a => a.usage + '（' + a.role + '；' + a.transformations + '）').join('；')] : []),
    ...(brief.lean_brief?.design_theme ? ['默认外观：未指定风格时沿用平台暖白、低饱和绿基调；你的风格要求和已确认设计优先，布局按用途设计。'] : []),
    ...(brief.constraints?.length ? ['约束：' + brief.constraints.join('；')] : []),
    ...(brief.out_of_scope.length ? ['不做：' + brief.out_of_scope.join('；')] : []),
    ...(brief.assumptions.length ? ['假设：' + brief.assumptions.join('；')] : [])].join('\n\n')
}
