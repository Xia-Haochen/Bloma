import type {AgentLoopTool} from '../agent/loop/agent-loop'
import {findProject} from '../project/project-service'
import {executeSoftwareCommand} from './command-runtime'
import {projectRuntimeRequest} from './runtime-manager'
import {runtimeBindingVersion,managedRuntime} from './runtime-bindings'
import {hostElectronDistribution} from './electron-runtime'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {inspectProjectDependencies} from './dependency-state'
import {NATIVE_GUI_UI,declaredEntryFacts} from '../desktop/launch-smoke'

export function buildSoftwareEnvironmentTool(projectId: string): AgentLoopTool {
  let known: unknown
  let version: string | undefined
  return { name: 'inspect_software_environment', description: '实际检查Node/npm/Python/Electron版本及当前可用的交付观察器。默认复用本轮结果；refresh仅在工具环境改变后使用。npm CLI随Bloma提供；实际运行时缺失时如实返回，不让用户选择工程技术细节。',
    input_schema: { type: 'object', properties: { refresh: { type: 'boolean' } } }, execute: async (input, ctx) => {
      if (ctx.projectId !== projectId) return { output: 'ENVIRONMENT_PROJECT_MISMATCH', isError: true }
      const root = findProject(projectId).root_path, constraints = { node: projectRuntimeRequest(root, 'node'), python: projectRuntimeRequest(root, 'python'), electron: projectRuntimeRequest(root, 'electron') }
      const current = JSON.stringify([constraints, runtimeBindingVersion(projectId)])
      if (!known || input.refresh === true || version !== current) {
        const probes = await Promise.allSettled(['node', 'npm', 'python', 'electron'].map(executable => executeSoftwareCommand({ root, projectId,
          command: [executable, '--version'], timeoutMs: 10000, signal: ctx.signal })))
        known = { project_constraints: constraints,
          preparation: '需要缺失/不同版本时使用prepare_software_environment；它准备本项目运行时，不改系统环境。已有版本可用时不必下载。', tools: Object.fromEntries(probes.map((result, i) => [['node', 'npm', 'python', 'electron'][i], result.status === 'fulfilled'
          ? { available: result.value.code === 0, output: result.value.stdout.trim(), error: result.value.stderr.trim() }
          : { available: false, error: String(result.reason) }])),
          gui_observers: ['Electron正常入口+持续DOM操作+重开', '本机浏览器服务+持续DOM操作+重开'],
          native_js_observers:NATIVE_GUI_UI,
          development_state: 'inspect_app暂停后保留本任务开发数据和浏览器存储，下一次操作自动重开；正式验收另用全新隔离数据。',
          temporary_observation: '负责人已有inspect_app(script_source)可在隔离诊断目录执行临时观察，不必为观察改动稳定候选；正式验收仍使用登记脚本。',
          cli_observer: '正常入口的固定参数/实际stdout/退出码；Node/Python等不要求Python包装器',
          execution_boundary: '受管理的项目执行环境，不是OS沙箱；上游渠道密钥不传入命令环境' }
        version = current
      }
      // Dependency files change during implementation; do not cache their state
      // alongside the relatively stable runtime version probes.
      let electron:unknown
      try { const bound=managedRuntime(projectId,'electron'),host=hostElectronDistribution()
        electron={project_binding:bound?{version:bound.version,source:bound.source,executable:bound.executable,integrity:'full_distribution_verified',directory_sha256:bound.directory_sha256}:null,
          host_distribution:host?{directory:host,version:readFileSync(join(host,'version'),'utf8').trim(),integrity:'not_probed',scope:'available_for_explicit_compatible_preparation'}:null}
      } catch(error) { electron={available:false,error:String(error)} }
      return { output: JSON.stringify({ ...known as object, electron,declared_entry:declaredEntryFacts(root),dependencies: inspectProjectDependencies(root) }) }
    } }
}
