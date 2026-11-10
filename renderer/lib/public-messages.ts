import type { AgentEvent, AgentMessage } from '../../shared/types'

/** Presentation only: a response boundary must never finish the owning run. */
export interface PublicMessageStream {
  content: string
  public_message_id?: string
  message_at?: number
  closed_public_ids?: string[]
}
export function publicMessageIdentity(message: AgentMessage): string {
  return message.role === 'user' && message.client_message_id ? `client:${message.client_message_id}`
    : message.public_message_id ? `public:${message.public_message_id}`
    : message.id ? `id:${message.id}` : `${message.role}:${message.timestamp}:${JSON.stringify(message.content)}`
}
export function reducePublicMessage(previous: PublicMessageStream, event: AgentEvent): { stream: PublicMessageStream; finished: AgentMessage[] } {
  let stream: PublicMessageStream = { content: previous.content, public_message_id: previous.public_message_id, message_at: previous.message_at, closed_public_ids: previous.closed_public_ids }
  const finished: AgentMessage[] = []
  const at = typeof event.payload.at === 'number' && Number.isFinite(event.payload.at) ? event.payload.at : Date.parse(event.created_at)
  const id = typeof event.payload.public_message_id === 'string' ? event.payload.public_message_id : undefined
  const closed = new Set(previous.closed_public_ids ?? [])
  const flush = () => {
    if (stream.content.trim()) finished.push({ role: 'assistant', origin: 'agent', public_message_id: stream.public_message_id,
      content: [{ type: 'text', text: stream.content }], timestamp: stream.message_at ?? at })
    if (stream.public_message_id) closed.add(stream.public_message_id)
    stream = { content: '', closed_public_ids: [...closed] }
  }
  if (event.type === 'assistant_message_boundary') {
    if (event.payload.boundary === 'start' && id && !closed.has(id) && id !== stream.public_message_id) {
      flush(); stream = { ...stream, public_message_id: id, message_at: at }
    } else if (['end', 'interrupted'].includes(String(event.payload.boundary)) && id === stream.public_message_id) flush()
  } else if (event.type === 'message_delta' && typeof event.payload.text === 'string') {
    if (id && closed.has(id)) return { stream, finished }
    if (id !== stream.public_message_id) { flush(); stream = { ...stream, public_message_id: id, message_at: at } }
    stream.content += event.payload.text
    stream.message_at ??= at
  } else if (event.type === 'completed' || event.type === 'error' || event.type === 'message_completed') flush()
  return { stream, finished }
}

/** Main already guards receipt generations. This second guard prevents a stopped/old run
 * and duplicate IPC deliveries from reviving UI state. Missing legacy metadata is not guessed. */
export function createEventAdmission() {
  const sessions = new Map<string, { active?: string; started: number; closed: Set<string>; seen: Set<string>; generations: Map<string, number> }>()
  return (event: AgentEvent): boolean => {
    let state = sessions.get(event.session_id)
    if (!state) { state = { started: 0, closed: new Set(), seen: new Set(), generations: new Map() }; sessions.set(event.session_id, state) }
    if (state.seen.has(event.event_id)) return false
    const client = typeof event.payload.client_message_id === 'string' ? event.payload.client_message_id : undefined
    const generation = typeof event.payload.run_generation === 'number' ? event.payload.run_generation : 1
    if (client && generation < (state.generations.get(client) ?? 0)) return false
    const key = typeof event.payload.run_id === 'string' ? event.payload.run_id : client ? `${client}:${generation}` : undefined
    if (key && state.closed.has(key)) {
      const passive = event.type === 'user_decision_required' || event.type === 'stage_changed' && ['ready', 'sketch_ready', 'completed', 'blocked_for_user_decision'].includes(String(event.payload.stage))
      if (key !== state.active || !passive) return false
    }
    const at = Date.parse(event.created_at)
    // Legacy host exits are still unkeyed. Old exits/text cannot close or split a
    // newer identified run, even if IPC replays them under a new event ID.
    if (!key && state.active && ['completed', 'error', 'message_delta', 'assistant_message_boundary', 'thinking_delta', 'stage_changed', 'user_decision_required', 'tool_call_started', 'tool_call_completed', 'retrying'].includes(event.type) && (!Number.isFinite(at) || at < state.started)) return false
    if (key && key !== state.active) {
      if (at < state.started) return false
      if (state.active) state.closed.add(state.active)
      state.active = key; state.started = at
    }
    if (client) state.generations.set(client, generation)
    state.seen.add(event.event_id)
    if (state.seen.size > 16384) state.seen.delete(state.seen.values().next().value!)
    if ((event.type === 'completed' || event.type === 'error') && state.active) state.closed.add(state.active)
    return true
  }
}
