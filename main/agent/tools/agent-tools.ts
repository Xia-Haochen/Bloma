import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { rmSyncWithRetry } from '../../platform/storage/fs-retry'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { findProject } from '../../project/project-service';
import { decideWrite, estimateTokenCount } from '../loop/usage-guard'
import { toolEvidenceEnabled, writeGuardEnabled, preflightEnabled, type AgentLoopTool, type ToolContext, type ToolOutcome } from '../loop/agent-loop';
import { commitFileWrite, contentRevision, fileRevisionMatches, fileRevisionOf, fileRevisionsOf } from './write-lease'
import { replaceUniqueText, replaceMultipleTexts, type TextEdit } from './text-edit'
import { committedChange } from './change-display'
import { redactSoftwareOutput } from '../../software/process-manager'
import type { ToolFileChange } from '../../../shared/tool-display'
import { boundedInteger, readTextWindow, readWindowProperties, searchProjectFiles, pageFileNames, compileFileGlob } from './file-query'
import { resolveProjectRoot } from '../../../shared/project-root-override'
import { buildDelegationTools } from '../delegation/delegation-tools'
import { buildWebFetch, buildWebResearch } from './web-tools'
// 向后兼容 re-export（setWebResearchTimeoutForTests 随 web_research 迁至 web-tools；存量 import 零改动）
export { WEB_RESEARCH_TIMEOUT_MS, setWebResearchTimeoutForTests } from './web-tools'
import type { DelegationRole } from '../delegation/agent-collaboration'

/**
 * Agent Loop 工具集（L2，AgentLoop 改造方案 §4.3；委派协作嫁接方案 §4.2）。
 *
 * 主 agent（role='parent'）9 个受控 ACI 工具（8 本地 + web_fetch 联网只读）+ 委派工具族
 * （delegate_agent / web_research 委派化调研 / wait·get·stop / ask·answer·continue）；
 * 子 agent 按 role 裁剪（explore/research 只读，implement/review/custom 全量 9，无委派工具）。
 * 输出契约一律按 SWE-agent ACI 规范：截断、结构化、空输出显式反馈（「执行成功，无输出」）。
 * 编辑护栏前置：write_file / edit_file 落盘前做语法/结构校验，错误当场回给模型（lint guardrail）。
 *
 * 通用约束：
 * - 路径沙箱：resolve(join(root, path)) 必须仍在 root 内（防 ../ 逃逸）；
 *   可写范围 = 白名单后缀（.html/.js/.css）+ src/ 子树（沿用 MODEL_WRITABLE_TESTS 思路放宽）。
 * - 网络出口仅 web_fetch：只允许 http/https 公网地址（SSRF 防护拒绝内网/保留段/无点
 *   主机名，重定向终态复检），响应限 2MB，输出按 ACI 契约截断。
 * - create_snapshot / rollback_snapshot 不进工具集：快照时机由编排层控制，
 *   模型无权决定检查点（与「snapshot 由管线在关键节点创建」语义一致）。
 * - 修复预算口径（PR3 §4.4，同构旧 test_repair_count ≤3）：GWT 首次失败后，
 *   edit_file/write_file 共享 3 次修复预算，第 4 次起软着陆提示收尾。
 */

/** 测试失败后的写入类工具修复预算（同构旧管道 test_repair_count ≤ 3）。 */
export const EDIT_BUDGET_AFTER_TEST_FAILURE = 3

/** web_research 回灌主 loop 的结论上限（字符）。 */
export const WEB_RESEARCH_MAX_CHARS = 4000
/** web_research 调研子代理的收敛上限（毫秒）。 */

/** 系统接管文件（与 mvp-engine-llm SYSTEM_FILES 同集）：模型写入会被拒绝。
 *  比较统一小写化（M-7）：Windows 大小写不敏感文件系统上 'Static-Server.js' 会实际
 *  覆盖 static-server.js（篡改沙箱服务端含 CSP 响应头），精确匹配会被绕过。
 *  W3：增 .bloma-real-variant 标记（平台管理，防 agent 篡改形态判定）。真实脚手架项目
 *  里 package.json/server.js 是产物文件可写——变体感知由 isSystemFile(rel, realVariant) 分流。 */
const SYSTEM_FILES = new Set(['package.json', 'static-server.js', '.bloma-real-variant'])

/** 8.3 短名族（T-2 实测实锤：Windows 短名别名可写覆盖系统文件——写入
 *  'STATIC~1.JS' 实际命中 static-server.js；'PACKAG~1.JSO' 命中 package.json。
 *  生成规则与 Windows 一致：基名前 6 字符 + ~序号 + 扩展名前 3 字符）。 */
const SYSTEM_FILE_SHORT_NAMES = new Set(
  [...SYSTEM_FILES].map((name) => {
    const dot = name.lastIndexOf('.')
    const base = name.slice(0, dot).slice(0, 6)
    const ext = name.slice(dot + 1, dot + 4)
    return `${base}~1.${ext}`.toLowerCase()
  }),
)

function isSystemFile(rel: string, realVariant = false): boolean {
  const lower = rel.toLowerCase()
  // W3：真实脚手架项目里只有变体标记是平台管理件（package.json/server.js 皆是产物）；
  // 旧路径维持全集字节级不变
  if (realVariant) return lower === '.bloma-real-variant'
  if (SYSTEM_FILES.has(lower)) return true
  // T-2：短名别名族（STATIC~N.JS / PACKAG~N.JSO）——~N 序号归一到 ~1 后比对
  const base = lower.split(/[\\/]/).pop() ?? lower
  if (/^[a-z0-9]{1,6}~\d+\.[a-z0-9]{1,3}$/.test(base)) {
    if (SYSTEM_FILE_SHORT_NAMES.has(base.replace(/~\d+\./, '~1.'))) return true
  }
  return false
}

/** 模型可写白名单后缀（静态前端产物）。 */
const WRITABLE_EXTENSIONS = new Set(['.html', '.js', '.css'])

/** 只读参考目录（PR-1 骨架先行 examples + 官方模块库 official-modules）：只读——防止模型
 *  改写参考实现误导后续轮次。软保护而非安全边界（SYSTEM_FILES 才是）：目录短名变体
 *  （EXAMPLES~1/ 等）不在防御面，入侵后果仅为参考实现被改写，不影响系统接管文件与 CSP。 */
const READONLY_DIR_PREFIXES = ['src/examples/', 'src/official-modules/']

