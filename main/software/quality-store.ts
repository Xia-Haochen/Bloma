import {createHash} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {getPromaHome} from '../../storage/config-paths'
import {writeTextFileAtomic} from '../../storage/json-store'
import type {Ledger} from './quality-ledger'

export const qualityHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function qualityLedgerPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('QUALITY_PROJECT_INVALID')
  return join(getPromaHome(), 'software-quality', `${projectId}.json`)
}
export function readQualityLedger(projectId: string): Ledger {
  const path = qualityLedgerPath(projectId)
  if (!existsSync(path)) return { version: 1, reviews: [], findings: [] }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Ledger
  if (value.version !== 1 || !Array.isArray(value.reviews) || !Array.isArray(value.findings) || value.collaboration!==undefined&&!Array.isArray(value.collaboration)) throw Error('QUALITY_LEDGER_INVALID')
  return value // Corrupt evidence must fail closed, never silently reset history.
}
export const saveQualityLedger = (projectId: string, ledger: Ledger) => writeTextFileAtomic(qualityLedgerPath(projectId), JSON.stringify(ledger, null, 2))
