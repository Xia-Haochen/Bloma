export const USAGE_PHASES = {
  requirements: '需求', interface: '界面', production: '制作',
  verification: '验证', delivery: '交付', unknown: '未归类',
} as const

export type MonitorPhase = keyof typeof USAGE_PHASES
export type Counts = Record<'uncached' | 'read' | 'write' | 'output', number | null>
export interface ModelRate extends Counts {
  peak?: Counts
  as_of?: string
}
export interface PriceBook {
  as_of: string
  models: Record<string, ModelRate>
}
export interface PriceSource extends PriceBook {
  state: 'live' | 'cached'
  checked?: string
  error?: string
}
export type MonitorPrices = Record<string, PriceSource>

export interface UsageTurn {
  project: string
  session: string
  id: string
  at: number
  request: string
  reply: string
  unlinked?: boolean
}
export interface UsageRow {
  project: string
  turn: [string, string, string]
  at: number
  phase: MonitorPhase
  phase_inferred: boolean
  inferred: boolean
  provider: string
  channel: string
  host: string
  model: string
  counts: Counts
  status: string
  missing: boolean
  failed: number
}
export interface UsageSnapshot {
  projects: Record<string, string>
  rows: UsageRow[]
  turns: UsageTurn[]
  issues: { malformed: number; unreadable: number }
  phases: typeof USAGE_PHASES
  pricing: MonitorPrices
}
