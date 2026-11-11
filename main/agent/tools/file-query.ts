import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolOutcome } from '../loop/agent-loop'
import { contentRevision } from './write-lease'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('QUERY_ARGUMENT_INVALID')
  return value
}
/** A UTF-16 cursor never divides a surrogate pair. Output is also UTF-8 bounded. */
function prefix(text: string, chars: number, bytes: number): string {
  let end = Math.min(text.length, chars)
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  let result = text.slice(0, end)
  while (Buffer.byteLength(result) > bytes) {
    end -= Math.max(1, Math.ceil((Buffer.byteLength(result) - bytes) / 3))
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    result = text.slice(0, Math.max(0, end))
  }
  return result
}
export const readWindowProperties = {
  offset: { type: 'integer', minimum: 1, description: '起始行，1起；越界回退末窗口' },
  limit: { type: 'integer', minimum: 1, maximum: 500, description: '行数，默认100' },
  max_chars: { type: 'integer', minimum: 512, maximum: 24000, description: '含提示的输出字符上限，默认16000' },
  max_bytes: { type: 'integer', minimum: 2048, maximum: 65536, description: '含提示的UTF-8字节上限，默认48000' },
  char_offset: { type: 'integer', minimum: 0, description: '超长行内UTF-16续读位置；非零时须带expected_revision' },
  expected_revision: { type: 'string', description: '续读/分页绑定的文件版本，变化时拒绝' },
}
export function readTextWindow(abs: string, rel: string, input: Record<string, unknown>, limits?: { chars: number; bytes: number }): ToolOutcome {
  try {
    const maxChars = Math.min(limits?.chars ?? 24000, boundedInteger(input.max_chars, 16000, 512, 24000))
    const maxBytes = Math.min(limits?.bytes ?? 65536, boundedInteger(input.max_bytes, 48000, 2048, 65536))
    const limit = boundedInteger(input.limit, 100, 1, 500)
    let offset = boundedInteger(input.offset, 1, 1, Number.MAX_SAFE_INTEGER)
    let charOffset = boundedInteger(input.char_offset, 0, 0, Number.MAX_SAFE_INTEGER)
    if (charOffset && typeof input.expected_revision !== 'string') throw Error('READ_CURSOR_REQUIRES_REVISION')
    const stat = statSync(abs)
    if (!stat.isFile()) throw Error('READ_NOT_REGULAR_FILE')
    if (stat.size > 16 * 1024 * 1024) throw Error('READ_FILE_TOO_LARGE: 上限16MiB；用工程命令按需处理，不读取全文')
    const bytes = readFileSync(abs)
    const revision = contentRevision(bytes)
    if (input.expected_revision !== undefined && input.expected_revision !== revision) throw Error('STALE_READ: 文件已改变，请重新读取')
    if (bytes.subarray(0, 8192).includes(0)) throw Error('READ_BINARY_FILE: 不作为文本读取')
    const lines = bytes.toString('utf8').split('\n'), total = lines.length
    if (offset > total) { offset = Math.max(1, total - limit + 1); charOffset = 0 }
    if (charOffset > lines[offset - 1].length || charOffset && /[\uDC00-\uDFFF]/.test(lines[offset - 1][charOffset])) throw Error('READ_CURSOR_INVALID')
    const header = `（${rel} 共 ${total} 行，显示第 ${offset}~${Math.min(total, offset + limit - 1)} 行｜文件版本 ${revision}）\n`
    const reserveChars = header.length + revision.length + 150
    const reserveBytes = Buffer.byteLength(header) + revision.length + 300
    if (maxChars < reserveChars + 20 || maxBytes < reserveBytes + 60) throw Error('READ_OUTPUT_BUDGET_TOO_SMALL: 路径和续读元数据超过输出预算，请提高max_chars/max_bytes')
    let body = '', endLine = offset - 1
    let next: { offset: number; char_offset: number; expected_revision: string } | undefined
    // Reserve space for the complete header + continuation, never truncate a cursor.
    for (let index = offset - 1; index < Math.min(total, offset - 1 + limit); index++) {
      const start = index === offset - 1 ? charOffset : 0
      const label = `${index + 1} │ `, remaining = lines[index].slice(start)
      if (body.length + label.length + 1 > maxChars - reserveChars || Buffer.byteLength(body + label) + 1 > maxBytes - reserveBytes) {
        next = { offset: index + 1, char_offset: start, expected_revision: revision }; break
      }
      const part = prefix(remaining, Math.max(0, maxChars - reserveChars - body.length - label.length - 1), Math.max(0, maxBytes - reserveBytes - Buffer.byteLength(body + label) - 1))
      if (part.length < remaining.length && !part.length) { next = { offset: index + 1, char_offset: start, expected_revision: revision }; break }
      body += (body ? '\n' : '') + label + part
      endLine = index + 1
      if (part.length < remaining.length) { next = { offset: index + 1, char_offset: start + part.length, expected_revision: revision }; break }
    }
    if (!next && endLine < total) next = { offset: endLine + 1, char_offset: 0, expected_revision: revision }
    const continuation = next ? `\n（未读完；续读参数 ${JSON.stringify(next)}）` : ''
    return { output: `（${rel} 共 ${total} 行，显示第 ${offset}~${endLine} 行｜文件版本 ${revision}）\n${body}${continuation}`,
      detail: { path: rel, revision, total_lines: total, truncated: Boolean(next), ...(next ? { next } : {}) } }
  } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
}

