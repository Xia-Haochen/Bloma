import { existsSync, readFileSync } from 'node:fs'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { guiSuitePath, parseGuiSuite } from '../desktop/gui-acceptance'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { closeDebugSessions } from './debug-sessions'
import { stopSoftwareSession, redactSoftwareOutput, activeSoftwareCommands } from './process-manager'
import { verifySoftwareCandidate } from './verification'
import { registerNativeGuiTests } from './native-gui-registration'
import { findProject } from '../project/project-service'
import { requireLaunchDeclaration } from '../desktop/launch-smoke'
import { verificationFailure } from './verification-diagnostics'
import { readPrdBackplane } from '../project/prd-store'
import { assertSoftwareDelivery } from './launch-contract'
import { verificationReportView,verificationToolFeedback,verificationToolReport } from './verification-report'

export function buildSoftwareVerifyTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void): AgentLoopTool {
  return { name: 'verify_app', description: '验收当前软件：script导出async({test,page,expect,assert,dataDir,evidenceDir,phase})，test使用node:test，业务案例名标注单个F编号。宿主先检查入口和测试依赖，仅封存入口实际引用的模块/夹具，保留相对路径；动态资产可用脚本同目录native-inputs.json的files列出工程相对路径。无关开发探针不冻结，开发测试可用inspect_app自由调试。正式预期保留，可追加检查、修定位和有界等待；未执行过的引导计划按宿主失败凭据修复并留痕，不得降低已执行的业务输入/断言。截图报告写evidenceDir；诊断截图失败单列告警，不能冒充视觉通过。reopened真实重开；通过证据绑定当前版本，不自行交付。',
    input_schema: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean', description: '只在确需强制重新实测时为true。' },
      script:{type:'string',description:'项目内应用测试，自动冻结并实际验收，无需动作表。使用参数提供的test(node:test API)、expect/assert和page；业务测试名包含单个需求F编号。'},restart:{type:'boolean',description:'按initial/reopened两次执行，实际关闭并重开应用；reopened分支也会自动识别。'} } },
    execute: async (input, ctx) => {
      let attempted=false
      try {
        policy.assertCommand(ctx)
        if (ctx.projectId !== projectId || input.force !== undefined && typeof input.force !== 'boolean') throw Error('SOFTWARE_VERIFY_INPUT_INVALID')
        const commands = activeSoftwareCommands(projectId, ctx.sessionId)
        if (commands.length) return { output: JSON.stringify({ code: 'COMMANDS_STILL_RUNNING', execution_status: 'running', commands,
          next: '先用read_process等待已有命令结果，再验收；宿主没有停止命令或冻结当前草稿。' }),
          feedback: { schema_version: 1, source: 'host', scope: 'command_wait', execution: 'running', verification: 'unverified', recovery: 'inspect' } }
        if(input.script===undefined&&input.restart!==undefined)throw Error('SOFTWARE_VERIFY_INPUT_INVALID: restart与script一起提供')
        const launch = requireLaunchDeclaration(findProject(projectId).root_path,'SOFTWARE_VERIFY_CONFIRMED_ENTRY_REQUIRED')
        assertSoftwareDelivery(readPrdBackplane(projectId), launch)
        if(input.script!==undefined){if(typeof input.script!=='string'||input.restart!==undefined&&typeof input.restart!=='boolean')throw Error('GUI_NATIVE_INPUT_INVALID');registerNativeGuiTests(projectId,input.script,input.restart===true)}
        await closeDebugSessions(projectId, ctx.sessionId); await stopSoftwareSession(projectId, ctx.sessionId); previewChanged?.()
        attempted=true
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, input.force === true)
        const failed = result.core?.host_gui?.steps.find(step => !step.passed)
        const suite = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined
        const step = suite?.steps.find(step => step.id === failed?.id)
        const expected = step?.kind === 'expect' || step?.kind === 'expect_file' ? { equals: step.equals, contains: step.contains, nonempty: step.nonempty } : undefined
        const reportView=verificationToolReport(projectId,result)
        return { output: redactSoftwareOutput(JSON.stringify({ status: result.status, summary: result.summary, failure: reportView.failure, evidence:reportView, reused: Boolean(result.reused),
          failed_step: failed ? { id: failed.id, selector: step && 'selector' in step ? step.selector : undefined, has_text: step?.has_text, expected, actual: typeof failed.actual === 'string' ? failed.actual.slice(0, 1600) : failed.actual } : undefined,
          cli: result.core?.host_cli ? { status: result.core.host_cli.status, error: result.core.host_cli.error,
            case_count:result.core.host_cli.cases.length,cases: reportView.cases.filter(row=>row.kind==='cli') } : undefined,
          cases: reportView.cases.filter(row=>row.kind==='gui'),
          case_count:result.core?.host_gui?.case_results?.length,requirements: result.core?.requirements?.slice(0,64), acceptance_evidence:result.core?.acceptance_evidence,verification_scope:'local_behavior_and_capability_contracts',
          issues: result.security?.issues.slice(0, 8), candidate_id: result.candidate?.id, report: result.report_path, evidence_dir: result.core?.host_gui?.evidence_dir,
          evidence_warnings: result.core?.host_gui?.evidence_warnings,
          independent:result.independent&&{status:result.independent.status,report:result.independent.report_path,semantics:result.independent.semantics,case_count:result.independent.case_results?.length,cases:reportView.cases.filter(row=>row.kind==='independent')},
          next: result.status === 'passed' ? '已登记的本机检查通过；read_quality_findings核对当前候选审阅缺口，按closeout补齐。审阅有效且无阻塞后结束制作，由宿主核对版本并交付；不为可延期建议继续改动。' : result.failure?.next ?? '按实际失败修复，再verify_app；不要降低已确认预期。' })),
          isError: result.status !== 'passed', feedback: verificationToolFeedback(result) }
      } catch (error) { const summary = String(error),result={status:'unverified' as const,summary};return { output: JSON.stringify({ summary,execution:attempted?'attempted_not_completed':'not_started', failure: verificationFailure(result, error),evidence:verificationReportView(result,{persisted:false}) }),feedback:{...verificationToolFeedback(result),execution:ctx.signal.aborted?'cancelled':attempted?'failed':'not_run'}, isError: true } }
    } }
}
