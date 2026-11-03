import { expect, it } from 'vitest'
import { decisionPage, validateDecisionHistory, type ProjectDecision } from '../../../main/software/project-decisions'
const row = (id: string, scope = 'scope'): ProjectDecision => ({ id, scope, decision: 'decision', reason: 'reason', author: 'agent', at: 'now' })
it('keeps old decisions auditable while active pages exclude replaced and foreign scope decisions', () => {
  const history = [row('old'), row('foreign', 'other'), ...Array.from({ length: 24 }, (_, i) => row(`r${i}`)), { ...row('new'), supersedes: ['old'] }]
  const first = decisionPage(history, 'scope')
  expect(first.items.some(r => r.id === 'old' || r.id === 'foreign')).toBe(false)
  expect(first.total).toBe(25)
  expect(decisionPage(history, 'scope', { offset: first.next_offset! }).items.at(-1)?.id).toBe('new')
  expect(decisionPage(history, 'scope', { history: true }).items[0]).toMatchObject({ id: 'old', effective: false })
  expect(() => decisionPage(history, 'scope', { offset: -1 })).toThrow()
})
it('rejects unknown, forward, cross-scope, duplicate replacements and model replacement of human decisions', () => {
  for (const history of [
    [{ ...row('a'), supersedes: ['missing'] }],
    [row('a'), { ...row('b', 'other'), supersedes: ['a'] }],
    [{ ...row('a'), author: 'user' as const }, { ...row('b'), supersedes: ['a'] }],
    [row('a'), { ...row('b'), supersedes: ['a'] }, { ...row('c'), supersedes: ['a'] }],
  ]) expect(() => validateDecisionHistory(history)).toThrow()
})
