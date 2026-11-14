import type { UsageRow } from '../../shared/token-monitor'

export function needsAudit(row: UsageRow): boolean
export function hasFailure(row: UsageRow): boolean
export function failureSummary(row: UsageRow): string
export function readableSummary(value: unknown): string
