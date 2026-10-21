import test from 'node:test'
import assert from 'node:assert/strict'
import type { Candidate } from '../src/shared'
import { emptyLibraryFilters, filterLibrary, libraryAuthors, libraryGroupKey, parseLibraryFilters } from '../src/library-filters'

const book = (id: string, fields: Partial<Candidate>): Candidate => ({ id, title: '同一本书', author: '原作者', format: 'epub', filename: id + '.epub', bytes: 1, sha256: id, createdAt: '2026-01-01T00:00:00Z', source: '本地导入', chapters: 1, warnings: [], library: true, progress: 0, ...fields })
const books = [book('epub', {}), book('kfx', { format: 'kfx', source: 'Kindle 私有导入' }), book('pdf', { format: 'pdf', author: '原作者、合作作者', source: '个人网盘', deviceProgress: 0.4 }), book('article', { title: '文章', format: 'md', author: 'Unknown', collection: '摘录', finished: true })]

test('format filtering happens before edition grouping so a matching KFX cannot open the EPUB edition', () => {
  assert.equal(new Set(books.slice(0, 2).map(libraryGroupKey)).size, 1)
  assert.deepEqual(filterLibrary(books, { ...emptyLibraryFilters, format: 'kfx' }).map(book => book.id), ['kfx'])
  assert.deepEqual(filterLibrary(books, { ...emptyLibraryFilters, format: 'epub' }).map(book => book.id), ['epub'])
})

test('author, format, source, text and reading-state filters intersect on the same file', () => {
  const filters = { ...emptyLibraryFilters, query: '同一本', format: 'pdf', author: libraryAuthors('合作作者')[0].value, source: '个人网盘', shelf: '正在读' }
  assert.deepEqual(filterLibrary(books, filters).map(book => book.id), ['pdf'])
  assert.deepEqual(filterLibrary(books, { ...filters, source: '本地导入' }), [])
  assert.deepEqual(filterLibrary(books, { ...emptyLibraryFilters, shelf: '文章', author: 'unknown' }).map(book => book.id), ['article'])
  assert.deepEqual(filterLibrary(books, { ...emptyLibraryFilters, shelf: '已读' }).map(book => book.id), ['article'])
  assert.equal(filterLibrary(books, { ...emptyLibraryFilters }).length, 4)
})

test('author matching tolerates width and whitespace, preserves comma names and groups missing metadata', () => {
  assert.equal(libraryAuthors(' Ａｕｔｈｏｒ ')[0].value, libraryAuthors('Author')[0].value)
  assert.equal(libraryAuthors('Smith, John').length, 1)
  for (const author of ['', 'Unknown', '未知', '作者信息未提供']) assert.equal(libraryAuthors(author)[0].value, 'unknown')
  assert.notEqual(libraryAuthors('佚名')[0].value, 'unknown')
})

test('persisted filters preserve supported fields and ignore broken or unexpected local data', () => {
  assert.deepEqual(parseLibraryFilters(null), emptyLibraryFilters)
  assert.deepEqual(parseLibraryFilters('broken'), emptyLibraryFilters)
  assert.deepEqual(parseLibraryFilters('{"format":"mobi","query":4,"source":null,"author":false,"extra":"ignored"}'), { ...emptyLibraryFilters, format: 'mobi' })
})
