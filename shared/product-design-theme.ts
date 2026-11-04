/** Shared semantic values only: no product layout, business flow or renderer dependency. */
export const DEFAULT_PRODUCT_THEME = {
  schema_version: 1 as const,
  id: 'bloma-workspace-20261104',
  colors: {
    surface: '#fffefb', surfaceMuted: '#f3f3f0', primary: '#6d8268', primarySoft: '#e7ece3',
    focus: '#52694c', selected: '#dfe8da', text: '#30342f', textMuted: '#686e65',
    textSecondary: '#62685f', border: '#dfe2d9',
  },
}
export type ProductDesignTheme = typeof DEFAULT_PRODUCT_THEME

export function validateProductTheme(value: unknown): asserts value is ProductDesignTheme {
  const row = value as ProductDesignTheme | undefined
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.schema_version !== 1
    || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.id)
    || Object.keys(row).some(key => !['schema_version', 'id', 'colors'].includes(key))
    || !row.colors || typeof row.colors !== 'object' || Array.isArray(row.colors)
    || Object.keys(row.colors).length !== Object.keys(DEFAULT_PRODUCT_THEME.colors).length
    || Object.keys(DEFAULT_PRODUCT_THEME.colors).some(key => !/^#[a-fA-F0-9]{6}$/.test((row.colors as Record<string, string>)[key] ?? ''))) {
    throw Error('PRODUCT_THEME_INVALID')
  }
}

export function snapshotProductTheme(value: unknown = DEFAULT_PRODUCT_THEME): ProductDesignTheme {
  validateProductTheme(value)
  return structuredClone(value)
}

export function workspaceThemeVariables(theme: ProductDesignTheme = DEFAULT_PRODUCT_THEME): Record<string, string> {
  validateProductTheme(theme)
  const c = theme.colors
  return { '--color-text': c.text, '--color-surface': c.surface, '--color-surface-muted': c.surfaceMuted,
    '--color-quick': c.primary, '--color-quick-soft': c.primarySoft, '--color-longterm': c.primary,
    '--color-longterm-soft': c.primarySoft, '--color-primary': c.primary, '--color-focus': c.focus,
    '--workspace-selected': c.selected, '--glass-bg-soft': c.surfaceMuted, '--glass-bg-strong': c.surface,
    '--color-text-muted': c.textMuted, '--color-text-secondary': c.textSecondary, '--color-border': c.border }
}
