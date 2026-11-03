import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { AppCore } from '../electron/core'
import { contentHash } from '../electron/books'
import type { TransferJob } from '../src/shared'

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-integrity-'))
  const options = { directory: root, nativeDirectory: root, readerAutostart: false, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} }
  const core = new AppCore(options)
  const source = path.join(root, 'generated.txt')
  const bytes = Buffer.from('Generated document for durable data integrity checks.')
  await writeFile(source, bytes)
  const id = await core.importFile(source)
  let closed = false
  const closeCore = async () => { if (!closed) { await core.close(); closed = true } }
  const close = async () => { await closeCore(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) }
  return { root, options, core, source, bytes, id, close, closeCore }
}

for (const damaged of ['missing', 'corrupt']) test(`reimport repairs a ${damaged} indexed file without losing identity or personal fields`, async () => {
  const env = await setup()
  try {
    const original = { ...env.core.book(env.id), title: 'My title', author: 'My author', progress: 0.7, location: 'text:7', library: true, finished: true }
    env.core.store.put('candidates', env.id, original)
    env.core.store.put('reading-notes', 'preserved', { id: 'preserved', bookId: env.id, text: 'Personal annotation' })
    if (damaged === 'missing') await rm(original.path)
    else await writeFile(original.path, 'Keep these damaged original bytes')
    assert.equal(await env.core.importFile(env.source), env.id)
    const repaired = env.core.book(env.id)
    assert.deepEqual({ ...repaired, path: original.path }, original)
    assert.deepEqual(await readFile(repaired.path), env.bytes)
    assert.deepEqual(await readFile(env.source), env.bytes)
    if (damaged === 'corrupt') assert.equal(await readFile(original.path, 'utf8'), 'Keep these damaged original bytes')
    assert.equal(env.core.snapshot().candidates.length, 1)
    assert.deepEqual(env.core.store.get('reading-notes', 'preserved'), { id: 'preserved', bookId: env.id, text: 'Personal annotation' })
  } finally { await env.close() }
})

for (const damaged of ['missing', 'corrupt']) test(`snapshot recovery repairs a ${damaged} path and never reimports known corrupt bytes`, async () => {
  const env = await setup()
  try {
    const original = env.core.book(env.id)
    env.core.store.put('candidates', env.id, { ...original, library: true, progress: 0.5 })
    if (damaged === 'missing') await rm(original.path)
    else await writeFile(original.path, 'Retained corrupted copy')
    const snapshot = path.join(env.root, 'device-backups', 'verified')
    await mkdir(path.join(snapshot, 'documents'), { recursive: true })
    await writeFile(path.join(snapshot, 'documents', 'generated.txt'), env.bytes)
    await writeFile(path.join(snapshot, 'snapshot-manifest.json'), JSON.stringify({ deviceId: 'fixture', createdAt: new Date().toISOString(), files: [{ relative: 'documents/generated.txt', bytes: env.bytes.length, sha256: original.sha256 }] }))
    await env.core.recoverLibrary()
    await env.core.recoverLibrary()
    assert.deepEqual(await readFile(env.core.book(env.id).path), env.bytes)
    assert.equal(env.core.book(env.id).progress, 0.5)
    assert.equal(env.core.snapshot().candidates.length, 1)
    if (damaged === 'corrupt') assert.equal(await readFile(original.path, 'utf8'), 'Retained corrupted copy')
  } finally { await env.close() }
})

for (const occupied of ['absent', 'valid', 'different']) test(`failed collection stays uncommitted across restart with an ${occupied} destination`, async () => {
  const env = await setup()
  let reopened: AppCore | undefined
  try {
    const original = env.core.book(env.id)
    const destination = path.join(env.root, 'library', original.sha256, original.filename)
    const previous = occupied === 'valid' ? env.bytes : Buffer.from('Existing data that must survive')
    if (occupied !== 'absent') { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, previous) }
    const calibre = path.join(env.root, 'incomplete-calibre')
    await mkdir(calibre)
    await writeFile(path.join(calibre, 'calibredb.exe'), 'Generated presence marker')
    await env.core.saveSettings({ calibreDirectory: calibre })
    await assert.rejects(env.core.collect(env.id))
    assert.equal(env.core.book(env.id).library, false)
    assert.deepEqual(await readFile(original.path), env.bytes)
    assert.equal(existsSync(destination), occupied !== 'absent')
    if (occupied !== 'absent') assert.deepEqual(await readFile(destination), previous)
    await env.closeCore()
    reopened = new AppCore(env.options)
    await reopened.recoverLibrary()
    assert.equal(reopened.book(env.id).library, false)
    assert.equal(reopened.book(env.id).calibreId, undefined)
    await reopened.saveSettings({ calibreDirectory: '' })
    await reopened.collect(env.id)
    assert.equal(reopened.book(env.id).library, true)
    assert.deepEqual(await readFile(reopened.book(env.id).path), env.bytes)
    assert.equal(reopened.store.list('collection-intents').length, 0)
    if (occupied === 'different') assert.deepEqual(await readFile(destination), previous)
  } finally { await reopened?.close(); await env.close() }
})

