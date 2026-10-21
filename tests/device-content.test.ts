import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppCore } from '../electron/core'
import { Store } from '../electron/store'
import { contentHash } from '../electron/books'
import { deviceContentRole } from '../electron/device-content'
import { avatarPng } from './image-fixture.mjs'
import type { StoredCandidate, StoredNotebook } from '../src/shared'

const options = (directory: string) => ({ directory, nativeDirectory: directory, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {}, douban: { search: async () => [] } })
const candidate = (filename: string, bytes: Buffer): StoredCandidate => ({ id: randomUUID(), title: path.basename(filename), author: 'Unknown', path: filename, filename: path.basename(filename), format: 'png', sha256: contentHash(bytes), bytes: bytes.length, createdAt: new Date().toISOString(), source: 'Kindle 私有导入', fromDevice: true, library: true, chapters: 0, warnings: [], progress: 0 })

test('device roles use directory provenance while ordinary image books and notebook-named PDFs stay readable', () => {
  for (const filename of ['.notebooks/thumbnails/uuid.png', 'C:\\backup\\.NOTEBOOKS\\Templates\\paper.PNG', '.notebooks/.backups/uuid/notebook.pdf', 'documents/book.epub.sdr/cover.png', 'documents/My Clippings.txt']) assert.equal(deviceContentRole(filename), 'resource')
  for (const filename of ['.notebooks/uuid/nbk', '.notebooks/uuid/export.pdf']) assert.equal(deviceContentRole(filename), 'notebook')
  for (const filename of ['Books/uuid.png', 'documents/Notebook.pdf', 'Books/.notebooks-guide.epub', 'Books/手写笔记.pdf']) assert.equal(deviceContentRole(filename), 'book')
})

for (const calibre of [false, true]) test(`snapshot recovery separates notebook assets from books with ${calibre ? 'Calibre metadata' : 'fallback metadata'}`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-separate-snapshot-'))
  const core = new AppCore(options(directory))
  const snapshot = path.join(directory, 'cloud-snapshots/device/current')
  const files = [
    { relative: 'Books/图文读物.png', bytes: avatarPng(32) },
    { relative: 'documents/文章.txt', bytes: Buffer.from('A real article') },
    { relative: '.notebooks/thumbnails/uuid.png', bytes: avatarPng(64) },
    { relative: '.notebooks/templates/ruled.png', bytes: avatarPng(96) },
    { relative: '.notebooks/uuid/学习笔记.pdf', bytes: Buffer.from('%PDF-1.4\nNotebook original') },
    { relative: 'documents/book.epub.sdr/cover.png', bytes: avatarPng(128) },
  ]
  try {
    for (const file of files) { await mkdir(path.dirname(path.join(snapshot, file.relative)), { recursive: true }); await writeFile(path.join(snapshot, file.relative), file.bytes) }
    const manifest = files.map(file => ({ relative: file.relative, bytes: file.bytes.length, sha256: contentHash(file.bytes) }))
    await writeFile(path.join(snapshot, 'snapshot-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: manifest }))
    if (calibre) {
      const tools = path.join(directory, 'calibre')
      await mkdir(tools)
      await writeFile(path.join(tools, 'calibredb.exe'), '')
      await core.saveSettings({ calibreDirectory: tools })
      const entries = manifest.map(file => ({ ...file, title: path.basename(file.relative), author: 'Fixture', format: path.extname(file.relative).slice(1) }))
      Object.assign(core, { calibre: async () => 'KINDLESPOUSE_LIBRARY ' + JSON.stringify(entries) })
    }
    await core.notebookLibrary.importSnapshot(snapshot)
    await core.recoverLibrary()
    await core.recoverLibrary()
    assert.deepEqual(core.snapshot().candidates.map(book => book.filename).sort(), ['图文读物.png', '文章.txt'])
    assert.equal(core.snapshot().notebooks.length, 1)
    assert.equal(core.snapshot().notebooks[0].title, '学习笔记')
    assert.equal(core.snapshot().jobs.length, 0)
    assert.equal(core.store.list('candidates').length, 2)
    for (const file of files) assert.deepEqual(await readFile(path.join(snapshot, file.relative)), file.bytes)
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})

test('legacy thumbnail records disappear from book APIs without changing originals, notebook titles or saved metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-separate-legacy-'))
  const photo = avatarPng(32), filename = path.join(directory, 'cloud-snapshots/device/old/.notebooks/thumbnails/uuid.png')
  const thumbnail = { ...candidate(filename, photo), title: 'uuid', collection: 'Old collection', finished: true, location: 'saved position' }
  const notebook: StoredNotebook = { id: randomUUID(), title: '我的学习笔记', titleSource: 'manual', classification: 'notebook', path: 'preserved-private-original', sourceKey: 'notebook-source', sha256: 'f'.repeat(64), bytes: 1, importedAt: new Date().toISOString(), format: 'nbk', status: 'original' }
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, photo)
  const store = new Store(directory)
  store.put('candidates', thumbnail.id, thumbnail)
  store.put('notebooks', notebook.id, notebook)
  store.put('jobs', 'published-thumbnail', { id: 'published-thumbnail', candidateId: thumbnail.id, status: 'published', createdAt: '2026-01-01T00:00:00Z' })
  store.close()
  const core = new AppCore(options(directory))
  try {
    assert.equal(core.snapshot().candidates.length, 0)
    assert.deepEqual(core.store.get('candidates', thumbnail.id), thumbnail)
    assert.equal(core.snapshot().notebooks[0].title, notebook.title)
    core.store.put('reading-notes', 'fixture-highlight', { id: 'fixture-highlight', bookTitle: 'uuid', source: 'kindle', kind: 'highlight', text: 'Keep this note with its actual book' })
    core.notebookLibrary.linkBooks()
    assert.equal(core.snapshot().readingNotes[0].bookId, undefined)
    assert.throws(() => core.notebookLibrary.link('fixture-highlight', thumbnail.id), /找不到/)
    assert.throws(() => core.book(thumbnail.id), /笔记与标注/)
    await assert.rejects(core.preview(thumbnail.id), /笔记与标注/)
    await assert.rejects(core.openKoreader(thumbnail.id), /笔记与标注/)
    assert.deepEqual((await core.searchDiscovery('uuid', 'catalog')).results, [])
    const opds = await core.catalog.start('127.0.0.1')
    const response = await fetch(opds.address, { headers: { Authorization: 'Basic ' + Buffer.from(opds.username + ':' + opds.password).toString('base64') } })
    assert.ok(!(await response.text()).includes('<entry>'))
    assert.deepEqual(await readFile(filename), photo)
    const manual = path.join(directory, 'My drawing.png')
    await writeFile(manual, photo)
    const id = await core.importFile(manual)
    assert.notEqual(id, thumbnail.id)
    assert.equal(core.snapshot().candidates.length, 1)
    assert.equal(core.book(id).fromDevice, undefined)
    assert.deepEqual(core.store.get('candidates', thumbnail.id), thumbnail)
    assert.deepEqual(core.store.get('notebooks', notebook.id), notebook)
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})