function isReadOnlyPath(rel: string): boolean {
  const lower = rel.toLowerCase()
  return READONLY_DIR_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/** list_files / grep 跳过的非产物目录。 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-main'])

const LIST_DEPTH_LIMIT = 4
const LIST_ENTRY_LIMIT = 200
export const SANDBOX_LOG_TAIL_LIMIT = 2048

// =========================================================================
// 语法护栏（可注入 seam，测试替换为同步桩）
// =========================================================================

type JsSyntaxChecker = (content: string) => Promise<{ ok: true } | { ok: false; error: string }>

let jsSyntaxChecker: JsSyntaxChecker = checkJsSyntaxViaNode

/** 测试 seam：替换 JS 语法检查器（避免单测依赖真实 node 子进程）。 */
export function setJsSyntaxCheckerForTests(checker?: JsSyntaxChecker): void {
  jsSyntaxChecker = checker ?? checkJsSyntaxViaNode
}

/**
 * node --check 落盘前护栏：先按 ES Module 解析（.mjs，现代语法的超集），
 * 失败再按脚本解析（.cjs，兼容顶层 return 等旧式写法）；两者皆败才判语法错误。
 */
async function checkJsSyntaxViaNode(content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = join(tmpdir(), `bloma-syntax-${randomUUID()}`)
  const mjs = `${base}.mjs`
  const cjs = `${base}.cjs`
  try {
    writeFileSync(mjs, content, 'utf8')
    const moduleCheck = await runNodeCheck(mjs)
    if (moduleCheck.ok) return { ok: true }
    writeFileSync(cjs, content, 'utf8')
    const scriptCheck = await runNodeCheck(cjs)
    if (scriptCheck.ok) return { ok: true }
    return { ok: false, error: moduleCheck.stderr.trim() || 'JS 语法检查未通过' }
  } finally {
    rmSyncWithRetry(mjs, { force: true })
    rmSyncWithRetry(cjs, { force: true })
  }
}

function runNodeCheck(file: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolvePromise) => {
    // Electron 下 process.execPath 是 electron.exe（platform-services resolveNodeExecutable 同款解析）
    const executable = process.env.npm_node_execpath || process.env.NODE || 'node'
    const child = spawn(executable, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', () => resolvePromise({ ok: false, stderr: '无法启动 node 进行语法检查' }))
    child.once('close', (code) => resolvePromise({ ok: code === 0, stderr }))
  })
}

/** HTML 结构护栏：结构标签配平 + 以 </html> 结尾（对齐磁盘证据 isHtmlDocument 口径）。 */
function checkHtmlStructure(content: string): string | null {
  const issues: string[] = []
  for (const tag of ['html', 'head', 'body', 'script']) {
    const open = (content.match(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi')) ?? []).length
    const close = (content.match(new RegExp(`</${tag}>`, 'gi')) ?? []).length
    if (open !== close) issues.push(`<${tag}> 开标签 ${open} 个、闭标签 ${close} 个，不匹配`)
  }
  if (!/<\/html>\s*$/i.test(content.trim())) issues.push('文档必须以 </html> 结尾')
  return issues.length > 0 ? `HTML 结构校验未通过：${issues.join('；')}` : null
}

/** 剥离模型自发写入的 meta CSP（平台 CSP 是唯一真相源，双重 CSP 会拦死内联脚本）。 */
function stripMetaCsp(content: string): string {
  return content.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
}

// =========================================================================
// 路径沙箱
// =========================================================================

function resolveInsideProject(
  root: string,
  rawPath: unknown,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, error: '缺少 path 参数（项目内相对路径，如 index.html 或 src/app.js）' }
  }
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized.includes('..') || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, error: `路径必须在项目目录内（收到 "${rawPath}"，不允许绝对路径或 ../ 逃逸）` }
  }
  const abs = resolve(join(root, normalized))
  const rel = relative(resolve(root), abs).replace(/\\/g, '/')
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `路径必须在项目目录内（收到 "${rawPath}"）` }
  }
  try {
    let ancestor = abs
    while (!existsSync(ancestor)) {
      const parent = resolve(ancestor, '..')
      if (parent === ancestor) return { ok: false, error: '项目目录不可用' }
      ancestor = parent
    }
    const actual = relative(realpathSync(root), realpathSync(ancestor))
    if (actual === '..' || actual.startsWith('..\\') || actual.startsWith('../') || isAbsolute(actual)) return { ok: false, error: '路径必须在项目目录内（符号链接目标越界）' }
  } catch { return { ok: false, error: '项目目录或路径不可读取' } }
  return { ok: true, abs, rel }
}

function isWritablePath(rel: string, realVariant = false): boolean {
  if (isSystemFile(rel, realVariant)) return false
  if (isReadOnlyPath(rel)) return false
  if (realVariant) {
    // W3：真实工程件皆产物——项目内任意文件可写；仅排除基础设施目录（vendor 供货/
    // 版本史/回滚备份，非 agent 职责）
    const lower = rel.toLowerCase()
    if (lower.startsWith('node_modules/') || lower.startsWith('.git/') || lower.startsWith('data-backups/')) return false
    return true
  }
  if (rel.startsWith('src/')) return true
  return WRITABLE_EXTENSIONS.has(extname(rel).toLowerCase())
}

function notWritableError(rel: string, realVariant = false): string {
  if (isSystemFile(rel, realVariant)) return `「${rel}」由平台管理，不允许直接修改。`
  if (rel.toLowerCase().startsWith('src/official-modules/')) return `「${rel}」是官方模块（只读参考），不允许修改；可 read_file 查看后复制到业务文件按需改编。`
  if (isReadOnlyPath(rel)) return `「${rel}」是只读参考示例（骨架包 src/examples/），不允许修改；可 read_file 参考共模式后在业务文件中实现。`
  if (realVariant) return `「${rel}」不在可写范围内（node_modules/.git/data-backups 是平台基础设施，不允许修改）。`
  return `「${rel}」不在可写范围内（允许：.html/.js/.css 文件与 src/ 子树）。`
}

/** 注入点⑥工具层拦截（周计划 §6）：外部 CDN script/link 引用检测（模板依赖白名单禁外部
 * 资源）；注入点关闭时返回 null 不拦截（行为=现状）。仅拦可执行/样式外链，img/字体
 * 等资源外链不拦（模板允许图片占位）。 */
export function externalResourceViolation(htmlContent: string): string | null {
  const scriptMatch = /<script[^>]+src\s*=\s*["']https?:\/\/[^"']+["']/i.exec(htmlContent)
  if (scriptMatch) return `检测到外部脚本引用（${scriptMatch[0].slice(0, 80)}…）`
  const linkMatch = /<link[^>]+href\s*=\s*["']https?:\/\/[^"']+["']/i.exec(htmlContent)
  if (linkMatch) return `检测到外部样式引用（${linkMatch[0].slice(0, 80)}…）`
  return null
}

