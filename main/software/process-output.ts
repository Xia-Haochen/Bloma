import { StringDecoder } from 'node:string_decoder'

export interface ProcessOutput { seq: number; stream: 'stdout' | 'stderr'; text: string; truncated?: boolean }
/** Redact complete logical lines before either model projection or archival.
 * Oversized unfinished lines are omitted whole, never expose a credential tail
 * after discarding its key/prefix. All gaps remain explicit. */
export function createProcessOutput(redact: (text: string) => string, retain?: (record: ProcessOutput, omitted: boolean) => void, retainBatch?: (records: Array<{record: ProcessOutput; omitted: boolean}>) => void) {
  let seq = 0, bytes = 0, incomplete = false
  const output: ProcessOutput[] = [], pending = { stdout: '', stderr: '' }, discarding = { stdout: false, stderr: false }
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  let batch: Array<{record: ProcessOutput; omitted: boolean}> = []
  const archive = () => {
    const records = batch; batch = []
    try { if (records.length) retainBatch?.(records) } catch { /* archive owns its gap metadata */ }
  }
  const append = (stream: ProcessOutput['stream'], text: string, omitted = false) => {
    if (!text) return
    const full = { seq: ++seq, stream, text: redact(text), ...(omitted ? { truncated: true } : {}) }
    try { if (retainBatch) batch.push({record:full,omitted}); else retain?.(full, omitted) } catch { /* Archival failure must not kill a real command. */ }
    const truncated = omitted || full.text.length > 16000
    incomplete ||= truncated
    const record: ProcessOutput = { ...full, text: full.text.length > 16000 ? '[record tail; use mode:log for earlier content]\n' + full.text.slice(-15900) : full.text,
      ...(truncated ? { truncated: true } : {}) }
    output.push(record); bytes += record.text.length
    while (output.length > 256 || bytes > 32768) bytes -= output.shift()!.text.length
  }
  return {
    push(stream: ProcessOutput['stream'], chunk: Buffer) {
      let text = decoders[stream].write(chunk)
      if (discarding[stream]) {
        const delimiter = text.search(/[\r\n]/)
        if (delimiter < 0) return
        discarding[stream] = false; text = text.slice(delimiter + 1)
      }
      pending[stream] += text
      const lines = pending[stream].split(/(?<=\n)|(?<=\r)/)
      pending[stream] = /[\r\n]$/.test(lines.at(-1) ?? '') ? '' : lines.pop() ?? ''
      for (const line of lines) append(stream, line)
      if (pending[stream].length > 65536) { pending[stream] = ''; discarding[stream] = true; append(stream, '[oversized unfinished line omitted]\n', true) }
      archive()
    },
    flush() {
      for (const stream of ['stdout', 'stderr'] as const) {
        const tail = decoders[stream].end()
        if (discarding[stream]) discarding[stream] = false
        else append(stream, pending[stream] + tail)
        pending[stream] = ''
      }
      archive()
    },
    snapshot() { return { output_seq: seq, output: output.map(line => ({ ...line })), output_incomplete: incomplete } },
  }
}
