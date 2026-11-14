import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { collectUsage } from '../../token monitor/usage'
import { addFindings, LocalAudit } from '../../token monitor/audit'

describe('token request audit', () => {
  it('links tool evidence by ID, keeps transport retry separate, and reuses valid local classifications', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bloma-token-audit-'))
    try {
      const ledger = join(home, 'usage-ledger')
      const sessions = join(home, 'agent-sessions')
      await mkdir(ledger)
      await mkdir(sessions)
      const base = { version: 1, query_id: 'q1', project_id: 'p1', session_id: 's1', run_id: 'm1', phase: 'production' }
      const started = '2026-11-14T08:01:01.000Z'
      const finished = '2026-11-14T08:01:04.000Z'
      const jsonl = (value: unknown[]) => value.map(item => JSON.stringify(item)).join('\n') + '\n'
      await writeFile(join(ledger, 'p1.jsonl'), jsonl([
        { ...base, event: 'query_started', at: started },
        { ...base, event: 'transport_response', at: started, transport_index: 1, response: { status: 503 } },
        { ...base, event: 'transport_finished', at: started, transport_index: 1, status: 'failed' },
        { ...base, event: 'query_finished', at: finished, status: 'completed', audit_tool_ids: ['tool-a'], usage: { input_tokens: 90, output_tokens: 10 } },
      ]))
      const user = { id: 'm1', role: 'user', timestamp: Date.parse(started) - 50, content: '修复页面' }
      const reply = { role: 'assistant', timestamp: Date.parse(finished) + 1000,
        content: [{ type: 'tool_use', id: 'tool-a', name: 'edit_file', input: { path: 'public/app.js' } }] }
      const result = { role: 'user', origin: 'system', timestamp: Date.parse(finished) + 1100,
        content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: '目标片段不存在', is_error: true }] }
      await writeFile(join(sessions, 's1.jsonl'), jsonl([user, reply, result]))
      const data = await collectUsage(home)
      expect(data.rows).toHaveLength(1)
      expect(data.rows[0]).toMatchObject({
        turn: ['p1', 's1', 'm1'], counts: { uncached: 90, output: 10 },
        retries: [{ index: 1, status: 'failed', http: 503 }],
        evidence: { source: 'id', failure: '', tools: [{ name: 'edit_file', target: 'public/app.js', result: '目标片段不存在', state: 'failed' }] },
      })
      const request = vi.fn(async (url: string, options?: RequestInit) => {
        expect(new URL(url).origin).toBe('http://127.0.0.1:11434')
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3.5:9b' }, { name: 'qwen3.5:cloud' }] })
        expect(options?.redirect).toBe('error')
        return Response.json({ message: { content: JSON.stringify({ items: [
          { id: 1, category: 'frontend', outcome: 'failed', purpose: '修复页面', result: '目标片段不存在' },
        ] }) } })
      })
      const audit = new LocalAudit(home, request)
      expect(await audit.batch({ project: 'p1' })).toEqual({ model: 'qwen3.5:9b', processed: 1, remaining: 0 })
      addFindings(home, data.rows)
      expect(data.rows[0].finding).toMatchObject({ category: 'frontend', outcome: 'failed' })
      expect((await audit.batch({ project: 'p1' })).processed).toBe(0)
      expect(request.mock.calls.filter(([url]) => url.endsWith('/api/chat'))).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
