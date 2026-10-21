import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'luaparse'
import { contentHash, MAX_BOOK_BYTES } from './books'
import { Store } from './store'
import { runProcess } from './process'
import { notebookIdentity, readNotebookTitles } from './notebook-titles'
import { mergeNote } from './annotation-edits'
import { isLibraryBook } from './device-content'
import type { Notebook, ReadingNote, StoredNotebook, StoredCandidate } from '../src/shared'

const noteId = (note: Omit<ReadingNote, 'id'>) =>
  contentHash(
    Buffer.from(JSON.stringify([note.source, note.bookTitle, note.kind, note.location, note.text, note.note])),
  )

export function parseClippings(text: string): ReadingNote[] {
  const notes = new Map<string, ReadingNote>()
  for (const block of text.replace(/^\uFEFF/, '').split(/^={8,}\s*$/m)) {
    const lines = block.trim().split(/\r?\n/)
    if (lines.length < 2 || !lines[1].trim().startsWith('-')) continue
    const heading = lines[0].trim()
    const author = heading.match(/\s*[（(]([^()（）]+)[）)]\s*$/)?.[1]
    const metadata = lines[1].replace(/^-\s*/, '')
    const kind = /bookmark|书签/i.test(metadata)
      ? 'bookmark'
      : /\bnote\b|笔记|笔錄/i.test(metadata)
        ? 'note'
        : 'highlight'
    const fields = metadata.split('|').map((value) => value.trim())
    const dateIndex = fields.findIndex((value) => /added|添加|加入/i.test(value))
    const note: Omit<ReadingNote, 'id'> = {
      bookTitle: author ? heading.replace(/\s*[（(][^()（）]+[）)]\s*$/, '') : heading,
      author,
      text: lines.slice(2).join('\n').trim(),
      kind,
      location: fields.filter((value, index) => index !== dateIndex).join(' · '),
      addedAt: dateIndex >= 0 ? fields[dateIndex] : undefined,
      source: 'kindle',
      anchor: { format: 'epub', page: Number(metadata.match(/第\s*(\d+)(?:\s*[-–]\s*\d+)?\s*页|\bpage\s+(\d+)/i)?.slice(1).find(Boolean)) || undefined },
    }
    if (!note.bookTitle || (!note.text && note.kind !== 'bookmark')) continue
    const id = noteId(note)
    notes.set(id, { ...note, id })
  }
  return [...notes.values()]
}

function luaString(raw: string) {
  const bracket = raw.match(/^\[(=*)\[/)
  if (bracket) return raw.slice(bracket[0].length, -bracket[0].length).replace(/^\r?\n/, '')
  const body = raw.slice(1, -1)
  const parts: Buffer[] = []
  let start = 0
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== '\\') continue
    parts.push(Buffer.from(body.slice(start, index)))
    const tail = body.slice(index + 1)
    const decimal = tail.match(/^\d{1,3}/)?.[0]
    const hex = tail.match(/^x([0-9a-f]{2})/i)
    if (decimal) {
      parts.push(Buffer.from([Number(decimal) % 256]))
      index += decimal.length
    } else if (hex) {
      parts.push(Buffer.from([parseInt(hex[1], 16)]))
      index += 3
    } else if (tail[0] === 'z') {
      index += tail.match(/^z\s*/)?.[0].length ?? 1
    } else {
      const character = tail[0] ?? ''
      parts.push(Buffer.from(escapes[character] ?? character))
      index++
    }
    start = index + 1
  }
  parts.push(Buffer.from(body.slice(start)))
  return Buffer.concat(parts).toString('utf8')
}

