export interface TextEdit { old_string: string; new_string: string }
type EditResult = { ok: true; content: string } | { ok: false; code: 'EDIT_NOT_UNIQUE' | 'EDIT_OVERLAP'; index: number; matches: number }

/** Locate every occurrence, including overlaps and equivalent CRLF/LF spans.
 * Never normalize the file itself or relax indentation/other whitespace. */
function ranges(current: string, oldText: string): Array<{ start: number; length: number }> {
  if (!oldText) return []
  const escaped = oldText.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escaped.replace(/\n/g, '\\r?\\n'), 'g')
  const found: Array<{ start: number; length: number }> = []
  for (;;) {
    const match = pattern.exec(current)
    if (!match) break
    found.push({ start: match.index, length: match[0].length })
    if (found.length > 1) break // two is already ambiguous; avoid unbounded allocation
    pattern.lastIndex = match.index + 1
  }
  return found
}
/** Every edit addresses the SAME original bytes. Validate all spans before
 * creating the final text; nested/overlapping spans never partially apply. */
export function replaceMultipleTexts(current: string, edits: TextEdit[]): EditResult {
  const located: Array<{ start: number; length: number; replacement: string; index: number }> = []
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index], found = ranges(current, edit.old_string)
    if (found.length !== 1) return { ok: false, code: 'EDIT_NOT_UNIQUE', index, matches: found.length }
    const { start, length } = found[0]
    const ending = current.slice(start, start + length).match(/\r?\n/)?.[0] ?? current.match(/\r?\n/)?.[0] ?? '\n'
    located.push({ start, length, replacement: edit.new_string.replace(/\r\n/g, '\n').replace(/\n/g, ending), index })
  }
  located.sort((a, b) => a.start - b.start)
  for (let i = 1; i < located.length; i++) if (located[i].start < located[i - 1].start + located[i - 1].length) {
    return { ok: false, code: 'EDIT_OVERLAP', index: located[i].index, matches: 1 }
  }
  let content = current
  for (const edit of located.reverse()) content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.start + edit.length)
  return { ok: true, content }
}
/** Backwards-compatible single replacement over the same validation primitive. */
export function replaceUniqueText(current: string, oldText: string, newText: string): { ok: true; content: string } | { ok: false; matches: number } {
  const result = replaceMultipleTexts(current, [{ old_string: oldText, new_string: newText }])
  return result.ok ? result : { ok: false, matches: result.matches }
}
