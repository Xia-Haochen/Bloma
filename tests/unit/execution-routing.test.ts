import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject, updateProject } from '../../main/project/project-service'
import { createChannel, getFirstEnabledChannel } from '../../main/platform/llm/channel-manager'
import { resetCategoryRoutingForTests, updateCategoryRoutingRoles } from '../../main/platform/llm/category-routing'
import { runAgent } from '../../main/orchestration/stages/agent-dispatch'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { categoryForExecution } from '../../main/platform/llm/execution-routing'

const { production } = vi.hoisted(() => ({ production: vi.fn(async (_input: { env: Record<string, string> }) => {}) }))
vi.mock('../../main/desktop/lean-production', () => ({ runLeanProduction: production }))
vi.mock('../../main/orchestration/stages/sdk-glue', () => ({ sdkQuery: vi.fn(), streamPublisher: vi.fn() }))
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-routing-execution-')); vi.stubEnv('PROMA_HOME', home); resetCategoryRoutingForTests(); production.mockClear(); setSafeStorageAdapter({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`test:${value}`), decryptString: value => value.toString().replace(/^test:/, '') }) })
afterEach(() => { resetCategoryRoutingForTests(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

for (const stage of ['ready', 'completed'] as const) it(`uses the production role for ${stage} software edits, not the guide/default channel`, async () => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  updateProject(project.project_id, { current_stage: stage, template_type: 'desktop_tool' })
  const channels = ['guide-model', 'production-model'].map(name => createChannel({ name, provider_type: 'anthropic', api_key: 'offline-not-real', base_url: 'http://127.0.0.1:1', models: [{ id: name, name, enabled: true }] }))
  expect(getFirstEnabledChannel()?.id).toBe(channels[0].id)
  updateCategoryRoutingRoles({ guide: { channel_id: channels[0].id }, programming: { channel_id: channels[1].id } })
  await runAgent({ request_id: stage, session_id: `session-${stage}`, project_id: project.project_id,
    current_stage: 'clarifying', mode: 'quick', content: '增加导出按钮' })
  expect(production).toHaveBeenCalledTimes(1)
  expect(production.mock.calls[0]?.[0]).toMatchObject({ env: { ANTHROPIC_MODEL: 'production-model' } })
})

it('retains ordinary guide-stage resolution before the production executor is active', () => {
  expect(categoryForExecution({ template_type: 'desktop_tool', workflow_version: 'software-v1', current_stage: 'clarifying' })).toBe('guide')
  expect(categoryForExecution({ template_type: 'desktop_tool', workflow_version: 'software-v1', current_stage: 'generating_sketch' })).toBe('sketch')
})