/** 递归收集项目内文件（跳过非产物目录），返回相对路径列表。 */
function collectProjectFiles(root: string, subDir = '', software = false, budget = { files: 0, depthLimited: 0, unreadable: 0 }): string[] {
  const out: string[] = []
  const base = subDir ? join(root, subDir) : root
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    budget.unreadable++
    return out
  }
  for (const entry of entries) {
    const rel = subDir ? `${subDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      if (software && ['.venv', 'venv', '__pycache__', '.cache', '00_HISTORY'].includes(entry.name)) continue
      if (rel.split('/').length >= (software ? 48 : LIST_DEPTH_LIMIT)) { budget.depthLimited++; continue }
      out.push(...collectProjectFiles(root, rel, software, budget))
    } else if (entry.isFile()) {
      if (software && ++budget.files > 100000) throw Error('FILE_SEARCH_LIMIT_EXCEEDED: 请限定子目录')
      out.push(rel)
    }
  }
  return out.sort()
}

/** find 返回上限（与 LIST_ENTRY_LIMIT 同档）。 */
const FIND_ENTRY_LIMIT = 100

// =========================================================================
// D 系列辅助（咨询 D，2026-09-09）：文件版本戳 / 验证状态行 / 版本登记
// =========================================================================

/** D4a/P1-06：文件版本戳与版本记录已下沉 write-lease（提交点 CAS 与写租约同模块）；
 *  fileRevisionOf 由下方 import 绑定后 re-export，保持既有 import 路径零改动。 */
export { fileRevisionOf }

/**
 * D2：验证状态行（宿主维护，不靠 LLM 自报）——「已验证什么 / 尚缺什么」。
 * 仅 BLOMA_TOOL_EVIDENCE=on 时被消费；返回空串表示未启用（字节级现状）。
 */
export function validationStateLine(state: { gwt_all_passed: boolean; security_all_passed: boolean; api_all_passed: boolean; preflight_passed?: boolean }): string {
  if (!toolEvidenceEnabled()) return ''
  const done: string[] = []
  const missing: string[] = []
  ;(state.gwt_all_passed ? done : missing).push('行为断言 GWT')
  ;(state.api_all_passed ? done : missing).push('API 契约')
  ;(state.security_all_passed ? done : missing).push('安全扫描')
  // W3-D2：预检开启时收口面增加 run_preflight（未跑/未过都在「尚缺」）
  if (preflightEnabled()) (state.preflight_passed ? done : missing).push('收口预检 run_preflight')
  if (missing.length === 0) return '\n验证状态：行为断言/ API 契约/安全扫描均已通过——全部验证面通过，可输出完成总结。'
  return `\n验证状态：已通过=${done.length ? done.join('、') : '（无）'}；尚缺=${missing.join('、')}${!state.api_all_passed ? '（数据留存/接口类项目收口前必须 run_api_contract_tests 通过）' : ''}${preflightEnabled() && !state.preflight_passed ? '（收口前必须 run_preflight 全部通过）' : ''}。`
}

// =========================================================================
// 工具集工厂
// =========================================================================

export interface BuildAgentToolsOptions {
  /** Software projects choose their own frontend/build ecosystem. */
  software?: boolean
  /** Host write ownership is checked again after asynchronous syntax validation. */
  assertFileWrite?: (path: string, ctx: ToolContext) => void
  projectId: string
  /** 编辑格式能力位：diff（默认，强模型精确替换）/ whole（弱渠道整文件重写，Aider 结论） */
  editFormat?: 'diff' | 'whole'
  /** 委派角色裁剪：缺省 'parent'（全量 8 + delegate_agent）；explore/research 只读；子 agent 无委派工具 */
  role?: 'parent' | DelegationRole
  /** 新修复回合开始时回调（PR3 埋点：self_repair_triggered 的 loop 路径映射） */
  onRepairRound?: (round: number) => void
  /** W4-F2（咨询 D4）：修复轮修改授权边界——传入即启用：write_file/edit_file 越界返回
   *  WRITE_SCOPE_DENIED + next_actions（不诱导绕权限），并注册 repair_control 窄入口。 */
  writeScope?: WriteScopeHolder
  /** PR4c：真实脚手架变体（原由本模块读标记文件判定，现调用方注入；缺省 false=旧路径行为） */
  realFullstackVariant?: boolean
  /** PR4c：产物落盘后的地图刷新回调（原直连 project-map，现调用方注入；缺省不刷新） */
  onProjectFilesChanged?: (projectRoot: string) => void
}

/** W4-F2：授权边界持有者（宿主创建与裁决，工具层只读/申请，模型不能直改）。 */
export interface WriteScopeHolder {
  /** 当前允许修改的相对路径（与工具 path 入参同口径，正斜杠） */
  authorized: Set<string>
  /** 显式受保护路径（拒绝任何扩大申请；如 prd.json/宿主文件） */
  protectedPaths: Set<string>
  /** 扩大申请记录（含裁决结果；审计与 bench 可见） */
  expansions: Array<{ issue_id?: string; paths: string[]; reason: string; at: string; decision: 'approved' | 'denied'; note?: string }>
  /** 受阻报告（F5 升级链路的结构化输入） */
  blockers: Array<{ reason: string; evidence?: string; at: string }>
}

export function createWriteScope(authorizedPaths: string[], protectedPaths: string[] = []): WriteScopeHolder {
  return {
    authorized: new Set(authorizedPaths.map((p) => p.replace(/\\/g, '/'))),
    protectedPaths: new Set(protectedPaths.map((p) => p.replace(/\\/g, '/'))),
    expansions: [],
    blockers: [],
  }
}

export function buildAgentTools(options: BuildAgentToolsOptions): AgentLoopTool[] {
  const editFormat = options.editFormat ?? 'diff'
  const projectId = options.projectId
  // P1-06 收尾：项目根经 kernel 覆盖解析——worktree 隔离模式下子会话的读写落独立工作树（
  // 覆盖缺省=主目录，行为零变化）
  const projectRoot = (): string => resolveProjectRoot(projectId, () => findProject(projectId).root_path)
  const role = options.role ?? 'parent'
  // W3：真实脚手架变体——PR4c 改由调用方注入（去域依赖；缺省 false=旧路径字节级）
  const realVariant = options.realFullstackVariant ?? false

  /**
   * 测试失败后的修复预算门（edit-after-test-failure ≤ 3，PR3 §4.4 口径，同构旧
   * test_repair_count）：只拦真实写入尝试（路径/参数已校验过），无效调用不烧预算。
   */
  /**
   * W4-F2：修改授权边界门——仅修复轮传入 writeScope 时生效（缺省无 holder=现状）。
   * 越界返回 blocked + next_actions（恢复路径引导，不诱导改用其他文件绕权限）。
   */
  const guardWriteScope = (rel: string): ToolOutcome | undefined => {
    const scope = options.writeScope
    if (!scope || scope.authorized.has(rel)) return undefined
    const listing = [...scope.authorized].slice(0, 8).join('、') || '（空）'
    return {
      output:
        `WRITE_SCOPE_DENIED：${rel} 不在本轮修改授权内（当前授权：${listing}）。` +
        '若根因确在授权外文件，调用 repair_control（action=request_scope_expansion，带 issue_id/requested_paths/reason/change_intent）申请扩大授权；' +
        '批准前不要在卡内文件上做替代实现硬绕根因。',
      isError: true,
      detail: {
        code: 'WRITE_SCOPE_DENIED',
        path: rel,
        next_actions: [{ action: 'request_scope_expansion', required: ['issue_id', 'requested_paths', 'reason', 'change_intent'] }],
      },
    }
  }

  const guardRepairBudget = (ctx: ToolContext): ToolOutcome | undefined => {
    // software-v1 already shares durable request/output/runtime admission and
    // observes host failure progress. Do not add a second three-write cutoff.
    if (options.software) return undefined
    if (!ctx.state.test_failed) return undefined
    ctx.state.edits_after_test_failure += 1
    if (ctx.state.edits_after_test_failure > EDIT_BUDGET_AFTER_TEST_FAILURE) {
      return {
        output:
          `测试失败后的修改预算已用尽（${EDIT_BUDGET_AFTER_TEST_FAILURE} 次）。` +
          '请不要再改文件，基于当前状态输出完成总结（说明哪些断言仍未通过）。',
        budgetExhausted: true,
      }
    }
    return undefined
  }

  /** 落盘前统一护栏：路径沙箱 + 可写范围 + 语法/结构校验 + 修复预算门 + meta CSP 剥离 + 依赖白名单拦截。 */
  const validateAndWrite = async (root: string, rel: string, content: string, ctx: ToolContext, expectedRevision?: string, validation: { preflightOnly?: boolean; syntaxChecked?: boolean } = {}): Promise<ToolOutcome> => {
    ctx.signal.throwIfAborted()
    options.assertFileWrite?.(rel, ctx)
    if (!isWritablePath(rel, realVariant)) return { output: notWritableError(rel, realVariant), isError: true }
    if (extname(rel).toLowerCase() === '.html') {
      const structureError = checkHtmlStructure(content)
      if (structureError) return { output: `${structureError}\n请修正后重新提交完整内容。`, isError: true }
      // 注入点⑥工具层拦截（周计划 §6：loop 引白名单外包→工具层拦截）：外部 CDN
      // script/link 引用拒绝写入（模板依赖白名单禁外部资源；开关关闭时不拦，行为=现状）
      const cdnViolation = options.software ? undefined : externalResourceViolation(content)
      if (cdnViolation) return { output: `${cdnViolation}\n模板依赖白名单禁止外部资源（内联实现或本地文件）；请去除外链后重新提交。`, isError: true }
    }
    if (extname(rel).toLowerCase() === '.js' && !validation.syntaxChecked) {
      const syntax = await jsSyntaxChecker(content)
      if (!syntax.ok) {
        return { output: `JS 语法校验未通过，已拒绝写入 ${rel}：\n${syntax.error}\n请读完错误定位后修改再提交。`, isError: true }
      }
    }
    const finalContent = !options.software && extname(rel).toLowerCase() === '.html' ? stripMetaCsp(content) : content
    const abs = join(root, rel)
    // P1-06（2026-09-26 运行审计）：提交点写入原语——CAS 版本校验（收窄 TOCTOU：
    // 语法校验 await 之后、写盘之前；基准取显式传入或会话读写的版本，宿主强制）
    // + 写租约临界区互斥（并行写者冲突拒绝并教育；单会话零影响；TTL 兜底）。
    ctx.signal.throwIfAborted()
    options.assertFileWrite?.(rel, ctx)
    const checkedPath = resolveInsideProject(root, rel)
    if (!checkedPath.ok) return { output: checkedPath.error, isError: true }
    let ancestor = abs
    while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..')
    const physicalTarget = resolve(realpathSync(ancestor), relative(ancestor, abs))
    const actual = relative(realpathSync(root), physicalTarget).replace(/\\/g, '/')
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (normalize(actual) !== normalize(rel)) return { output: 'PATH_ALIAS_WRITE_DENIED: 请使用真实路径重新读取并通过原权限检查', isError: true }
    if (expectedRevision && !fileRevisionMatches(abs, expectedRevision)) return { output: 'STALE_READ: 提交前内容版本已改变', isError: true, detail: { code: 'STALE_READ', path: rel } }
    if (validation.preflightOnly) return { output: 'PRECHECKED', detail: { path: rel } }
    // 修复预算门：路径/参数/语法均校验通过后才烧预算（无效调用不烧，对齐注释语义）
    const budget = guardRepairBudget(ctx)
    if (budget) return budget
    let displayChange: ToolFileChange | undefined
    const committed = commitFileWrite({
      projectId: ctx.projectId,
      root,
      rel,
      finalContent,
      ctx,
      onCommitted: (before, after) => { displayChange = committedChange(rel, before, after, redactSoftwareOutput) },
      ...(expectedRevision ? { expectedRevision } : {}),
    })
    if (!committed.ok) {
      return { output: committed.output, isError: true, detail: { code: committed.code, path: rel } }
    }
    // project-map（Graft 模式，r69）：PR4c 改回调注入（去域依赖；缺省不刷新）
    try {
      options.onProjectFilesChanged?.(root)
    } catch {
      /* 地图刷新失败静默，不影响写盘结果 */
    }
    const stripped = finalContent !== content
    return {
      output: `已写入 ${rel}（${Buffer.byteLength(finalContent, 'utf8')} 字节）${stripped ? '；已剥离与平台 CSP 冲突的 meta 标签' : ''}`,
      detail: { path: rel, bytes: Buffer.byteLength(finalContent, 'utf8'), ...(displayChange ? { display: {version:1,kind:'changes',files:[displayChange]} } : {}) },
    }
  }

  const read_file: AgentLoopTool = {
    name: 'read_file',
    // Pi remains sequential. This marker is not a claim of current concurrency.
    parallelSafe: true,
    description: '有界读取项目文本，默认100行/16000字符/48000字节，带行号与版本。超长行按返回的next继续读取。files可一次读取最多8个窗口，总输出不超过24000字符/65536字节，每项独立报告失败；与path二选一。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, pattern: '\\S', description: '项目内相对路径' },
        ...readWindowProperties,
        files: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', required: ['path'], properties: {
          path: { type: 'string', minLength: 1 }, ...readWindowProperties,
        } } },
      },
      anyOf: [{ required: ['path'] }, { required: ['files'] }],
    },
    execute: async (input, ctx) => {
      const root = projectRoot()
      const readOne = (item: Record<string, unknown>, limits?: { chars: number; bytes: number }): ToolOutcome => {
        ctx.signal.throwIfAborted()
        const resolved = resolveInsideProject(root, item.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        if (!existsSync(resolved.abs)) return { output: `文件不存在：${resolved.rel}。可用 list_files 查看项目文件清单。`, isError: true }
        const result = readTextWindow(resolved.abs, resolved.rel, item, limits)
        if (!result.isError && typeof result.detail?.revision === 'string') fileRevisionsOf(ctx).set(resolved.rel, result.detail.revision)
        return result
      }
      if (input.files === undefined) return readOne(input)
      if (input.path !== undefined || !Array.isArray(input.files) || !input.files.length || input.files.length > 8) return { output: 'READ_BATCH_INVALID: files含1~8个窗口，与path二选一', isError: true }
      let totalChars: number, totalBytes: number
      try {
        totalChars = boundedInteger(input.max_chars, 24000, 512, 24000)
        totalBytes = boundedInteger(input.max_bytes, 65536, 2048, 65536)
      } catch { return { output: 'READ_BATCH_ARGUMENT_INVALID', isError: true } }
      if (totalChars < input.files.length * 300 + 512 || totalBytes < input.files.length * 1024 + 2048) return { output: 'READ_BATCH_BUDGET_TOO_SMALL: 提高总输出上限或减少窗口数；本批未读取', isError: true }
      const results: ToolOutcome[] = []
      let chars = 0, bytes = 0
      // Reserve bounded status/error space for every later item, including when
      // an early huge window consumes the content budget. No dropped batch item.
      for (const [index, item] of input.files.entries()) {
        ctx.signal.throwIfAborted()
        const later = input.files.length - index - 1
        const remaining = { chars: totalChars - chars - later * 300 - 32, bytes: totalBytes - bytes - later * 1024 - 32 }
        const result = remaining.chars < 512 || remaining.bytes < 2048
          ? { output: 'READ_BATCH_OUTPUT_LIMIT: 本项未读取，请单独read_file', isError: true }
          : item && typeof item === 'object' && !Array.isArray(item) ? readOne(item as Record<string, unknown>, remaining)
          : { output: 'READ_BATCH_ITEM_INVALID', isError: true }
        // Invalid paths/inputs may be long too; retain bounded errors, never content truncation without a continuation.
        if (result.isError) result.output = result.output.slice(0, 256)
        results.push(result); chars += result.output.length + 20; bytes += Buffer.byteLength(result.output) + 20
      }
      return { output: results.map((result, index) => `--- [${index + 1}] ${result.isError ? 'ERROR' : 'OK'} ---\n${result.output}`).join('\n'),
        isError: results.some(r => r.isError), detail: { results: results.map((result, index) => ({ index, is_error: Boolean(result.isError), ...result.detail })) } }
    },
  }

  const list_files: AgentLoopTool = {
    name: 'list_files',
    parallelSafe: true,
    description: '分页列出项目源码文件，默认200条；cursor续页。静态项目深度≤4，software项目深度≤48；基础设施/符号链接不遍历，不将范围清单当依赖安装证明。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '子目录相对路径（缺省列出整个项目）' }, cursor: { type: 'string', description: '上次next_cursor' } },
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      let subDir = ''
      if (typeof toolInput.path === 'string' && toolInput.path.trim() && !['.', './'].includes(toolInput.path.trim().replaceAll('\\', '/'))) {
        const resolved = resolveInsideProject(projectRoot(), toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      const scope = { files: 0, depthLimited: 0, unreadable: 0 }
      const files = collectProjectFiles(projectRoot(), subDir, options.software, scope)
      // R0.2（2026-09-19 狗粮 7601e5ae）：平台托管目录不再伪装成「空目录」——模型据
      // 「目录为空」误判 express 未 vendor、白白零依赖重写；如实说明托管与供货保证。
      const topDir = subDir.split('/')[0]
      if (topDir && SKIPPED_DIRS.has(topDir)) {
        const managed = topDir === 'node_modules'
          ? options.software ? 'node_modules 从源文件清单隐藏；依赖是否可用需查看package.json并实际运行，使用包管理器安装，不直接手改依赖源码' : 'node_modules 由平台托管（vendor 供货已保证 express 等依赖可用），不在产物清单中，也不允许直接修改'
          : `${topDir}/ 是平台基础设施目录，不在产物清单中`
        return { output: `${managed}。不要据此判断依赖缺失：判断依赖声明请读 package.json（如存在）。` }
      }
      const result = pageFileNames(files, toolInput, `list:${projectRoot()}:${subDir}:${Boolean(options.software)}`, LIST_ENTRY_LIMIT)
      result.detail = { ...result.detail, complete_scope: !scope.depthLimited && !scope.unreadable, depth_limited_directories: scope.depthLimited, unreadable_directories: scope.unreadable }
      result.output += `\n（清单范围：深度≤${options.software ? 48 : LIST_DEPTH_LIMIT}，不遍历基础设施和符号链接；子目录不可读时可能缺项）`
      return result
    },
  }

  const grep: AgentLoopTool = {
    name: 'grep', parallelSafe: true,
    description: '搜索项目文本，直接返回file:line及命中内容。支持literal/ignore_case、path子目录或文件、glob（*、**、?）、context（0~5）、files_only、limit和cursor续页；返回范围不完整/截断说明。正则采用JS语义，不支持的glob明确报错。',
    input_schema: { type: 'object', required: ['pattern'], properties: {
      pattern: { type: 'string', minLength: 1, maxLength: 1000 }, glob: { type: 'string' }, path: { type: 'string' },
      literal: { type: 'boolean' }, ignore_case: { type: 'boolean', description: '默认true' },
      context: { type: 'integer', minimum: 0, maximum: 5 }, files_only: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 200 }, max_chars: { type: 'integer', minimum: 1024, maximum: 24000 }, cursor: { type: 'string' },
    } },
    execute: async (input, ctx) => {
      ctx.signal.throwIfAborted()
      const root = projectRoot()
      let subDir = '', explicit: string | undefined
      if (input.path !== undefined && input.path !== '.' && input.path !== './') {
        const resolved = resolveInsideProject(root, input.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        if (!existsSync(resolved.abs)) return { output: 'SEARCH_PATH_NOT_FOUND', isError: true }
        if (statSync(resolved.abs).isFile()) explicit = resolved.rel
        else subDir = resolved.rel
      }
      const scope = { files: 0, depthLimited: 0, unreadable: 0 }
      const files = explicit ? [explicit] : collectProjectFiles(root, subDir, options.software, scope)
      const result = searchProjectFiles(root, files, input, scope)
      result.output += `\n（搜索范围：深度≤${options.software ? 48 : LIST_DEPTH_LIMIT}，不遍历基础设施和符号链接）`
      return result
    },
  }

  const write_file: AgentLoopTool = {
    name: 'write_file',
    description:
      '把完整文件内容写入项目（整文件覆盖）。参数：path（项目内相对路径）、content（全文）。写入前会做语法/结构校验，校验不过会拒绝写入并返回错误定位。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, pattern: '\\S', description: '项目内相对路径（如 index.html、src/app.js）' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
    execute: async (toolInput, ctx) => {
      if (typeof toolInput.content !== 'string') return { output: '缺少 content 参数（文件完整内容）。', isError: true }
      // 费用守卫 Hook 3（usage-guard，2026-08-28）：超大单次写入预拦截——整文件覆盖语义下
      // 一次写 16k+ token 内容通常意味着失控（上下文爆掉才失败的预防线），当场引导分块。
      const estTokens = estimateTokenCount(toolInput.content)
      if (decideWrite(toolInput.content) === 'chunk') {
        return {
          output: `单次写入内容过大（约 ${estTokens} tokens，阈值 16000）。请拆分为多次写入：先写骨架文件，再用 edit_file 逐段补充内容。`,
          isError: true,
          detail: { est_tokens: estTokens, threshold: 16000 },
        }
      }
      const project = findProject(projectId)
      const resolved = resolveInsideProject(projectRoot(), toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      // W4-F2：授权边界门（仅修复轮传入 writeScope 时生效；主 loop 无 holder 零变化）
      const writeScopeBlocked = guardWriteScope(resolved.rel)
      if (writeScopeBlocked) return writeScopeBlocked
      // D4a：write 守卫——覆盖「本轮未读过的既有文件」拦截（R-FILE-01 工具化；
      // 2026-10-02 全链路审查 P1-4 无条件化：缺省 on，BLOMA_WRITE_GUARD=0/false 逃生口）。
      // 新建文件不受影响；**本来就禁止写的路径跳过守卫**直接走边界拒绝——对只读/
      // 系统路径提示「先读再写」是错误指引（边界优先，2026-10-02）。
      if (isWritablePath(resolved.rel, realVariant) && existsSync(resolved.abs) && !fileRevisionsOf(ctx).has(resolved.rel)) {
        if (writeGuardEnabled()) {
          return {
            output: `目标文件已存在且本轮未读取过：${resolved.rel}。先 read_file 获取当前内容（R-FILE-01），再决定 edit_file 精确修改或基于读取结果重写；禁止盲覆盖。`,
            isError: true,
            detail: { code: 'WRITE_UNREAD_TARGET', path: resolved.rel },
          }
        }
      }
      // 修复预算门在 validateAndWrite 内（校验通过后才烧预算）
      return validateAndWrite(projectRoot(), resolved.rel, toolInput.content, ctx)
    },
  }

  const editBatchItem = { type: 'object', additionalProperties: false, required: ['path', 'edits'], properties: {
    path: { type: 'string', minLength: 1 }, expected_revision: { type: 'string' },
    edits: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['old_string', 'new_string'], properties: {
      old_string: { type: 'string', minLength: 1 }, new_string: { type: 'string' },
    } } },
  } }
  const edit_file: AgentLoopTool = {
    name: 'edit_file',
    description:
      editFormat === 'diff'
        ? '精确替换：path+old_string+new_string，或path+edits数组（1~32处）。所有edits基于同一原文，重叠/歧义整批拒绝，一次校验写入；批量必须先read_file取得内容hash。可传expected_revision防止旧版本写入。files支持最多8文件：先全部预检，再有序应用；非原子，失败即停止、返回逐文件已应用/失败/未尝试，不回滚他人修改。'
        : '整文件重写修改：提供 path + content（修改后的完整文件内容）。写入前会做语法校验。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, pattern: '\\S', description: '项目内相对路径' },
        files: { type: 'array', minItems: 1, maxItems: 8, items: editBatchItem },
        old_string: { type: 'string', description: '（diff 模式）要替换的唯一原文片段' },
        new_string: { type: 'string', description: '（diff 模式）替换后的内容' },
        content: { type: 'string', description: '（whole 模式）修改后的完整文件内容' },
        expected_revision: { type: 'string', description: 'read_file返回的内容hash；旧单片段仍兼容stat版本，批量只接受hash' },
        edits: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['old_string', 'new_string'], properties: {
          old_string: { type: 'string', minLength: 1 }, new_string: { type: 'string' },
        } } },
      },
      anyOf: [{ required: ['path', 'old_string', 'new_string'] }, { required: ['path', 'edits'] }, { required: ['path', 'content'] }, { required: ['files'] }],
    },
    execute: async (toolInput, ctx) => {
      if (toolInput.files !== undefined) {
        if (toolInput.path !== undefined || toolInput.edits !== undefined || toolInput.content !== undefined || toolInput.old_string !== undefined || toolInput.new_string !== undefined || toolInput.expected_revision !== undefined
          || !Array.isArray(toolInput.files) || !toolInput.files.length || toolInput.files.length > 8) return { output: 'EDIT_MULTI_INVALID: files含1~8文件，与单文件参数二选一', isError: true }
        if (decideWrite(JSON.stringify(toolInput.files)) === 'chunk') return { output: 'EDIT_MULTI_TOO_LARGE', isError: true }
        const root = projectRoot(), seen = new Set<string>()
        const prepared: Array<{ rel: string; revision: string; content: string }> = []
        const results: Array<{ path: string; state: string; error?: string; revision?: string }> = []
        for (const raw of toolInput.files) {
          let path = '?'
          try {
            ctx.signal.throwIfAborted()
            if (!raw || typeof raw !== 'object') throw Error('EDIT_MULTI_ITEM_INVALID')
            const item = raw as Record<string, unknown>; path = String(item.path ?? '?')
            if (Object.keys(item).some(key => !['path', 'expected_revision', 'edits'].includes(key))) throw Error('EDIT_MULTI_ITEM_ARGUMENT_INVALID')
            const resolved = resolveInsideProject(root, item.path)
            if (!resolved.ok) throw Error(resolved.error)
            const key = process.platform === 'win32' ? resolved.rel.toLowerCase() : resolved.rel
            if (seen.has(key)) throw Error('EDIT_MULTI_DUPLICATE_PATH'); seen.add(key)
            const denied = guardWriteScope(resolved.rel); if (denied) throw Error(denied.output)
            options.assertFileWrite?.(resolved.rel, ctx)
            if (!isWritablePath(resolved.rel, realVariant)) throw Error(notWritableError(resolved.rel, realVariant))
            const revision = typeof item.expected_revision === 'string' ? item.expected_revision : fileRevisionsOf(ctx).get(resolved.rel)
            if (!revision || !/^[0-9a-f]{64}$/.test(revision)) throw Error('CONTENT_REVISION_REQUIRED')
            if (!Array.isArray(item.edits) || !item.edits.length || item.edits.length > 32 || item.edits.some(e => !e || typeof e !== 'object'
              || typeof e.old_string !== 'string' || !e.old_string || typeof e.new_string !== 'string')) throw Error('EDIT_BATCH_INVALID')
            const bytes = readFileSync(resolved.abs)
            if (contentRevision(bytes) !== revision) throw Error('STALE_READ')
            const next = replaceMultipleTexts(bytes.toString('utf8'), item.edits as TextEdit[])
            if (!next.ok) throw Error(`${next.code}: item ${next.index + 1}`)
            const checked = await validateAndWrite(root, resolved.rel, next.content, ctx, revision, { preflightOnly: true })
            if (checked.isError || checked.budgetExhausted) throw Error(checked.output)
            prepared.push({ rel: resolved.rel, revision, content: next.content })
            results.push({ path: resolved.rel, state: 'prechecked' })
          } catch (error) { results.push({ path, state: 'preflight_failed', error: String(error).slice(0, 1200) }) }
        }
        if (results.some(result => result.state !== 'prechecked')) return { output: JSON.stringify({ code: 'EDIT_MULTI_PREFLIGHT_FAILED', atomic: false, applied: [], results }), isError: true }
        const applied: string[] = []
        const changes: ToolFileChange[] = []
        for (const [index, item] of prepared.entries()) {
          try {
            const outcome = await validateAndWrite(root, item.rel, item.content, ctx, item.revision, { syntaxChecked: true })
            if (outcome.isError || outcome.budgetExhausted) throw Error(outcome.output)
            const display = outcome.detail?.display as { files?: ToolFileChange[] } | undefined
            changes.push(...(display?.files ?? []))
            applied.push(item.rel); results[index] = { path: item.rel, state: 'applied', revision: fileRevisionsOf(ctx).get(item.rel) }
          } catch (error) {
            results[index] = { path: item.rel, state: 'failed', error: String(error).slice(0, 1200) }
            for (let rest = index + 1; rest < results.length; rest++) results[rest].state = 'not_attempted'
            return { output: JSON.stringify({ code: 'EDIT_MULTI_PARTIAL', atomic: false, applied, results }), isError: true, detail: { display: changes.length ? {version:1,kind:'changes',files:changes} : undefined } }
          }
        }
        return { output: JSON.stringify({ code: 'EDIT_MULTI_APPLIED', atomic: false, applied, results }), detail: { paths: applied, display: changes.length ? {version:1,kind:'changes',files:changes} : undefined } }
      }
      const project = findProject(projectId)
      const resolved = resolveInsideProject(projectRoot(), toolInput.path)
      if (!resolved.ok) return { output: resolved.error, isError: true }
      // W4-F2：授权边界门（仅修复轮传入 writeScope 时生效；主 loop 无 holder 零变化）
      const writeScopeBlocked = guardWriteScope(resolved.rel)
      if (writeScopeBlocked) return writeScopeBlocked

      // D4a：版本前置校验（可选参数，提供即校验——把 R-FILE-01 从「prompt 劝说」
      // 升级为「工具强制」；不传零变化，向后兼容）。文件不存在时跳过（后续分支自有报错）。
      if (
        typeof toolInput.expected_revision === 'string' &&
        existsSync(resolved.abs)
      ) {
        const currentRev = fileRevisionOf(resolved.abs)
        if (!fileRevisionMatches(resolved.abs, toolInput.expected_revision)) {
          return {
            output: `STALE_READ：${resolved.rel} 在你读取后已被修改（读时版本 ${toolInput.expected_revision}，当前 ${currentRev}）。请重新 read_file 后再编辑，禁止凭旧内容修改。`,
            isError: true,
            detail: { code: 'STALE_READ', path: resolved.rel },
          }
        }
      }

      if (toolInput.edits !== undefined) {
        if (toolInput.old_string !== undefined || toolInput.new_string !== undefined || toolInput.content !== undefined || !Array.isArray(toolInput.edits)
          || !toolInput.edits.length || toolInput.edits.length > 32 || toolInput.edits.some(e => !e || typeof e !== 'object'
            || typeof e.old_string !== 'string' || !e.old_string || typeof e.new_string !== 'string')) {
          return { output: 'EDIT_BATCH_INVALID: edits含1~32个old_string/new_string，与单片段/content二选一', isError: true }
        }
        const revision = typeof toolInput.expected_revision === 'string' ? toolInput.expected_revision : fileRevisionsOf(ctx).get(resolved.rel)
        if (!revision || !/^[0-9a-f]{64}$/.test(revision)) return { output: 'CONTENT_REVISION_REQUIRED: 批量编辑前先read_file取得内容hash', isError: true }
        if (!fileRevisionMatches(resolved.abs, revision)) return { output: 'STALE_READ: 内容已改变或被删除，请重新读取', isError: true }
        if (decideWrite(JSON.stringify(toolInput.edits)) === 'chunk') return { output: 'EDIT_BATCH_TOO_LARGE: 请减少片段大小或分批处理', isError: true }
        const current = readFileSync(resolved.abs)
        if (contentRevision(current) !== revision) return { output: 'STALE_READ: 内容在读取时改变', isError: true }
        const result = replaceMultipleTexts(current.toString('utf8'), toolInput.edits as TextEdit[])
        if (!result.ok) return { output: `${result.code}: 第${result.index + 1}项校验失败（命中${result.matches >= 2 ? '至少' : ''}${result.matches}处，要求唯一且不重叠）；未写入任何片段`, isError: true }
        return validateAndWrite(projectRoot(), resolved.rel, result.content, ctx, revision)
      }

      // whole 模式：无 old_string，走整文件重写（弱渠道能力位）。
      // m-11：与 write_file 同口径的 16k 预拦截——整文件重写语义与 write_file 同构，
      // 绕过预拦截会让费用守卫在弱渠道（whole 模式）上失效
      if (typeof toolInput.old_string !== 'string') {
        if (typeof toolInput.content !== 'string') {
          return { output: '缺少参数：diff 模式需要 old_string + new_string，whole 模式需要 content。', isError: true }
        }
        const estTokens = estimateTokenCount(toolInput.content)
        if (decideWrite(toolInput.content) === 'chunk') {
          return {
            output: `单次写入内容过大（约 ${estTokens} tokens，阈值 16000）。请拆分为多次写入：先写骨架文件，再分段替换补充内容。`,
            isError: true,
            detail: { est_tokens: estTokens, threshold: 16000 },
          }
        }
        return validateAndWrite(projectRoot(), resolved.rel, toolInput.content, ctx)
      }

      // diff 模式：new_string 必须显式提供（可为空串但不能缺省，缺省静默删除是隐蔽 bug）
      if (typeof toolInput.new_string !== 'string') {
        return { output: '缺少参数：diff 模式需要 old_string + new_string（new_string 可为空串，但不能缺省）。', isError: true }
      }

      // diff 模式：old_string 唯一命中才替换（SWE-agent ACI：未命中/多命中都报错并引导定点）
      if (!existsSync(resolved.abs)) {
        return { output: `文件不存在：${resolved.rel}。先用 write_file 创建，或 list_files 确认路径。`, isError: true }
      }
      const current = readFileSync(resolved.abs, 'utf8')
      const replacement = replaceUniqueText(current, toolInput.old_string, toolInput.new_string)
      if (!replacement.ok) {
        return { output: replacement.matches === 0
          ? `old_string 在 ${resolved.rel} 中未命中。请先 read_file 定点（注意空白与引号须逐字一致）。`
          : `old_string 在 ${resolved.rel} 中命中至少 ${replacement.matches} 处，不唯一。请扩大上下文使片段唯一。`, isError: true }
      }
      const next = replacement.content
      // P1-06：模型显式 expected_revision 优先；未传时用本会话读到的版本作提交点校验基准
      const revisionBasis = typeof toolInput.expected_revision === 'string' ? toolInput.expected_revision : fileRevisionsOf(ctx).get(resolved.rel) ?? contentRevision(current)
      return validateAndWrite(projectRoot(), resolved.rel, next, ctx, revisionBasis)
    },
  }

  /** W3（Phase 10，同步 Proma find）：glob 文件名搜索——list_files 看目录、grep 挖内容，
   *  find 按模式定位文件（星号单段、双星跨目录，如所有 js 或 game-前缀模块）。只读并行五件套同档。 */
  const find: AgentLoopTool = {
    name: 'find',
    parallelSafe: true,
    description:
      '按 glob 模式搜索项目文件名（如 "src/**/*.js"、"*.css"），返回相对路径（最多 100 条）。支持 * 单段通配与 ** 跨目录通配；路径匹配不区分大小写（Windows 语义）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 src/**/*.js 或 *.html' },
        path: { type: 'string', description: '限定搜索的子目录（可选，缺省全项目）' },
        cursor: { type: 'string', description: '上次next_cursor' },
      },
      required: ['pattern'],
    },
    execute: async (toolInput) => {
      const project = findProject(projectId)
      const pattern = String(toolInput.pattern ?? '').trim()
      if (!pattern) return { output: '缺少 pattern 参数（glob 模式，如 src/**/*.js）。', isError: true }
      let subDir = ''
      if (typeof toolInput.path === 'string' && toolInput.path.trim() && !['.', './'].includes(toolInput.path.trim().replaceAll('\\', '/'))) {
        const resolved = resolveInsideProject(projectRoot(), toolInput.path)
        if (!resolved.ok) return { output: resolved.error, isError: true }
        subDir = resolved.rel
      }
      let matcher: RegExp
      try { matcher = compileFileGlob(pattern) } catch (error) { return { output: String(error), isError: true } }
      const scope = { files: 0, depthLimited: 0, unreadable: 0 }
      const hits = collectProjectFiles(projectRoot(), subDir, options.software, scope).filter((rel) => matcher.test(pattern.includes('/') ? rel : rel.split('/').at(-1)!))
      if (hits.length === 0 && toolInput.cursor === undefined) {
        // R0.2：命中不了平台托管目录（node_modules 等）时如实说明，防「找不到 = 不存在」误判
        const targetsManaged = [pattern, subDir].some((seg) => seg && seg.split('/').includes('node_modules'))
        const managedNote = targetsManaged
          ? options.software ? '\n注：node_modules 不出现在源码清单中；请查看package.json并实际运行确认依赖，不将无匹配当作依赖可用或不可用的证据。' : '\n注：node_modules 由平台托管（vendor 供货已保证 express 等依赖可用），不出现在文件清单中——无匹配不等于依赖缺失，请勿据此改用零依赖实现。'
          : ''
        return { output: `无匹配文件（模式 ${pattern}${subDir ? `，目录 ${subDir}/` : ''}）。可用 list_files 查看实际文件清单。${managedNote}` }
      }
      const result = pageFileNames(hits, toolInput, `find:${projectRoot()}:${subDir}:${pattern}:${Boolean(options.software)}`, FIND_ENTRY_LIMIT)
      result.detail = { ...result.detail, complete_scope: !scope.depthLimited && !scope.unreadable, depth_limited_directories: scope.depthLimited, unreadable_directories: scope.unreadable }
      result.output += `\n（清单范围：深度≤${options.software ? 48 : LIST_DEPTH_LIMIT}，不遍历基础设施和符号链接；子目录不可读时可能缺项）`
      return result
    },
  }

  if (role === 'explore' || role === 'research') {
    // 只读角色：探索/调研不需要写文件或跑测试，但可查公网资料、可向主 agent 冒泡提问
    return [read_file, list_files, find, grep, buildWebFetch(), ...buildDelegationTools(role)]
  }

  if (role === 'review') {
    // 审查角色（m-12）：话术承诺「不直接修改」，工具面同步收窄——去掉 write_file/
    // edit_file（物理只读与话术一致，防提示词层面被诱导后真的落盘）；可跑预览/测试/
    // 扫描验证怀疑点，但不改产物
    return [read_file, list_files, find, grep, buildWebFetch(), ...buildDelegationTools(role)]
  }
  if (role !== 'parent') {
    // 子 agent（implement/custom）：通用件+ask 冒泡；领域验证面由 buildDomainTools 拼接（PR4c）
    return [
      read_file,
      list_files,
      find,
      grep,
      buildWebFetch(),
      write_file,
      edit_file,
      ...buildDelegationTools(role),
    ]
  }
  return [
    read_file,
    list_files,
    find,
    grep,
    buildWebFetch(),
    write_file,
    edit_file,
    ...buildDelegationTools('parent'),
    buildWebResearch(projectId),
  ]
}


export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 可选毫秒数：非有效数字返回 undefined（让 waitForDelegations 用内置缺省超时）。 */
/** 委派摘要的可读列表（模型视角）：id / role / status，completed 附结果摘要前 200 字，失败附错误。 */
