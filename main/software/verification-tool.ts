import { serializeRedactedJson } from '../../shared/redacted-json'
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
import {existsSync,readFileSync} from 'node:fs'
import {guiSuitePath,parseGuiSuite} from '../desktop/gui-acceptance'
import {NativeTestContractError} from './native-gui-tests'
import {proposeTestTransaction} from './test-corrections'

export function buildSoftwareVerifyTool(projectId: string, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, previewChanged?: (url?: string) => void, beforeVerify?:(ctx:import('../agent/loop/agent-loop').ToolContext)=>Promise<void>): AgentLoopTool {
  return { name: 'verify_app', description: '运行当前程序的正式检查。首次用script登记GUI案例，后续修改程序或测试后无参数复验；宿主自动登记适配并审查需要裁定的测试修订。案例名含F编号，restart=true执行initial和reopened。保留已确认业务预期。按requirements、failure和quality处理具体待办，宿主负责交付。',
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
        await closeDebugSessions(projectId, ctx.sessionId); await stopSoftwareSession(projectId, ctx.sessionId); previewChanged?.()
        applyApprovedNativeCorrections(projectId,ctx.signal)
        const previous=existsSync(guiSuitePath(projectId))?parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId),'utf8'))).native_tests:undefined
        const script=input.script??(previous&&(previous.layout==='project'?previous.entry:previous.directory+'/'+previous.entry))
        if(script!==undefined){
          if(typeof script!=='string'||input.restart!==undefined&&typeof input.restart!=='boolean')throw Error('GUI_NATIVE_INPUT_INVALID')
          try{registerNativeGuiTests(projectId,script,input.restart===undefined?previous?.restart??false:input.restart===true)}
          catch(error){
            if(!(error instanceof NativeTestContractError)||!beforeVerify||!error.readOriginal||!error.correctionEntry)throw error
            proposeTestTransaction(projectId,{contract_digest:error.readOriginal.arguments.contract_digest,
              script:error.correctionEntry,reason:'verify_app发现当前测试修订，宿主核对确认预期、隔离执行并复验。'})
            await beforeVerify(ctx)
            applyApprovedNativeCorrections(projectId,ctx.signal)
            registerNativeGuiTests(projectId,script,input.restart===undefined?previous?.restart??false:input.restart===true)
          }
        }
        await beforeVerify?.(ctx)
        attempted=true
        const result = await verifySoftwareCandidate(projectId, ctx.requestId, ctx.signal, input.force === true)
        return { output: serializeRedactedJson(verificationResponse(projectId,result),redactSoftwareOutput),
          isError: result.status !== 'passed', feedback: verificationToolFeedback(result) }
      } catch (error) { const summary = String(error),result={status:'unverified' as const,summary};return { output: JSON.stringify({...verificationResponse(projectId,result,false,error),execution:attempted?'attempted_not_completed':'not_started'}),feedback:{...verificationToolFeedback(result),execution:ctx.signal.aborted?'cancelled':attempted?'failed':'not_run'}, isError: true } }
    } }
}
