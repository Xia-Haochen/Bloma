import { THINKING_LEVELS, type ThinkingLevel } from '../../../shared/reasoning-profile'

/** One effective setting for the Pi session, provider request and observation.
 * Preserve the existing default; higher effort must be selected explicitly. */
export function loopThinking(input: { thinkingLevel?: ThinkingLevel; env: Record<string, string> }): ThinkingLevel {
  if (process.env.BLOMA_EXPERIMENT_THINKING === 'high') return 'high'
  if (input.thinkingLevel !== undefined) return input.thinkingLevel
  const configured = input.env.BLOMA_LOOP_THINKING
  return THINKING_LEVELS.includes(configured as ThinkingLevel) ? configured as ThinkingLevel : 'low'
}
