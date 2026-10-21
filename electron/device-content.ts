export function deviceContentRole(value: string): 'book' | 'notebook' | 'resource' {
  const parts = value.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean)
  const filename = parts.at(-1) ?? ''
  if (parts.some(part => part.endsWith('.sdr')) || filename === 'my clippings.txt') return 'resource'
  const notebook = parts.indexOf('.notebooks')
  if (notebook < 0) return 'book'
  const relative = parts.slice(notebook + 1)
  if (relative.some(part => ['thumbnails', 'templates', '.backups', 'clipboard', 'page_cache'].includes(part))) return 'resource'
  return filename === 'nbk' || /\.(?:nbk|pdf)$/.test(filename) ? 'notebook' : 'resource'
}

export function isLibraryBook(book: { fromDevice?: boolean; path?: string } | undefined) {
  return Boolean(book && (!book.fromDevice || !book.path || deviceContentRole(book.path) === 'book'))
}
