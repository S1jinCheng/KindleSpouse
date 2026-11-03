import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from '../electron/store'
import { NotebookLibrary } from '../electron/notes'
import { contentHash } from '../electron/books'
import type { StoredNotebook } from '../src/shared'

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-note-identity-'))
  const store = new Store(root), notes = new NotebookLibrary(store, root, root, () => {})
  const snapshot = async (name: string, deviceId: string | undefined, value = 'Generated notebook', relative = '.notebooks/Notes.pdf', createdAt = '2026-10-20T12:00:00Z') => {
    const directory = path.join(root, name), bytes = Buffer.from(relative.endsWith('/nbk') ? 'SQLite format 3\0' + value : '%PDF-1.4\n' + value)
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
    await writeFile(path.join(directory, relative), bytes)
    await writeFile(path.join(directory, 'snapshot-manifest.json'), JSON.stringify({ deviceId, createdAt, files: [{ relative, bytes: bytes.length, sha256: contentHash(bytes) }] }))
    return { directory, relative, bytes, sha256: contentHash(bytes), filename: path.join(directory, relative) }
  }
  const close = async () => { await notes.close(); store.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) }
  return { root, store, notes, snapshot, close }
}

for (const sameBytes of [false, true]) test(`different devices keep independent notebook identities with ${sameBytes ? 'identical' : 'different'} bytes`, async () => {
  const env = await setup()
  try {
    const a = await env.snapshot('a', 'device-a'), b = await env.snapshot('b', 'device-b', sameBytes ? 'Generated notebook' : 'Different original')
    await env.notes.importSnapshot(a.directory)
    await env.notes.importSnapshot(b.directory)
    assert.equal(env.notes.notebooks().length, 2)
    await env.notes.importSnapshot(a.directory)
    await env.notes.importSnapshot(b.directory)
    assert.equal(env.notes.notebooks().length, 2)
    assert.deepEqual(await readFile(a.filename), a.bytes)
    assert.deepEqual(await readFile(b.filename), b.bytes)
  } finally { await env.close() }
})

test('same-device USB and cloud imports retain ID, manual title and reading position', async () => {
  const env = await setup()
  try {
    const usb = await env.snapshot('usb', 'paired-device'), cloud = await env.snapshot('cloud', 'paired-device', 'Updated content')
    await env.notes.importSnapshot(usb.directory)
    const original = env.store.list<StoredNotebook>('notebooks')[0]
    env.store.put('notebooks', original.id, { ...original, title: 'My notebook title', titleSource: 'manual', location: 'pdf:2' })
    await env.notes.importSnapshot(cloud.directory)
    const books = env.store.list<StoredNotebook>('notebooks')
    assert.equal(books.length, 1)
    assert.equal(books[0].id, original.id)
    assert.equal(books[0].title, 'My notebook title')
    assert.equal(books[0].location, 'pdf:2')
    assert.equal(books[0].path, cloud.filename)
  } finally { await env.close() }
})

for (const identified of [false, true]) test(`legacy ${identified ? 'identified' : 'unidentified'} notebook keeps personal fields when another device imports first`, async () => {
  const env = await setup()
  try {
    const old = await env.snapshot('old', identified ? 'device-b' : undefined, 'Original B'), incoming = await env.snapshot('incoming', 'device-a')
    const id = randomUUID()
    const original: StoredNotebook = { id, title: 'Original personal title', titleSource: 'manual', location: 'pdf:3', sourceKey: contentHash(Buffer.from(old.relative)), path: old.filename, sha256: old.sha256, bytes: old.bytes.length, classification: 'notebook', format: 'pdf', status: 'ready', pdfPath: old.filename, pdfHash: old.sha256, importedAt: '2026-01-01' }
    env.store.put('notebooks', id, original)
    await env.notes.importSnapshot(incoming.directory)
    const preserved = env.store.get<StoredNotebook>('notebooks', id)
    assert.equal(preserved?.title, original.title)
    assert.equal(preserved?.location, original.location)
    assert.equal(preserved?.path, old.filename)
    assert.equal(env.notes.notebooks().length, 2)
    await env.notes.importSnapshot(old.directory)
    assert.equal(env.notes.notebooks().length, 2)
    assert.equal(env.store.get<StoredNotebook>('notebooks', id)?.id, id)
    assert.ok((await readdir(path.join(env.root, 'migration-backups'))).some(name => name.endsWith('.sqlite')))
  } finally { await env.close() }
})

for (const invalid of ['missing', 'corrupt']) test(`${invalid} legacy provenance never discards or guesses notebook ownership`, async () => {
  const env = await setup()
  try {
    const old = await env.snapshot('old', 'device-b'), incoming = await env.snapshot('new', 'device-a')
    const manifest = path.join(old.directory, 'snapshot-manifest.json')
    if (invalid === 'missing') await rm(manifest)
    else await writeFile(manifest, 'broken JSON')
    const id = randomUUID()
    const original: StoredNotebook = { id, title: 'Keep this title', titleSource: 'manual', path: old.filename, sha256: old.sha256, bytes: old.bytes.length, sourceKey: contentHash(Buffer.from(old.relative)), format: 'pdf', status: 'ready', importedAt: '2026-01-01' }
    env.store.put('notebooks', id, original)
    await env.notes.importSnapshot(incoming.directory)
    assert.deepEqual(env.store.get('notebooks', id), original)
    assert.equal(env.notes.notebooks().length, 2)
  } finally { await env.close() }
})