/** Explicit portable glob subset; never reinterpret unsupported syntax as a suffix. */
export function compileFileGlob(pattern: string): RegExp {
  if (!pattern || pattern.length > 500 || /[\[\]{}\\]/.test(pattern)) throw Error('UNSUPPORTED_GLOB: 支持*、**、?；路径使用/，不支持[]、{}或反斜杠')
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i++
      if (pattern[i + 1] === '/') { source += '(?:.*/)?'; i++ } else source += '.*'
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^$()|]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}
function globMatches(path: string, pattern: string, matcher: RegExp) {
  return matcher.test(pattern.includes('/') ? path : path.split('/').at(-1)!)
}
function encodeCursor(query: string, revision: string, offset: number) {
  return Buffer.from(JSON.stringify({ v: 1, query, revision, offset })).toString('base64url')
}
function decodeCursor(value: unknown, query: string, revision: string): number {
  if (value === undefined) return 0
  if (typeof value !== 'string' || value.length > 1000) throw Error('QUERY_CURSOR_INVALID')
  let parsed: { v: number; query: string; revision: string; offset: number }
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) } catch { throw Error('QUERY_CURSOR_INVALID') }
  if (parsed.v !== 1 || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw Error('QUERY_CURSOR_INVALID')
  if (parsed.query !== query) throw Error('QUERY_CURSOR_MISMATCH: 游标不属于当前查询')
  if (parsed.revision !== revision) throw Error('QUERY_CURSOR_STALE: 文件集合或内容改变，请重新搜索')
  return parsed.offset
}
export function pageFileNames(files: string[], input: Record<string, unknown>, identity: string, limit: number): ToolOutcome {
  try {
    const query = digest(identity), revision = digest(files.join('\0'))
    const offset = decodeCursor(input.cursor, query, revision)
    if (offset > files.length) throw Error('QUERY_CURSOR_INVALID')
    const shown: string[] = []; let chars = 0
    for (const file of files.slice(offset, offset + limit)) {
      if (chars + file.length + 1 > 23000) break
      shown.push(file); chars += file.length + 1
    }
    if (!shown.length && files.length > offset) throw Error('FILE_NAME_OUTPUT_LIMIT')
    const next = offset + shown.length < files.length ? encodeCursor(query, revision, offset + shown.length) : undefined
    return { output: `${files.length ? `共 ${files.length} 个文件，显示 ${offset + 1}~${offset + shown.length}：\n${shown.join('\n')}` : '无匹配文件。'}${next ? `\n（未显示完；cursor=${next}）` : ''}`,
      detail: { count: files.length, truncated: Boolean(next), ...(next ? { next_cursor: next } : {}) } }
  } catch (error) { return { output: String(error instanceof Error ? error.message : error), isError: true } }
}
export function searchProjectFiles(root: string, files: string[], input: Record<string, unknown>, scope = { depthLimited: 0, unreadable: 0 }): ToolOutcome {
  try {
    if (typeof input.pattern !== 'string' || !input.pattern || input.pattern.length > 1000) throw Error('缺少 pattern 参数或模式过长（上限1000字符）')
    for (const key of ['literal', 'ignore_case', 'files_only']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw Error('QUERY_ARGUMENT_INVALID')
    const context = boundedInteger(input.context, 0, 0, 5), limit = boundedInteger(input.limit, 50, 1, 200)
    const maxChars = boundedInteger(input.max_chars, 12000, 1024, 24000)
    const pattern = input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : input.pattern
    let regex: RegExp
    try { regex = new RegExp(pattern, input.ignore_case === false ? '' : 'i') } catch { throw Error(`正则表达式无效：${input.pattern}`) }
    const glob = typeof input.glob === 'string' && input.glob ? input.glob : undefined
    const matcher = glob ? compileFileGlob(glob) : undefined
    const query = digest(JSON.stringify([root, input.pattern, Boolean(input.literal), input.ignore_case !== false, Boolean(input.files_only), context, glob, input.path ?? '']))
    const snapshot = createHash('sha256'), hits: string[] = []
    let scanned = 0, skippedLarge = 0, skippedBinary = 0, unreadable = 0, scanLimited = false
    for (const rel of files) {
      if (matcher && !globMatches(rel, glob!, matcher)) continue
      snapshot.update(rel + '\0')
      try {
        const stat = statSync(join(root, rel))
        if (!stat.isFile()) { unreadable++; snapshot.update('not-file'); continue }
        if (stat.size > 2 * 1024 * 1024) { skippedLarge++; snapshot.update(`large:${stat.size}:${stat.mtimeMs}`); continue }
        if (scanned + stat.size > 64 * 1024 * 1024) { scanLimited = true; snapshot.update(`limit:${stat.size}:${stat.mtimeMs}`); continue }
        const bytes = readFileSync(join(root, rel)); scanned += bytes.length; snapshot.update(bytes)
        if (bytes.subarray(0, 8192).includes(0)) { skippedBinary++; continue }
        const lines = bytes.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue
          if (hits.length >= 10000) { scanLimited = true; break }
          if (input.files_only) { hits.push(rel); break }
          const region = lines.slice(Math.max(0, i - context), Math.min(lines.length, i + context + 1))
            .map((line, n) => {
              const shown = prefix(line.replace(/\r$/, ''), 500, 1500)
              return `${rel}:${Math.max(0, i - context) + n + 1}${Math.max(0, i - context) + n === i ? ':' : '-'} ${shown}${shown.length < line.replace(/\r$/, '').length ? ' …[行截断，用read_file读取]' : ''}`
            }).join('\n')
          hits.push(region)
        }
      } catch { unreadable++; snapshot.update('unreadable') }
    }
    const revision = snapshot.digest('hex'), offset = decodeCursor(input.cursor, query, revision)
    if (offset > hits.length) throw Error('QUERY_CURSOR_INVALID')
    const shown: string[] = []; let size = 0
    for (const hit of hits.slice(offset, offset + limit)) {
      if (size + hit.length + 1 > maxChars - 700) break
      shown.push(hit); size += hit.length + 1
    }
    if (!shown.length && hits.length > offset) {
      // One context block may exceed a small caller budget. Show a bounded
      // excerpt with an explicit deep-read path, rather than an endless cursor.
      shown.push(prefix(hits[offset], maxChars - 750, (maxChars - 750) * 3) + ' …[上下文截断]')
    }
    const next = offset + shown.length < hits.length ? encodeCursor(query, revision, offset + shown.length) : undefined
    const incomplete = scanLimited || skippedLarge > 0 || skippedBinary > 0 || unreadable > 0 || scope.depthLimited > 0 || scope.unreadable > 0
    const note = incomplete ? `\n（搜索范围不完整：大文件${skippedLarge}，二进制${skippedBinary}，不可读${unreadable + scope.unreadable}，深度限制${scope.depthLimited}，扫描上限${scanLimited}；限定path/glob或有界读取）` : ''
    return { output: `${shown.length ? `命中 ${hits.length} 处，显示 ${offset + 1}~${offset + shown.length}：\n${shown.join('\n')}` : `未找到匹配（模式：${prefix(input.pattern, 100, 300)}）。`}${note}${next ? `\n（未显示完；cursor=${next}）` : ''}`,
      detail: { hits: shown.length, total_hits: hits.length, complete_scope: !incomplete, truncated: Boolean(next), skipped_large_files: skippedLarge, skipped_binary_files: skippedBinary, unreadable_files: unreadable, unreadable_directories: scope.unreadable, depth_limited_directories: scope.depthLimited, scan_limited: scanLimited, ...(next ? { next_cursor: next } : {}) } }
  } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true } }
}
