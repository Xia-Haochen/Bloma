import type { UsageRow } from '../../shared/token-monitor'

export function needsAudit(row: UsageRow): boolean
export function hasFailure(row: UsageRow): boolean
export function hasUnreadableFailure(row: UsageRow): boolean
export function observedFailure(row: UsageRow): string
export function failureSummary(row: UsageRow): string
export function readableSummary(value: unknown): string
