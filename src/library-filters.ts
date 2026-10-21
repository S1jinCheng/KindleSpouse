import type { Candidate } from './shared'

export interface LibraryFilters { query: string; shelf: string; format: string; author: string; source: string }
export const emptyLibraryFilters: LibraryFilters = { query: '', shelf: '全部', format: '', author: '', source: '' }
const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
const progressOf = (book: Candidate) => book.deviceProgress ?? book.progress
export const libraryGroupKey = (book: Candidate) => `${normalized(book.title)}|${normalized(book.author)}`
export function libraryAuthors(value: string) {
  const names = value.split(/[、;；]/).map(name => name.trim()).filter(Boolean)
  return names.length ? names.map(label => ({ value: /^(unknown|未知|作者信息未提供)$/i.test(label) ? 'unknown' : `name:${normalized(label)}`, label: /^(unknown|未知|作者信息未提供)$/i.test(label) ? '未提供作者' : label })) : [{ value: 'unknown', label: '未提供作者' }]
}
export function parseLibraryFilters(value: string | null): LibraryFilters {
  try {
    const saved = JSON.parse(value ?? '{}')
    return Object.fromEntries(Object.entries(emptyLibraryFilters).map(([key, fallback]) => [key, typeof saved?.[key] === 'string' && saved[key].length <= 2000 ? saved[key] : fallback])) as unknown as LibraryFilters
  } catch { return { ...emptyLibraryFilters } }
}
export function filterLibrary(books: Candidate[], filters: LibraryFilters) {
  const query = normalized(filters.query)
  return books.filter(book => {
    const progress = progressOf(book)
    return normalized(`${book.title} ${book.author}`).includes(query)
      && (!filters.format || book.format === filters.format)
      && (!filters.author || libraryAuthors(book.author).some(author => author.value === filters.author))
      && (!filters.source || book.source === filters.source)
      && (filters.shelf === '全部' || book.collection === filters.shelf
        || filters.shelf === '正在读' && progress > 0 && !book.finished && progress < 0.98
        || filters.shelf === '已读' && (book.finished || progress >= 0.98)
        || filters.shelf === '文章' && ['txt', 'md', 'html', 'htm', 'xhtml', 'htmlz'].includes(book.format))
  })
}