export function koreaderData(source: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(source) > 10 * 1024 * 1024) throw new Error('KOReader 笔记资料超过读取上限。')
  const tree = parse(source, { luaVersion: '5.3' })
  let count = 0
  const literal = (node: unknown, depth = 0): unknown => {
    if (!node || typeof node !== 'object' || depth > 60 || ++count > 200000) throw new Error('笔记资料的结构过于复杂。')
    const value = node as Record<string, unknown>
    if (value.type === 'StringLiteral') return luaString(String(value.raw))
    if (value.type === 'NumericLiteral' || value.type === 'BooleanLiteral') return value.value
    if (value.type === 'NilLiteral') return null
    if (value.type === 'UnaryExpression' && value.operator === '-') return -Number(literal(value.argument, depth + 1))
    if (value.type !== 'TableConstructorExpression') return undefined
    const table: Record<string, unknown> = Object.create(null)
    let position = 1
    for (const rawField of value.fields as Record<string, unknown>[]) {
      let key: string
      if (rawField.type === 'TableValue') key = String(position++)
      else if (rawField.type === 'TableKeyString') key = String((rawField.key as Record<string, unknown>).name)
      else key = String(literal(rawField.key, depth + 1))
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
      table[key] = literal(rawField.value, depth + 1)
    }
    return table
  }
  const returned = tree.body.find((node) => node.type === 'ReturnStatement')
  if (!returned || returned.type !== 'ReturnStatement') return undefined
  const data = literal(returned.arguments[0]) as Record<string, unknown> | undefined
  return data
}

export function parseKoreaderState(source: string, fallbackTitle: string) {
  const data = koreaderData(source)
  const properties = data?.doc_props as Record<string, unknown> | undefined
  const summary = data?.summary as Record<string, unknown> | undefined
  return {
    title: typeof properties?.title === 'string' ? properties.title : fallbackTitle,
    progress:
      typeof data?.percent_finished === 'number' && data.percent_finished >= 0 && data.percent_finished <= 1
        ? data.percent_finished
        : undefined,
    position: typeof data?.last_xpointer === 'string' ? data.last_xpointer : undefined,
    finished: summary?.status === 'complete',
  }
}

export function parseKoreaderNotes(source: string, fallbackTitle: string): ReadingNote[] {
  const data = koreaderData(source)
  if (!data) return []
  const properties = data.doc_props as Record<string, unknown> | undefined
  const bookTitle = typeof properties?.title === 'string' ? properties.title : fallbackTitle
  const author = typeof properties?.authors === 'string' ? properties.authors : undefined
  const result = new Map<string, ReadingNote>()
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 30) return
    const item = value as Record<string, unknown>
    if (
      (typeof item.text === 'string' || typeof item.note === 'string' || typeof item.datetime === 'string') &&
      ('page' in item || 'pageno' in item || 'pos0' in item || 'drawer' in item)
    ) {
      const page = typeof item.pageno === 'number' ? item.pageno : typeof item.page === 'number' ? item.page : undefined
      const note: Omit<ReadingNote, 'id'> = {
        bookTitle,
        author,
        text: typeof item.text === 'string' ? item.text : '',
        note: typeof item.note === 'string' ? item.note : undefined,
        kind: item.drawer ? 'highlight' : item.note ? 'note' : item.text ? 'highlight' : 'bookmark',
        location: String(item.pageno ?? item.page ?? item.pos0 ?? ''),
        addedAt: typeof item.datetime === 'string' ? item.datetime : undefined,
        source: 'koreader',
        anchor: {
          format: /\.pdf$/i.test(fallbackTitle) ? 'pdf' : 'epub',
          page,
          sourcePosition: typeof item.pos0 === 'string' ? item.pos0 : undefined,
          endPosition: typeof item.pos1 === 'string' ? item.pos1 : undefined,
          quote: typeof item.text === 'string' ? item.text : undefined,
        },
      }
      const id = noteId(note)
      result.set(id, { ...note, id })
      return
    }
    for (const child of Object.values(item)) visit(child, depth + 1)
  }
  if (data.annotations && typeof data.annotations === 'object') visit(data.annotations)
  else { visit(data.highlight); visit(data.bookmarks) }
  return [...result.values()]
}

export function notesMarkdown(notes: ReadingNote[]) {
  const books = new Map<string, ReadingNote[]>()
  for (const original of notes) {
    if (original.edit?.deleted || original.origin?.deleted) continue
    const note = { ...original, note: original.edit?.note ?? original.note }
    books.set(note.bookTitle, [...(books.get(note.bookTitle) ?? []), note])
  }
  return (
    '# Kindle 阅读笔记\n\n' +
    [...books]
      .map(
        ([title, items]) =>
          `## ${title.replace(/[\r\n]/g, ' ')}\n\n` +
          items
            .map(
              (note) =>
                `### ${note.kind === 'highlight' ? '标注' : note.kind === 'bookmark' ? '书签' : '笔记'}${note.location ? ' · ' + note.location.replace(/[\r\n]/g, ' ') : ''}\n\n${note.text || '（书签）'}${note.note ? '\n\n笔记：' + note.note : ''}\n\n${note.addedAt ?? ''}\n`,
            )
            .join('\n'),
      )
      .join('\n')
  )
}

