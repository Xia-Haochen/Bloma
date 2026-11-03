import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { recordProjectActivity, projectActivityView } from '../../../main/software/project-activity'
import { recordEvaluationEvent } from '../../../main/software/harness-evaluation'
let home: string, old: string | undefined, id: string
beforeEach(() => { old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'project-activity-')); process.env.PROMA_HOME = home
  id = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }).project_id })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true }) })
it('records normal production without B enrollment and separates changed strategy segments', () => {
  for (const thinking of ['low', 'low', 'high']) recordEvaluationEvent(id, 'runtime_identity', { observation: { role: 'orchestrator', settings: { thinking } } })
  recordEvaluationEvent(id, 'delegation_started', { reason: 'inspect api_key=SECRET', max_children: 2 })
  const view = projectActivityView(id, 0, 2)
  expect(view.segment_count).toBe(2); expect(view.fixed_strategy_observed).toBe(false)
  expect(view.next_offset).toBe(2)
  expect(JSON.stringify(projectActivityView(id, 2))).not.toContain('SECRET')
  expect(view.provider_parameter_acceptance).toBe('unknown')
})
it('refuses corrupt evidence without overwriting it or returning an empty success history', () => {
  recordProjectActivity(id, 'started', {})
  const file = join(home, 'software-project-activity', id + '.json')
  writeFileSync(file, '{broken')
  expect(recordProjectActivity(id, 'done', {})).toBe(false)
  expect(() => projectActivityView(id)).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('{broken')
})
