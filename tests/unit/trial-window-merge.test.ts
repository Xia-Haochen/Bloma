import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mergeTrialWindows } from '../../scripts/merge-trial-windows'
import { acquireMonetaryEpoch, activateMonetaryPolicy } from '../../main/platform/llm/monetary-epoch'
const roots: string[] = [], old = process.env.BLOMA_MONETARY_EPOCH_DIR
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); if (old === undefined) delete process.env.BLOMA_MONETARY_EPOCH_DIR; else process.env.BLOMA_MONETARY_EPOCH_DIR = old })
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'trial-merge-')); roots.push(root)
  for (const [id, cap] of [['', 10], ['extra', 5]] as const) {
    const suffix = id ? '-' + id : '', path = join(root, `monetary-policy${suffix}.json`)
    const rate = { host: 'example.test', model: 'model', cap_rmb: cap, context_tokens: 100, input_rmb_per_million: 2, output_rmb_per_million: 8, cache_rmb_per_million: .04 }
    const bytes = JSON.stringify({ version: 1, models: [rate] }); writeFileSync(path, bytes)
    writeFileSync(path + '.state.json', JSON.stringify({ version: 1, policy_hash: hash(bytes), entries: [{ id: id || 'first', host: rate.host, model: rate.model, status: 'reported', charged_micro_rmb: cap * 100000, reserved_micro_rmb: cap * 1000000, usage: { input_tokens: 1, output_tokens: 2 } }] }))
    writeFileSync(join(root, `manifest${suffix}.json`), JSON.stringify({ authorization: { source: 'direct_user_confirmation', cap_rmb: cap, user_text: `新增${cap}元` }, policy_sha256: hash(bytes), selector_sha256: 'same', tasks: { a: 'same' }, old_accounting: [] }))
    process.env.BLOMA_MONETARY_EPOCH_DIR = id ? join(root, 'epochs', id) : join(root, 'epochs'); activateMonetaryPolicy(path)
  }
  return root
}
describe('carry authorized trial windows', () => {
  it('carries exact receipts, sums caps, freezes sources and retires old senders', () => {
    const root = setup(), source = join(root, 'monetary-policy.json'), before = readFileSync(source + '.state.json')
    const result = mergeTrialWindows(root, ['', 'extra'], 'combined', 'head')
    expect(result).toMatchObject({ cap_rmb: 15, charged_rmb: 1.5, receipts: 2, request_limit: 1024 })
    expect(readFileSync(source + '.state.json')).toEqual(before)
    const target = JSON.parse(readFileSync(join(root, 'monetary-policy-combined.json.state.json'), 'utf8'))
    expect(target.entries[0]).toEqual(JSON.parse(before.toString()).entries[0])
    for (const id of ['', 'extra']) {
      process.env.BLOMA_MONETARY_EPOCH_DIR = id ? join(root, 'epochs', id) : join(root, 'epochs')
      const path = join(root, `monetary-policy${id ? '-' + id : ''}.json`)
      expect(() => acquireMonetaryEpoch(path, { host: 'example.test', model: 'model' }, hash(readFileSync(path)))).toThrow('MONETARY_INACTIVE_EPOCH')
    }
  })
  it.each(['reserved', 'unknown'])('rejects %s source before creating target', status => {
    const root = setup(), path = join(root, 'monetary-policy.json.state.json'), state = JSON.parse(readFileSync(path, 'utf8'))
    state.entries[0].status = status; writeFileSync(path, JSON.stringify(state))
    expect(() => mergeTrialWindows(root, ['', 'extra'], 'combined', 'head')).toThrow('TRIAL_MERGE_UNSETTLED_SOURCE')
  })
  it('rejects duplicated receipts rather than double counting authority', () => {
    const root = setup(), path = join(root, 'monetary-policy-extra.json.state.json'), state = JSON.parse(readFileSync(path, 'utf8'))
    state.entries[0].id = 'first'; writeFileSync(path, JSON.stringify(state))
    expect(() => mergeTrialWindows(root, ['', 'extra'], 'combined', 'head')).toThrow('TRIAL_MERGE_DUPLICATE_RECEIPT')
  })
})
