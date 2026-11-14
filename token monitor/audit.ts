import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from '../storage/json-store'
import { collectUsage } from './usage'
import type { AuditFilter, AuditFinding, AuditProgress, ExchangeRate, UsageRow, UsageSnapshot } from '../shared/token-monitor'
import config from './audit-config.json'
import { failureSummary, hasFailure, hasUnreadableFailure, needsAudit, observedFailure, readableSummary } from './web/review.js'

type Transport = (url: string, options?: RequestInit) => Promise<Response>
const ollama = 'http://127.0.0.1:11434'
const cachePath = (home: string, row: UsageRow) => join(home, 'token-monitor', 'audit-v1', row.project, row.id + '.json')
const fingerprint = (row: UsageRow) => createHash('sha256').update(JSON.stringify([
  row.phase, row.status, row.evidence.text, row.evidence.source, row.evidence.failure,
  row.evidence.tools.map(tool => [tool.name, tool.target, tool.result, tool.state]),
])).digest('hex')
const outcome = (value: unknown): value is AuditFinding['outcome'] => typeof value === 'string' && Object.hasOwn(config.outcomes, value)
const category = (value: unknown): value is string => typeof value === 'string' && Object.hasOwn(config.categories, value)
const needsSummary = (row: UsageRow) => hasFailure(row) && !failureSummary(row)

export function addFindings(home: string, rows: UsageRow[]): void {
  for (const row of rows) {
    try {
      const finding = readJsonFile<AuditFinding | null>(cachePath(home, row), null)
      if (finding && finding.fingerprint === fingerprint(row) && category(finding.category) && outcome(finding.outcome)
        && typeof finding.model === 'string' && typeof finding.purpose === 'string' && typeof finding.result === 'string') row.finding = finding
    } catch { /* Incomplete or damaged audit cache is recomputed on request. */ }
  }
}

export async function installedModels(request: Transport): Promise<string[]> {
  const response = await request(ollama + '/api/tags', { signal: AbortSignal.timeout(5000), redirect: 'error' })
  if (!response.ok) throw new Error('Ollama HTTP ' + response.status)
  const data = await response.json() as { models?: { name?: string; remote_host?: string }[] }
  const names = (data.models ?? []).filter(model => !model.remote_host && model.name && !/cloud/i.test(model.name)).map(model => model.name!)
  return [...new Set([...config.preferredModels.filter(model => names.includes(model)), ...names])]
}

export class LocalAudit {
  private job: AuditProgress | null = null
  constructor(private readonly home: string, private readonly request: Transport) {}
  models() { return installedModels(this.request) }

  status(): AuditProgress | null { return this.job && { ...this.job } }

