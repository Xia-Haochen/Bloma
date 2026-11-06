import {applyApprovedNativeCorrections} from './native-gui-registration'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { closeDebugSessions } from './debug-sessions'
import { stopSoftwareSession, redactSoftwareOutput, activeSoftwareCommands } from './process-manager'
import { verifySoftwareCandidate } from './verification'
import { registerNativeGuiTests } from './native-gui-registration'
import { findProject } from '../project/project-service'
import { requireLaunchDeclaration } from '../desktop/launch-smoke'
import { readPrdBackplane } from '../project/prd-store'
import { assertSoftwareDelivery } from './launch-contract'
import { verificationResponse,verificationToolFeedback } from './verification-report'

export function buildSoftwareVerifyTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void): AgentLoopTool {
  return { name: 'verify_app', description: '运行当前程序的正式检查。首次GUI验收提供script，导出async({test,page,expect,assert,dataDir,evidenceDir,phase})，案例名包含F编号；restart=true执行initial和reopened两次检查。之后无参数复验。业务输入和断言冻结，允许修复定位；协议细节按需读取read_production_context(topic=verification-gui)。按failure修复，通过后结束制作，宿主负责收尾。',
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
        applyApprovedNativeCorrections(projectId,ctx.signal)
        if(input.script!==undefined){if(typeof input.script!=='string'||input.restart!==undefined&&typeof input.restart!=='boolean')throw Error('GUI_NATIVE_INPUT_INVALID');registerNativeGuiTests(projectId,input.script,input.restart===true)}
        await closeDebugSessions(projectId, ctx.sessionId); await stopSoftwareSession(projectId, ctx.sessionId); previewChanged?.()
        attempted=true
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, input.force === true)
        return { output: redactSoftwareOutput(JSON.stringify(verificationResponse(projectId,result))),
          isError: result.status !== 'passed', feedback: verificationToolFeedback(result) }
      } catch (error) { const summary = String(error),result={status:'unverified' as const,summary};return { output: JSON.stringify({...verificationResponse(projectId,result,false,error),execution:attempted?'attempted_not_completed':'not_started'}),feedback:{...verificationToolFeedback(result),execution:ctx.signal.aborted?'cancelled':attempted?'failed':'not_run'}, isError: true } }
    } }
}