test('legacy library files without pending collection remain recoverable', async () => {
  const env = await setup()
  try {
    env.core.store.remove('candidates', env.id)
    await rm(path.join(env.root, 'candidates'), { recursive: true, force: true })
    const legacy = path.join(env.root, 'library', 'legacy')
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, 'generated.txt'), env.bytes)
    await env.core.recoverLibrary()
    await env.core.recoverLibrary()
    assert.equal(env.core.snapshot().candidates.length, 1)
    assert.equal(env.core.snapshot().candidates[0].library, true)
  } finally { await env.close() }
})

test('cancelling a queued batch item while the first prepares never uploads or publishes it', async () => {
  const env = await setup()
  let release = () => {}
  let entered = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  try {
    const other = path.join(env.root, 'second.txt')
    await writeFile(other, 'A second generated document')
    const second = await env.core.importFile(other)
    const account = randomUUID(), batchId = randomUUID()
    const jobs: TransferJob[] = [env.id, second].map((candidateId, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, batchId, candidateId, sha256: env.core.book(candidateId).sha256, title: env.core.book(candidateId).title, method: 'cloud', target: account, cloudAccountId: account, remotePath: `KindleSpouse/Inbox/${i}.txt`, status: 'queued', progress: 0, createdAt: new Date().toISOString() }))
    for (const job of jobs) env.core.store.put('jobs', job.id, job)
    const collect = env.core.collect.bind(env.core)
    env.core.collect = async id => { if (id === env.id) { entered(); await held }; return collect(id) }
    const uploaded: string[] = [], published: string[] = []
    env.core.cloud.uploadManyAndVerify = async (_account, _folder, files, verify) => { uploaded.push(...files.map(file => file.name)); verify() }
    env.core.sync.publishBooks = async entries => { published.push(...entries.map(entry => entry.job.id)) }
    const processing = env.core.processJobs()
    await started
    await env.core.cancel(jobs[1].id)
    release()
    await processing
    assert.equal(env.core.store.get<TransferJob>('jobs', jobs[1].id)?.status, 'cancelled')
    assert.deepEqual(uploaded, ['0.txt'])
    assert.deepEqual(published, [jobs[0].id])
  } finally { release(); await env.close() }
})

test('a published collection survives a database failure without being silently committed on recovery', async () => {
  const env = await setup()
  let reopened: AppCore | undefined
  const database = new DatabaseSync(path.join(env.root, 'kindlespouse.sqlite'))
  try {
    database.exec("CREATE TRIGGER reject_collection BEFORE UPDATE ON records WHEN NEW.namespace = 'candidates' AND json_extract(NEW.payload, '$.library') = 1 BEGIN SELECT RAISE(ABORT, 'generated commit interruption'); END")
    await assert.rejects(env.core.collect(env.id), /generated commit interruption/)
    assert.equal(env.core.book(env.id).library, false)
    assert.equal(env.core.store.list('collection-intents').length, 1)
    const original = env.core.book(env.id)
    const published = path.join(env.root, 'library', original.sha256, original.filename)
    assert.deepEqual(await readFile(published), env.bytes)
    database.exec('DROP TRIGGER reject_collection')
    await env.closeCore()
    reopened = new AppCore(env.options)
    await reopened.recoverLibrary()
    assert.equal(reopened.book(env.id).library, false)
    await reopened.collect(env.id)
    assert.equal(reopened.book(env.id).library, true)
    assert.equal(reopened.store.list('collection-intents').length, 0)
    assert.deepEqual(await readFile(published), env.bytes)
  } finally { database.close(); await reopened?.close(); await env.close() }
})

test('snapshot validation preserves personal edits saved while recovery is running', async () => {
  const env = await setup()
  let release = () => {}
  let entered = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  try {
    const original = env.core.book(env.id)
    const snapshot = path.join(env.root, 'device-backups', 'concurrent')
    await mkdir(path.join(snapshot, 'documents'), { recursive: true })
    await writeFile(path.join(snapshot, 'documents', 'generated.txt'), env.bytes)
    await writeFile(path.join(snapshot, 'snapshot-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: [{ relative: 'documents/generated.txt', bytes: env.bytes.length, sha256: original.sha256 }] }))
    const validate = env.core['hasBookBytes'].bind(env.core)
    env.core['hasBookBytes'] = async book => { entered(); await gate; return validate(book) }
    const recovering = env.core.recoverLibrary()
    await started
    env.core.updateBook(env.id, { title: 'My saved title', collection: 'My collection' })
    await env.core.saveReading(env.id, 'text:42', 0.42)
    release()
    await recovering
    const recovered = env.core.book(env.id)
    assert.equal(recovered.title, 'My saved title')
    assert.equal(recovered.collection, 'My collection')
    assert.equal(recovered.location, 'text:42')
    assert.equal(recovered.progress, 0.42)
  } finally { release(); await env.close() }
})