  start(filter: AuditFilter): AuditProgress {
    if (this.job?.state === 'running' || this.job?.state === 'stopping') throw new Error('本机审查正在运行')
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) ||
      [filter.start, filter.end].some(value => value !== undefined && !Number.isFinite(value)) ||
      (filter.mode !== undefined && filter.mode !== 'pending' && filter.mode !== 'all')) throw new Error('无效的审查参数')
    const job: AuditProgress = { state: 'running', model: filter.model || '', processed: 0, remaining: 0 }
    this.job = job
    void this.run(filter, job)
    return { ...job }
  }

  stop(): AuditProgress | null {
    if (this.job?.state === 'running') this.job.state = 'stopping'
    return this.status()
  }

  private async run(filter: AuditFilter, job: AuditProgress): Promise<void> {
    try {
      const { rows, turns } = await collectUsage(this.home)
      addFindings(this.home, rows)
      const eligible = (row: UsageRow) => needsSummary(row) || (!row.finding && (filter.mode === 'all' || needsAudit(row)))
      const pending = rows.filter(row => row.status !== 'running' && eligible(row)
        && (!filter.project || filter.project === row.project)
        && (filter.start === undefined || row.at >= filter.start) && (filter.end === undefined || row.at < filter.end))
      job.remaining = pending.length
      if (pending.length && job.state === 'running') {
        const models = await this.models()
        const model = filter.model || models[0]
        if (!model || !models.includes(model)) throw new Error('Ollama 未安装所选本地模型')
        job.model = model
        const subjects = new Map(turns.map(turn => [JSON.stringify([turn.project, turn.session, turn.id]), turn.request]))
        while (pending.length && job.state === 'running') {
          const selected = pending.splice(0, 8)
          // The standalone monitor shares this cache and may have written a result.
          addFindings(this.home, selected)
          const candidates = selected.filter(eligible)
          job.remaining -= selected.length - candidates.length
          if (!candidates.length) continue
          const deferred = await this.classify(candidates, model, subjects)
          job.processed += candidates.length - deferred.length
          job.remaining -= candidates.length - deferred.length
          pending.push(...deferred)
        }
      }
      job.state = job.remaining ? 'stopped' : 'completed'
    } catch (error) {
      job.state = 'error'
      job.error = error instanceof Error ? error.message : String(error)
    }
  }

  private async classify(selected: UsageRow[], model: string, subjects: Map<string, string>): Promise<UsageRow[]> {
    const input = selected.map((row, index) => ({
      id: index + 1, phase: row.phase, subject: subjects.get(JSON.stringify(row.turn)),
      explainFailure: hasFailure(row),
      observed: { text: row.evidence.text, failure: row.evidence.failure, retries: row.retries?.slice(0, 4),
        tools: [...row.evidence.tools.filter(tool => tool.state === 'failed'), ...row.evidence.tools.filter(tool => tool.state !== 'failed')]
          .slice(0, 4).map(({ diagnostic, ...tool }, position) => ({ ...tool, result: (diagnostic || tool.result).slice(0, position === 0 ? 480 : 120) })) },
    }))
    const response = await this.request(ollama + '/api/chat', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, format: 'json',
        options: { temperature: 0, num_ctx: 8192, num_predict: 2200 },
        messages: [{ role: 'system', content: config.system },
          { role: 'user', content: JSON.stringify({ categories: config.categories, outcomes: config.outcomes, requests: input }) }] }),
    })
    if (!response.ok) throw new Error('Ollama HTTP ' + response.status)
    const responseData = await response.json() as { message?: { content?: string } }
    const parsed: { items?: Record<string, unknown>[] } = JSON.parse(responseData.message?.content ?? '{}')
    const byId = new Map((Array.isArray(parsed.items) ? parsed.items : []).filter(item => item && typeof item === 'object')
      .map(item => [Number(item.id), item]))
    const deferred: UsageRow[] = []
    for (const [index, row] of selected.entries()) {
      const item = byId.get(index + 1)
      if (!item) { deferred.push(row); continue }
      const trim = (value: unknown) => typeof value === 'string' ? value.slice(0, 180) : ''
      addFindings(this.home, [row])
      const summary = failureSummary(row) || (hasUnreadableFailure(row) ? observedFailure(row) : readableSummary(item.failureSummary))
      if (needsSummary(row) && !summary) { deferred.push(row); continue }
      const finding = row.finding ?? (category(item.category) && outcome(item.outcome) ? {
        category: item.category, outcome: item.outcome, purpose: trim(item.purpose), result: trim(item.result), model, fingerprint: fingerprint(row),
      } : undefined)
      if (!finding) { deferred.push(row); continue }
      if (!row.finding || needsSummary(row)) writeJsonFile(cachePath(this.home, row), {
        ...finding, ...(hasFailure(row) && summary ? { failureSummary: summary, summaryModel: model } : {}),
      })
    }
    if (deferred.length === selected.length) throw new Error('本地模型没有返回有效分类，可重试或切换模型')
    return deferred
  }
}

export class Exchange {
  private current: ExchangeRate = config.fx
  private pending?: Promise<void>
  private readonly file: string
  constructor(home: string, private readonly request: Transport) {
    this.file = join(home, 'token-monitor', 'fx.json')
    try {
      const value = readJsonFile<ExchangeRate | null>(this.file, null)
      if (value && value.rate > 0 && Number.isFinite(value.rate) && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) this.current = value
    } catch { /* Use the bundled reference rate. */ }
  }
  snapshot(): UsageSnapshot['fx'] { return this.current }
  refresh() { return this.pending ??= this.update().finally(() => { this.pending = undefined }) }
  private async update() {
    try {
      const response = await this.request(config.fxUrl, { signal: AbortSignal.timeout(6500) })
      if (!response.ok) return
      const data = await response.json() as { date?: string; rates?: { CNY?: number } }
      const rate = data.rates?.CNY
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || !data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return
      this.current = { rate, date: data.date }
      writeJsonFile(this.file, this.current)
    } catch { /* Keep the last reference rate offline. */ }
  }
}
