import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import type { ProcessOutput } from './process-output'

const LOG_BYTES = 8 * 1024 * 1024
const HOME_BYTES = 128 * 1024 * 1024
const MAX_LOG_FILES = 10000 // metadata/scan bound, independent of byte capacity
const lockWait = new Int32Array(new SharedArrayBuffer(4))
function withArchiveLock<T>(root: string, work: () => T): T {
  const lock = join(root, "archive.lock"), deadline = Date.now() + 250
  let fd: number
  for (;;) {
    try { fd = openSync(lock, "wx"); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw Error("PROCESS_LOG_LOCKED")
      Atomics.wait(lockWait, 0, 0, 5)
    }
  }
  try { return work() } finally { closeSync(fd); unlinkSync(lock) }
}
function archiveUsage(root: string) {
  let bytes = 0, files = 0
  for (const name of readdirSync(root)) {
    if (!/^[a-f0-9-]{36}\.jsonl$/.test(name)) continue
    const info = lstatSync(join(root, name))
    if (!info.isFile() || info.isSymbolicLink()) throw Error("PROCESS_LOG_INVALID_FILE")
    bytes += info.size; files++
  }
  return { bytes, files }
}
export interface ProcessLogInfo {
  available: boolean; complete: boolean; bytes: number; max_bytes: number
  retention: 'until_manual_cleanup'; gap?: 'capacity' | 'long_line' | 'io_failure'
}
const directory = () => join(getPromaHome(), 'software-process-logs')
function logPath(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('PROCESS_LOG_ID_INVALID')
  return join(directory(), `${id}.jsonl`)
}
/** Actual archived bytes are the quota authority; legacy slot markers are ignored.
 * No eviction: running and historical evidence survive. All current writers
 * serialize capacity checks and writes across hosts. A stale lock fails closed
 * as an explicit IO gap; never break another writer's lock by guessing its PID. */
export function createProcessLog(id: string) {
  const path = logPath(id), root = directory()
  const info: ProcessLogInfo = { available: false, complete: true, bytes: 0, max_bytes: LOG_BYTES, retention: 'until_manual_cleanup' }
  try {
    mkdirSync(root, { recursive: true })
    withArchiveLock(root, () => {
      const usage = archiveUsage(root)
      if (usage.files >= MAX_LOG_FILES || usage.bytes >= HOME_BYTES) { info.complete = false; info.gap = 'capacity'; return }
      const file = openSync(path, 'wx'); closeSync(file); info.available = true
    })
  } catch { info.complete = false; info.gap = 'io_failure' }
  const appendMany = (records: Array<{ record: ProcessOutput; omitted: boolean }>) => {
    if (!records.length) return
    if (records.some(row => row.omitted)) { info.complete = false; info.gap ??= 'long_line' }
    if (!info.available || info.gap === 'capacity' || info.gap === 'io_failure') return
    try {
      withArchiveLock(root, () => {
        const current = lstatSync(path)
        if (!current.isFile() || current.isSymbolicLink()) throw Error('PROCESS_LOG_INVALID_FILE')
        const usage = archiveUsage(root)
        let bytes = 0
        const lines: string[] = []
        for (const { record } of records) {
          const line = JSON.stringify(record) + '\n', size = Buffer.byteLength(line)
          if (current.size + bytes + size > LOG_BYTES || usage.bytes + bytes + size > HOME_BYTES) {
            info.complete = false; info.gap = 'capacity'; break
          }
          lines.push(line); bytes += size
        }
        if (lines.length) appendFileSync(path, lines.join(''))
        info.bytes = current.size + bytes
      })
    } catch { info.complete = false; info.gap = 'io_failure' }
  }
  return {
    info: () => ({ ...info }),
    append: (record: ProcessOutput, omitted = false) => appendMany([{record, omitted}]),
    appendMany,
  }
}
/** Caller must check project/session ownership through the existing snapshot.
 * Bounded range/literal search never returns absolute paths or unsanitized data. */
export function readProcessLog(id: string, info: ProcessLogInfo | undefined, input: { since?: number; limit?: number; pattern?: string }) {
  if (!info?.available || !existsSync(logPath(id))) throw Error('PROCESS_LOG_UNAVAILABLE: 旧进程/归档容量已满/文件已清理；可显式读取尾部，不能宣称全文仍在')
  const since = input.since ?? 0, limit = input.limit ?? 50
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || input.pattern !== undefined && (typeof input.pattern !== 'string' || input.pattern.length > 500)) throw Error('PROCESS_LOG_QUERY_INVALID')
  const lines = readFileSync(logPath(id), 'utf8').split('\n')
  const output: ProcessOutput[] = []; let cursor = since, chars = 0, more = false
  for (const line of lines) {
    if (!line) continue
    let record: ProcessOutput
    try { record = JSON.parse(line) } catch { throw Error('PROCESS_LOG_CORRUPT: 保留现场，不把缺损当EOF') }
    if (!Number.isSafeInteger(record.seq) || typeof record.text !== 'string' || !['stdout', 'stderr'].includes(record.stream)) throw Error('PROCESS_LOG_CORRUPT')
    if (record.seq <= since) continue
    if (input.pattern !== undefined && !record.text.includes(input.pattern)) { cursor = record.seq; continue }
    // The archive keeps full redacted logical records; one oversized line needs
    // a character cursor rather than silently skipping the rest of its content.
    if (record.text.length > 24000) {
      if (output.length) { more = true; break }
      return { process_id: id, output: [], next_seq: since, eof: false, code: 'PROCESS_LOG_RECORD_TOO_LARGE', record_seq: record.seq,
        next: '指定record_seq和char_offset读取该长记录，不推进since_seq。', log: info }
    }
    if (output.length >= limit || chars + record.text.length > 24000) { more = true; break }
    output.push(record); chars += record.text.length; cursor = record.seq
  }
  return { process_id: id, output, next_seq: cursor, eof: !more, log: info }
}
export function readProcessLogRecord(id: string, info: ProcessLogInfo | undefined, seq: number, offset: number) {
  if (!info?.available || !existsSync(logPath(id))) throw Error('PROCESS_LOG_UNAVAILABLE')
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(offset) || offset < 0) throw Error('PROCESS_LOG_QUERY_INVALID')
  for (const line of readFileSync(logPath(id), 'utf8').split('\n')) {
    if (!line) continue
    const record = JSON.parse(line) as ProcessOutput
    if (record.seq !== seq) continue
    if (typeof record.text !== 'string' || offset > record.text.length || /[\uDC00-\uDFFF]/.test(record.text[offset] ?? '')) throw Error('PROCESS_LOG_CURSOR_INVALID')
    let end = Math.min(record.text.length, offset + 16000)
    if (/[\uD800-\uDBFF]/.test(record.text[end - 1] ?? '')) end--
    return { process_id: id, record_seq: seq, stream: record.stream, text: record.text.slice(offset, end),
      ...(end < record.text.length ? { next_char_offset: end } : { next_seq: seq }), eof: end === record.text.length, log: info }
  }
  throw Error('PROCESS_LOG_CURSOR_INVALID')
}
