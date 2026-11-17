/** Owned loopback-only fake provider. No forwarding and no external traffic. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function startChannelProtocolServer() {
  const requests = [], errors = []
  const frame = value => `data: ${JSON.stringify(value)}\n\n`
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      requests.push({ path: req.url, method: req.method, headers: req.headers, body })
      if (req.url.includes('/redirect307/')) { res.writeHead(307, { location: new URL(req.url, 'http://localhost').searchParams.get('to') }); res.end(); return }
      if (req.url.includes('/reject-thinking/')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'thinking unsupported' } })); return }
      const omitUsage = req.url.includes('omitUsage=1')
      if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b', display_name: '27B 离线模型' }] })); return }
      assert.equal(req.method, 'POST')
      const anthropic = new URL(req.url, 'http://localhost').pathname.endsWith('/messages')
      assert.ok(anthropic || new URL(req.url, 'http://localhost').pathname.endsWith('/chat/completions'))
      const results = anthropic ? body.messages.flatMap(turn => Array.isArray(turn.content) ? turn.content.filter(block => block.type === 'tool_result') : [])
        : body.messages.filter(turn => turn.role === 'tool')
      if (results.length) {
        assert.equal(results.length, 2)
        assert.equal(results[0].tool_call_id ?? results[0].tool_use_id, 'read-alpha')
        assert.equal(results[1].tool_call_id ?? results[1].tool_use_id, 'read-beta')
        assert.ok(JSON.stringify(results[0].content).includes('fixture-alpha.txt'))
        assert.ok(JSON.stringify(results[1].content).includes('fixture-beta.txt'))
      }
      const first = !results.length
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!anthropic) {
        if (first) {
          res.write(frame({ choices: [{ delta: { tool_calls: [
            { index: 0, id: 'read-alpha', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
            { index: 1, id: 'read-beta', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
          ] } }] }))
          res.write(frame({ choices: [{ delta: { tool_calls: [
            { index: 1, function: { arguments: '"beta.txt"}' } }, { index: 0, function: { arguments: '"alpha.txt"}' } },
          ] } }] }))
        } else res.write(frame({ choices: [{ delta: { content: '两份文件已读取' } }] }))
        res.write(frame({ choices: [{ delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] }))
        if (!omitUsage) res.write(frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } }))
        res.end('data: [DONE]\n\n')
      } else {
        res.write(frame({ type: 'message_start', message: { id: 'fixture', role: 'assistant', usage: omitUsage ? undefined : { input_tokens: 60, cache_read_input_tokens: 40 } } }))
        for (const [index, file] of (first ? ['alpha', 'beta'] : ['text']).entries()) {
          res.write(frame({ type: 'content_block_start', index, content_block: first ? { type: 'tool_use', id: 'read-' + file, name: 'read_file', input: {} } : { type: 'text', text: '' } }))
          res.write(frame({ type: 'content_block_delta', index, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify({ path: file + '.txt' }) } : { type: 'text_delta', text: '两份文件已读取' } }))
          res.write(frame({ type: 'content_block_stop', index }))
        }
        res.write(frame({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: omitUsage ? undefined : { output_tokens: 10 } }))
        res.end(frame({ type: 'message_stop' }))
      }
    } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture assertion failed' } })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, errors,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