test('device catalogs only update their own notebooks and never replace manual titles', async () => {
  const env = await setup()
  try {
    const identity = randomUUID(), relative = `.notebooks/${identity}/nbk`
    const a = await env.snapshot('a', 'device-a', 'A', relative), b = await env.snapshot('b', 'device-b', 'B', relative)
    await env.notes.importSnapshot(a.directory)
    await env.notes.importSnapshot(b.directory)
    const records = env.store.list<StoredNotebook>('notebooks')
    const first = records.find(book => book.path === a.filename), second = records.find(book => book.path === b.filename)
    assert.ok(first && second)
    const catalog = new DatabaseSync(path.join(a.directory, 'ksdk.content.db'))
    catalog.exec('CREATE TABLE Nodes(uuid TEXT,title_collation TEXT,node_type TEXT)')
    catalog.prepare('INSERT INTO Nodes VALUES(?,?,?)').run(identity, 'Device A title', 'STANDALONE_NOTEBOOK')
    catalog.close()
    await env.notes.matchTitles(a.directory, 'device-a')
    assert.equal(env.store.get<StoredNotebook>('notebooks', first.id)?.title, 'Device A title')
    assert.equal(env.store.get<StoredNotebook>('notebooks', second.id)?.title, '未识别标题')
    env.notes.rename(first.id, 'Manual title')
    await env.notes.matchTitles(a.directory, 'device-a')
    assert.equal(env.store.get<StoredNotebook>('notebooks', first.id)?.title, 'Manual title')
  } finally { await env.close() }
})

test('one-time notebook recovery restores collided device entries without replaying annotations', async () => {
  const env = await setup()
  try {
    const a = await env.snapshot('cloud-snapshots/device-a/current', 'device-a', 'A')
    const b = await env.snapshot('cloud-snapshots/device-b/current', 'device-b', 'B')
    await env.snapshot('cloud-snapshots/device-a/older', 'device-a', 'Old A', a.relative, '2025-01-01T00:00:00Z')
    await env.snapshot('device-backups/newer-library-only', 'device-a', 'Library only', 'Books/Book.txt', '2026-10-21T12:00:00Z')
    const id = randomUUID()
    env.store.put('notebooks', id, { id, title: 'Preserved title', titleSource: 'manual', location: 'pdf:2', sourceKey: contentHash(Buffer.from(b.relative)), path: b.filename, sha256: b.sha256, bytes: b.bytes.length, format: 'pdf', status: 'ready', importedAt: '2026-01-01' } satisfies StoredNotebook)
    const annotation = { id: 'unchanged', text: 'Current annotation', origin: { deleted: true } }
    env.store.put('reading-notes', annotation.id, annotation)
    await env.notes.recoverDeviceNotebooks()
    assert.equal(env.notes.notebooks().length, 2)
    assert.equal(env.store.get<StoredNotebook>('notebooks', id)?.title, 'Preserved title')
    assert.equal(env.store.get<StoredNotebook>('notebooks', id)?.location, 'pdf:2')
    assert.ok(env.store.list<StoredNotebook>('notebooks').some(book => book.path === a.filename))
    assert.deepEqual(env.store.get('reading-notes', annotation.id), annotation)
    await env.notes.recoverDeviceNotebooks()
    assert.equal(env.notes.notebooks().length, 2)
  } finally { await env.close() }
})

test('startup recovery never replays an old notebook over a concurrently received current version', async () => {
  const env = await setup()
  let release = () => {}
  let reached = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const paused = new Promise<void>(resolve => { reached = resolve })
  try {
    await env.snapshot('cloud-snapshots/device-a/old', 'device-a', 'Old snapshot')
    const backup = env.store.backup.bind(env.store)
    env.store.backup = async filename => { await backup(filename); if (filename.includes('before-notebook-recovery-')) { reached(); await held } }
    const recovering = env.notes.recoverDeviceNotebooks()
    await paused
    const current = await env.snapshot('cloud-snapshots/device-a/current', 'device-a', 'Current contents', '.notebooks/Notes.pdf', '2026-10-21T12:00:00Z')
    await env.notes.importSnapshot(current.directory)
    const original = env.store.list<StoredNotebook>('notebooks')[0]
    env.notes.rename(original.id, 'Current title')
    release()
    await recovering
    const recovered = env.store.list<StoredNotebook>('notebooks')
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].sha256, current.sha256)
    assert.equal(recovered[0].path, current.filename)
    assert.equal(recovered[0].title, 'Current title')
  } finally { release(); await env.close() }
})
