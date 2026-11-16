import type { SketchRequirement } from './prd-backplane'

/** Verification adapters attached to confirmed features, never to installed packages. */
export const REQUIREMENT_CAPABILITIES = ['llm', 'speech', 'microphone', 'prefix_rename', 'rename_undo'] as const
export type RequirementCapability = typeof REQUIREMENT_CAPABILITIES[number]

export function validRequirementCapabilities(value: unknown): value is RequirementCapability[] {
  return Array.isArray(value) && value.every(item => REQUIREMENT_CAPABILITIES.includes(item))
}

export const ACCEPTANCE_SCENARIOS = ['normal', 'multi_object', 'exception', 'cancel', 'reopen'] as const
export type AcceptanceScenario = typeof ACCEPTANCE_SCENARIOS[number]

export function validAcceptanceScenarios(value: unknown): value is AcceptanceScenario[] {
  return Array.isArray(value) && value.every(item => ACCEPTANCE_SCENARIOS.includes(item))
}

/** Only the confirmed capability declarations can add specialized checks. */
export function requirementCapabilities(item: SketchRequirement): ReadonlySet<RequirementCapability> {
  if (item.capabilities !== undefined && !validRequirementCapabilities(item.capabilities)) {
    throw new Error(`INVALID_REQUIREMENT_CAPABILITIES: ${item.id}`)
  }
  const result = new Set(item.capabilities ?? [])
  if (result.has('microphone')) result.add('speech')
  if (result.has('rename_undo')) result.add('prefix_rename')
  return result
}