export class NotebookLibrary {
  private conversions = new Map<string, Promise<Uint8Array>>()
  constructor(
    private store: Store,
    private directory: string,
    private nativeDirectory: string,
    private changed: () => void,
  ) {
    for (const book of this.store.list<StoredNotebook>('notebooks'))
      if (book.status === 'converting')
        this.store.put('notebooks', book.id, {
          ...book,
          status: 'original',
          error: '上次转换中断，打开笔记时会重新生成。',
        })
    for (const book of this.store.list<StoredNotebook>('notebooks'))
      if (book.format === 'pdf' && !book.classification)
        this.store.put('notebooks', book.id, { ...book, classification: 'notebook', titleSource: 'metadata' })
  }

  async close() {
    await Promise.allSettled([...this.conversions.values()])
  }

  notebooks(): Notebook[] {
    return this.store
      .list<StoredNotebook>('notebooks')
      .map(({ path: original, pdfPath, pdfHash, sourceKey, ...book }) => book)
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN', { numeric: true }))
  }
  notes() {
    return this.store.list<ReadingNote>('reading-notes')
  }
  rename(id: string, title: string) {
    this.store.put('notebooks', id, { ...this.book(id), title: title.trim(), titleSource: 'manual' })
    this.changed()
  }
  link(id: string, bookId: string) {
    const note = this.store.get<ReadingNote>('reading-notes', id)
    const book = this.store.get<StoredCandidate>('candidates', bookId)
    if (!note || !book || !isLibraryBook(book)) throw new Error('找不到标注或书籍。')
    this.store.put('reading-notes', id, {
      ...note,
      bookId,
      bookHash: book.sha256,
      anchor: { ...note.anchor, format: book.format === 'pdf' ? 'pdf' : 'epub', quote: note.text },
    })
    this.changed()
  }
  private book(id: string) {
    const book = this.store.get<StoredNotebook>('notebooks', id)
    if (!book) throw new Error('没有找到这本笔记。')
    return book
  }

  saveReading(id: string, location: string) {
    this.store.put('notebooks', id, { ...this.book(id), location })
    this.changed()
  }

