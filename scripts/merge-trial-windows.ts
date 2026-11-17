import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activateMonetaryPolicy } from '../main/platform/llm/monetary-epoch'

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
/** Offline host operation: carry settled receipts and existing authorizations,
 * then retire every source epoch. Never resets accounting or authorizes money. */
export function mergeTrialWindows(root: string, sources: string[], target: string, sourceHead: string) {
  if (sources.length < 2 || new Set(sources).size !== sources.length || sources.includes(target)
    || !target || [...sources, target].some(s => s && !/^[a-z0-9-]{1,60}$/.test(s))) throw Error('TRIAL_MERGE_WINDOWS_INVALID')
  const paths = (id: string) => ({ manifest: join(root, `manifest${id ? '-' + id : ''}.json`),
    policy: join(root, `monetary-policy${id ? '-' + id : ''}.json`), epoch: id ? join(root, 'epochs', id) : join(root, 'epochs') })
  const dest = paths(target)
  if ([dest.manifest, dest.policy, dest.policy + '.state.json'].some(existsSync)) throw Error('TRIAL_MERGE_TARGET_EXISTS')
  const frozen = new Map<string, string>(), entries: any[] = [], ids = new Set<string>(), authorizations: any[] = []
  let baseline: any, capMicro = 0, requestLimit = 0
  for (const id of sources) {
    const p = paths(id), bytes = readFileSync(p.policy), policy = JSON.parse(bytes.toString()), manifest = JSON.parse(readFileSync(p.manifest, 'utf8'))
    const state = JSON.parse(readFileSync(p.policy + '.state.json', 'utf8'))
    if (policy.version !== 1 || policy.models?.length !== 1 || manifest.policy_sha256 !== hash(bytes)
      || state.version !== 1 || state.policy_hash !== hash(bytes) || !Array.isArray(state.entries)
      || Object.keys(state).some(k => !['version', 'policy_hash', 'entries'].includes(k))
      || manifest.authorization?.source !== 'direct_user_confirmation' || !manifest.authorization.user_text
      || policy.models[0].cap_rmb !== manifest.authorization.cap_rmb) throw Error('TRIAL_MERGE_SOURCE_INVALID')
    const { cap_rmb, ...rate } = policy.models[0], micro = Math.round(cap_rmb * 1e6)
    if (!Number.isSafeInteger(micro) || micro <= 0) throw Error('TRIAL_MERGE_CAP_INVALID')
    if (baseline && (JSON.stringify(baseline.rate) !== JSON.stringify(rate) || JSON.stringify(baseline.manifest.tasks) !== JSON.stringify(manifest.tasks)
      || baseline.manifest.selector_sha256 !== manifest.selector_sha256)) throw Error('TRIAL_MERGE_CONFIGURATION_MISMATCH')
    baseline ??= { rate, manifest }
    for (const old of manifest.old_accounting) {
      if (hash(readFileSync(old.path)) !== old.sha256) throw Error('OLD_ACCOUNTING_CHANGED')
      frozen.set(old.path, old.sha256)
    }
    for (const file of [p.manifest, p.policy, p.policy + '.state.json']) frozen.set(file, hash(readFileSync(file)))
    for (const entry of state.entries) {
      if (entry.status !== 'reported' || entry.host !== rate.host || entry.model !== rate.model || !entry.id
        || !Number.isSafeInteger(entry.charged_micro_rmb) || entry.charged_micro_rmb < 0) throw Error('TRIAL_MERGE_UNSETTLED_SOURCE')
      if (ids.has(entry.id)) throw Error('TRIAL_MERGE_DUPLICATE_RECEIPT')
      ids.add(entry.id); entries.push(entry)
    }
    capMicro += micro; requestLimit += manifest.execution_request_limit ?? 512
    authorizations.push({ manifest: p.manifest, sha256: hash(readFileSync(p.manifest)), ...manifest.authorization })
  }
  if (!Number.isSafeInteger(capMicro) || !Number.isSafeInteger(requestLimit) || requestLimit > 4096
    || entries.reduce((n, e) => n + e.charged_micro_rmb, 0) > capMicro) throw Error('TRIAL_MERGE_LIMIT_INVALID')
  const cap = capMicro / 1e6, rates = { ...baseline.rate, cap_rmb: cap }
  const bytes = JSON.stringify({ version: 1, models: [rates] }, null, 2)
  const manifest = { ...baseline.manifest, at: new Date().toISOString(), source_head: sourceHead,
    authorization: { source: 'carried_user_authorizations', cap_rmb: cap, inherited: authorizations },
    policy_sha256: hash(bytes), rates, execution_request_limit: requestLimit,
    old_accounting: [...frozen].map(([path, sha256]) => ({ path, sha256 })),
    aggregation_status: 'preparing', boundaries: 'Existing authorizations and exact settled receipts carried; source windows inactive; no new authorization.' }
  writeFileSync(dest.policy, bytes, { flag: 'wx' })
  writeFileSync(dest.policy + '.state.json', JSON.stringify({ version: 1, policy_hash: hash(bytes), entries }, null, 2), { flag: 'wx' })
  writeFileSync(dest.manifest, JSON.stringify(manifest, null, 2), { flag: 'wx' })
  const previous = process.env.BLOMA_MONETARY_EPOCH_DIR
  try {
    // Trial host is offline. A partial failure stays preparing and cannot generate.
    for (const id of [...sources, target]) {
      for (const [path, sha] of frozen) if (hash(readFileSync(path)) !== sha) throw Error('OLD_ACCOUNTING_CHANGED')
      process.env.BLOMA_MONETARY_EPOCH_DIR = paths(id).epoch
      activateMonetaryPolicy(dest.policy)
    }
    manifest.aggregation_status = 'active'
    writeFileSync(dest.manifest, JSON.stringify(manifest, null, 2))
  } finally {
    if (previous === undefined) delete process.env.BLOMA_MONETARY_EPOCH_DIR
    else process.env.BLOMA_MONETARY_EPOCH_DIR = previous
  }
  return { manifest: dest.manifest, cap_rmb: cap, receipts: entries.length,
    charged_rmb: entries.reduce((n, e) => n + e.charged_micro_rmb, 0) / 1e6, request_limit: requestLimit }
}
