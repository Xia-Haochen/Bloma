/** Selector bindings may identify existing controls, never execute test code. */
export function isStaticGuiSelector(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 512 && !value.includes('\0')
    && !/>>|(?:javascript|xpath|internal|text)\s*=|:has-text\(|\{|\}/i.test(value)
}