  async importFile(filename: string) {
    const info = await stat(filename)
    if (!info.isFile() || info.size > MAX_BOOK_BYTES) throw new Error('笔记文件超过 200 MB 上限或不是文件。')
    const bytes = await readFile(filename)
    const format = path.extname(filename).toLowerCase() === '.pdf' ? 'pdf' : 'nbk'
    if (
      format === 'pdf'
        ? !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))
        : !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))
    )
      throw new Error('请选择完整的笔记 PDF 或 Scribe nbk 原始文件。')
    const sha256 = contentHash(bytes)
    const duplicate = this.store.list<StoredNotebook>('notebooks').find((book) => book.sha256 === sha256)
    if (duplicate) return duplicate.id
    const directory = path.join(this.directory, 'notebooks', 'originals', sha256)
    await mkdir(directory, { recursive: true })
    const destination = path.join(directory, format === 'pdf' ? 'notebook.pdf' : 'nbk')
    await writeFile(destination, bytes)
    const id = randomUUID()
    this.store.put('notebooks', id, {
      id,
      title: path.basename(filename, path.extname(filename)),
      titleSource: 'manual',
      classification: 'notebook',
      sha256,
      bytes: info.size,
      importedAt: new Date().toISOString(),
      path: destination,
      sourceKey: sha256,
      format,
      status: format === 'pdf' ? 'ready' : 'original',
      pdfPath: format === 'pdf' ? destination : undefined,
      pdfHash: format === 'pdf' ? sha256 : undefined,
    } satisfies StoredNotebook)
    this.changed()
    return id
  }

  async importSnapshot(snapshot: string) {
    const root = path.resolve(snapshot)
    const manifest = JSON.parse(await readFile(path.join(root, 'snapshot-manifest.json'), 'utf8')) as {
      deviceId?: string
      files: { relative: string; bytes: number; sha256: string }[]
    }
    let notebookCount = 0,
      noteCount = 0,
      unreadable = 0
    for (const file of manifest.files) {
      const relative = file.relative.replaceAll('\\', '/')
      const isNotebook = /^\.notebooks\/.+\/nbk$/i.test(relative)
      const isPdf = /^\.notebooks\/.*\.pdf$/i.test(relative)
      const isClippings = /(?:^|\/)My Clippings\.txt$/i.test(relative)
      const isLua = /\.sdr\/metadata\.[^/]+\.lua$/i.test(relative)
      if (!isNotebook && !isPdf && !isClippings && !isLua) continue
      const filename = path.resolve(root, relative)
      if (!filename.startsWith(root + path.sep) || file.bytes > MAX_BOOK_BYTES)
        throw new Error('笔记快照含无效路径或过大的文件。')
      const bytes = await readFile(filename)
      if (bytes.length !== file.bytes || contentHash(bytes) !== file.sha256)
        throw new Error('笔记快照校验失败，原件已保留。')
      if (isNotebook || isPdf) {
        const sourceKey = contentHash(Buffer.from(relative))
        const existing = this.store.list<StoredNotebook>('notebooks').find((book) => book.sourceKey === sourceKey)
        const id = existing?.id ?? randomUUID()
        const unchanged = existing?.sha256 === file.sha256
        const format = isPdf ? 'pdf' : 'nbk'
        const title =
          existing && ['manual', 'device'].includes(existing.titleSource ?? '')
            ? existing.title
            : isPdf
              ? path.basename(relative, '.pdf')
              : '未识别标题'
        const parent = path.posix.basename(path.posix.dirname(relative))
        const classification = /(?:^|\/)(?:\.backups|clipboard|page_cache)\//i.test(relative)
          ? 'auxiliary'
          : /!!(?:PDOC|EBOK)!!notebook$/i.test(parent)
            ? 'attachment'
            : isPdf
              ? 'notebook'
              : (existing?.classification ?? 'unknown')
        this.store.put('notebooks', id, {
          ...existing,
          id,
          title,
          classification,
          identity: parent,
          titleSource:
            existing && ['manual', 'device'].includes(existing.titleSource ?? '')
              ? existing.titleSource
              : isPdf
                ? 'metadata'
                : 'unresolved',
          sha256: file.sha256,
          bytes: file.bytes,
          importedAt: new Date().toISOString(),
          path: filename,
          sourceKey,
          format,
          status: unchanged && existing?.status === 'ready' ? 'ready' : format === 'pdf' ? 'ready' : 'original',
          pdfPath: format === 'pdf' ? filename : unchanged ? existing?.pdfPath : undefined,
          pdfHash: format === 'pdf' ? file.sha256 : unchanged ? existing?.pdfHash : undefined,
          error: undefined,
        } satisfies StoredNotebook)
        notebookCount++
      } else {
        try {
          const notes = isClippings
            ? parseClippings(bytes.toString('utf8'))
            : parseKoreaderNotes(bytes.toString('utf8'), path.basename(path.dirname(filename)).replace(/\.sdr$/i, ''))
          const seen = new Set(notes.map(note => mergeNote(this.store, note, relative, manifest.deviceId)))
          if (isLua) for (const old of this.notes()) {
            if (old.origin?.relative !== relative || old.origin.deviceId !== manifest.deviceId || seen.has(old.id)) continue
            this.store.put('reading-notes', old.id, { ...old, origin: { ...old.origin, deleted: true },
              edit: old.edit && !old.edit.deleted && ['queued', 'uploaded'].includes(old.edit.status) ? { ...old.edit, status: 'conflict', error: '设备端已删除此标注。' } : old.edit })
          }
          if (isLua) {
            const state = parseKoreaderState(
              bytes.toString('utf8'),
              path.basename(path.dirname(filename)).replace(/\.sdr$/i, ''),
            )
            const matches = this.store
              .list<StoredCandidate>('candidates')
              .filter((book) => isLibraryBook(book) && book.title.normalize('NFKC') === state.title.normalize('NFKC'))
            if (matches.length === 1)
              this.store.put('candidates', matches[0].id, {
                ...matches[0],
                deviceProgress: state.progress,
                koreaderPosition: state.position,
                finished: matches[0].finished || state.finished,
              })
          }
          noteCount += notes.length
        } catch {
          unreadable++
        }
      }
    }
    await this.classify()
    this.matchTitles(root)
    this.linkBooks()
    this.changed()
    return {
      notebooks: this.notebooks().filter((book) => book.classification === 'notebook').length,
      annotations: noteCount,
      files: manifest.files.length,
      unreadable,
    }
  }

  linkBooks() {
    const books = this.store.list<StoredCandidate>(
      'candidates',
    ).filter(isLibraryBook)
    const normalize = (value: string) =>
      value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\p{P}\p{Z}\p{S}]/gu, '')
    for (const note of this.notes()) {
      if (
        note.bookId &&
        books.some((book) => book.id === note.bookId && (!note.bookHash || book.sha256 === note.bookHash))
      )
        continue
      const matches = books.filter((book) => normalize(book.title) === normalize(note.bookTitle))
      const authorMatches = matches.filter((book) => note.author && normalize(book.author) === normalize(note.author))
      const match = matches.length === 1 ? matches[0] : authorMatches.length === 1 ? authorMatches[0] : undefined
      if (match)
        this.store.put('reading-notes', note.id, {
          ...note,
          bookId: match.id,
          bookHash: match.sha256,
          anchor: { ...note.anchor, format: match.format === 'pdf' ? 'pdf' : 'epub', quote: note.text },
        })
    }
  }

  async classify() {
    const inspector = path.join(this.nativeDirectory, 'tools', 'notebook-converter', 'inspect.mjs')
    if (!existsSync(inspector)) return
    const books = this.store.list<StoredNotebook>('notebooks').filter((book) => book.format === 'nbk')
    if (!books.length) return
    const scratch = path.join(this.directory, 'scratch')
    await mkdir(scratch, { recursive: true })
    const input = path.join(scratch, `inspect-${randomUUID()}.json`)
    await writeFile(input, JSON.stringify(books.map((book) => ({ key: book.id, path: book.path }))))
    try {
      const output = await runProcess(process.execPath, [inspector, input], {
        timeout: 180000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      const values = JSON.parse(output) as {
        key: string
        pages: number
        kind: Notebook['classification']
        title?: string
        identity?: string
        error?: string
      }[]
      for (const value of values) {
        const book = this.book(value.key)
        const attachment = /!!(?:PDOC|EBOK)!!notebook/i.test(book.path)
        const classification = /[\\/](?:\.backups|clipboard|page_cache)[\\/]/i.test(book.path)
          ? 'auxiliary'
          : attachment
            ? value.pages
              ? 'attachment'
              : 'auxiliary'
            : value.kind
        const parentIdentity = path.basename(path.dirname(book.path))
        const identity = /^[0-9a-f-]{36}$|!!(?:PDOC|EBOK)!!notebook$/i.test(parentIdentity)
          ? parentIdentity
          : (book.identity ?? value.identity ?? parentIdentity)
        const thumbnailPath = path.resolve(path.dirname(book.path), '..', 'thumbnails', identity + '.png')
        let thumbnail = book.thumbnail
        if (existsSync(thumbnailPath)) {
          const image = await readFile(thumbnailPath)
          if (image.length < 1024 * 1024 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            thumbnail = 'data:image/png;base64,' + image.toString('base64')
        }
        this.store.put('notebooks', book.id, {
          ...book,
          classification,
          pages: value.pages,
          thumbnail,
          title: ['manual', 'device'].includes(book.titleSource ?? '') ? book.title : (value.title ?? '未识别标题'),
          titleSource: ['manual', 'device'].includes(book.titleSource ?? '')
            ? book.titleSource
            : value.title
              ? 'metadata'
              : 'unresolved',
          identity,
          error: value.kind === 'unknown' ? '格式待识别，原件保留在本机' : book.error,
        })
      }
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(input, { force: true }))
    }
    this.changed()
  }

  matchTitles(snapshot: string) {
    const titles = new Map<string, string>()
    const errors: string[] = []
    let catalogs = 0
    for (const name of ['cc.db', 'ksdk.content.db']) {
      const filename = path.join(snapshot, name)
      if (!existsSync(filename)) continue
      try {
        for (const [identity, title] of readNotebookTitles(filename)) titles.set(identity, title)
        catalogs++
      } catch { errors.push('设备标题索引读取失败，请重新采集标题。') }
    }
    for (const book of this.store.list<StoredNotebook>('notebooks')) {
      if (book.titleSource === 'manual' || !book.identity) continue
      const title = titles.get(notebookIdentity(book.identity))
      if (title) this.store.put('notebooks', book.id, { ...book, title, titleSource: 'device' })
    }
    const result = { catalogs, records: titles.size, error: titles.size ? undefined : errors[0], updatedAt: new Date().toISOString() }
    this.store.put('notebook-title-status', 'main', result)
    this.changed()
    return result
  }

  titleStatus() {
    const notebooks = this.notebooks().filter((book) => book.classification === 'notebook' && book.format === 'nbk')
    const matched = notebooks.filter((book) => ['device', 'manual'].includes(book.titleSource ?? '')).length
    return { ...this.store.get<{ catalogs: number; records: number; error?: string; updatedAt: string }>('notebook-title-status', 'main'), total: notebooks.length, matched }
  }

  preview(id: string) {
    const current = this.conversions.get(id)
    if (current) return current
    const operation = this.prepare(id).finally(() => this.conversions.delete(id))
    this.conversions.set(id, operation)
    return operation
  }

  private async prepare(id: string) {
    let book = this.book(id)
    if (contentHash(await readFile(book.path)) !== book.sha256) throw new Error('笔记原始文件已变化，请重新导入。')
    if (!book.pdfPath || !existsSync(book.pdfPath)) {
      const converter = path.join(this.nativeDirectory, 'tools', 'notebook-converter', 'cli.mjs')
      if (!existsSync(converter)) throw new Error('尚未安装本地笔记转换器，原始笔记已保留。')
      const directory = path.join(this.directory, 'notebooks', 'previews', book.sha256)
      await mkdir(directory, { recursive: true })
      const destination = path.join(directory, 'notebook.pdf')
      this.store.put('notebooks', id, { ...book, status: 'converting', error: undefined })
      this.changed()
      try {
        await runProcess(process.execPath, [converter, book.path, '--output', destination, '--force', '--quiet'], {
          timeout: 180000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        const bytes = await readFile(destination)
        if (!bytes.subarray(0, 32).includes(Buffer.from('%PDF-')) || bytes.length > MAX_BOOK_BYTES)
          throw new Error('Invalid converted PDF')
        const pages = [...bytes.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length
        book = {
          ...this.book(id),
          pdfPath: destination,
          pdfHash: contentHash(bytes),
          pages,
          status: 'ready',
          error: undefined,
        }
        this.store.put('notebooks', id, book)
        this.changed()
      } catch {
        this.store.put('notebooks', id, {
          ...this.book(id),
          status: 'failed',
          error: '当前笔记变体无法转换，原件已完整保留。可导入 Kindle 导出的 PDF。',
        })
        this.changed()
        throw new Error('这本笔记暂时无法生成 PDF，原始资料已保留；可尝试导入设备导出的 PDF。')
      }
    }
    const bytes = await readFile(book.pdfPath!)
    if (contentHash(bytes) !== book.pdfHash) throw new Error('笔记预览文件已变化，请重新导入。')
    return new Uint8Array(bytes)
  }

  async exportPdf(id: string, destination: string) {
    const bytes = await this.preview(id)
    if (path.resolve(destination).toLowerCase() === path.resolve(this.book(id).path).toLowerCase())
      throw new Error('请选择其他导出位置，原始笔记需要保留。')
    await writeFile(destination, bytes)
    if (contentHash(await readFile(destination)) !== contentHash(bytes)) throw new Error('导出 PDF 校验失败。')
  }
}
