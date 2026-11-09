/** Redact values before JSON encoding so text patterns cannot consume JSON delimiters or escapes. */
export function serializeRedactedJson(value: unknown, redact: (text: string) => string): string {
  return JSON.stringify(value, (key, item) => typeof item === 'string'
    ? /^(?:api[_-]?key|authorization|password|access[_-]?token|refresh[_-]?token|token|secret|cookie|set-cookie)$/i.test(key) ? '[REDACTED]' : redact(item)
    : item) ?? 'null'
}
