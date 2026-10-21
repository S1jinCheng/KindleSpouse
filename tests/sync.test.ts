import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { CloudBridge } from '../electron/cloud'
import { contentHash } from '../electron/books'
import { Store } from '../electron/store'
import { bundleEntries, SyncObjects, type SyncBundle, type SyncManifest } from '../electron/sync-objects'
import { CloudSync } from '../electron/sync'
import { NotebookLibrary } from '../electron/notes'
import { ReadingHistory } from '../electron/history'
import type { Settings } from '../src/shared'

async function bundle(values: Buffer[]) {
  const zip = new JSZip()
  for (const value of values) zip.file(contentHash(value), value)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { bytes, descriptor: { sha256: contentHash(bytes), bytes: bytes.length, objects: values.map(contentHash) } }
}

test('dedicated Kindle folder is created and verified per account, retries failed publication and rejects private sync overlap', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-book-folder-')), store = new Store(root)
  const cloud = new CloudBridge('unused', root, { get: () => undefined, set: () => {} }, async () => {})
  const notes = new NotebookLibrary(store, root, root, () => {})
  const settings: Settings = { sourceUrl: '', calibreDirectory: '', cloudFolder: 'KindleSpouse/Inbox', profile: { font: 'song', fontSize: 19, lineHeight: 1.8, margin: 20, paper: 'warm' } }
  const sync = new CloudSync(store, cloud, notes, new ReadingHistory(store), root, root, () => settings, () => {})
  let failed = true, creates = 0, writes = 0
  cloud.mutate = async (_account, mutation) => { assert.equal(mutation.action, 'mkdir'); assert.equal(mutation.path, settings.cloudFolder); creates++ }
  cloud.writeBytes = async (_account, filename, bytes) => {
    writes++
    assert.equal(filename, 'KindleSpouse/Sync/book-folder.json')
    assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()), { version: 1, folder: settings.cloudFolder })
    if (failed) throw new Error('Cloud unavailable')
  }
  try {
    await assert.rejects(sync.ensureBookFolder('first'), /Cloud unavailable/)
    failed = false
    await sync.ensureBookFolder('first')
    await sync.ensureBookFolder('first')
    assert.equal(writes, 2)
    assert.equal(creates, 2)
    await sync.ensureBookFolder('second')
    assert.equal(writes, 3)
    settings.cloudFolder = 'KindleSpouse/Reading'
    await sync.ensureBookFolder('first')
    assert.equal(writes, 4)
    for (const invalid of ['KindleSpouse', 'KindleSpouse/Sync', 'KindleSpouse/Sync/objects']) {
      settings.cloudFolder = invalid
      await assert.rejects(sync.ensureBookFolder('first'), /独立/)
    }
    assert.equal(writes, 4)
  } finally { await sync.close(); await notes.close(); await cloud.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('incremental snapshots batch changed objects, reuse verified local data, and repair damaged cache entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-bundles-')), store = new Store(root)
  const cloud = new CloudBridge('unused', root, { get: () => undefined, set: () => {} }, async () => {})
  const calls: string[][] = [], remote = new Map<string, Buffer>()
  cloud.downloadMany = async (account, folder, names, destination) => {
    if (!names.length) return
    calls.push(names)
    for (const name of names) await writeFile(path.join(destination, name), remote.get(name)!)
  }
  try {
    const original = Buffer.from('Original handwritten notebook'), annotation = Buffer.from('One highlighted sentence')
    const first = await bundle([original, annotation])
    remote.set(first.descriptor.sha256 + '.zip', first.bytes)
    const files = [original, annotation].map((bytes, index) => ({ relative: index ? 'documents/article.sdr/metadata.epub.lua' : '.notebooks/example/nbk', bytes: bytes.length, sha256: contentHash(bytes) }))
    const manifest: SyncManifest = { version: 2, deviceId: randomUUID(), createdAt: new Date().toISOString(), files, bundles: [first.descriptor] }
    let crossDeviceCopies = 0
    const objects = new SyncObjects(root, store, cloud, async () => { crossDeviceCopies++; throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' }) })
    await objects.materialize('account', 'Sync', manifest, path.join(root, 'snapshot-1'))
    assert.equal(calls.length, 1)
    assert.equal(crossDeviceCopies, 2)
    assert.equal(calls[0].length, 1)
    const changed = Buffer.from('Updated highlighted sentence'), second = await bundle([changed])
    remote.set(second.descriptor.sha256 + '.zip', second.bytes)
    const next = { ...manifest, files: [files[0], { ...files[1], bytes: changed.length, sha256: contentHash(changed) }], bundles: [first.descriptor, second.descriptor] }
    await objects.materialize('account', 'Sync', next, path.join(root, 'snapshot-2'))
    assert.deepEqual(calls[1], [second.descriptor.sha256 + '.zip'])
    await objects.materialize('account', 'Sync', next, path.join(root, 'snapshot-2'))
    assert.equal(calls.length, 2)
    await writeFile(path.join(root, 'cloud-objects', contentHash(changed)), Buffer.alloc(changed.length))
    await objects.materialize('account', 'Sync', next, path.join(root, 'snapshot-3'))
    assert.equal(calls.length, 2)
    assert.deepEqual(await readFile(path.join(root, 'snapshot-3', files[1].relative)), changed)
    assert.deepEqual(await readFile(path.join(root, 'snapshot-1', files[0].relative)), original)
  } finally { await cloud.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('batch downloads write only to the unverified staging area and show concise transfer failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-batch-download-'))
  const cloud = new CloudBridge('unused', root, { get: () => JSON.stringify({ provider: 'drive', token: {} }), set: () => {} }, async () => {}, async (executable, args) => {
    assert.ok(args.includes('--inplace'))
    assert.ok(args.includes('--ignore-times'))
    assert.ok(args.includes('--files-from-raw'))
    throw new Error(JSON.stringify({ stats: { bytes: 16, lastError: 'Network interrupted' } }))
  })
  try {
    await assert.rejects(cloud.downloadMany('account', 'Sync/bundles', ['a'.repeat(64) + '.zip'], path.join(root, 'pending')), (error: Error) => error.message.includes('Network interrupted') && !error.message.includes('stats'))
  } finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
})

test('completed bundles survive a failed batch and only missing bundles are retried', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-bundle-retry-')), store = new Store(root)
  const cloud = new CloudBridge('unused', root, { get: () => undefined, set: () => {} }, async () => {})
  try {
    const values = [Buffer.from('First notebook'), Buffer.from('Second notebook')], packs = await Promise.all(values.map((value) => bundle([value])))
    const manifest: SyncManifest = { version: 2, deviceId: randomUUID(), createdAt: new Date().toISOString(), files: values.map((value, index) => ({ relative: `.notebooks/${index}/nbk`, bytes: value.length, sha256: contentHash(value) })), bundles: packs.map((pack) => pack.descriptor) }
    let attempts = 0
    cloud.downloadMany = async (account, folder, names, destination) => {
      if (!names.length) return
      attempts++
      if (attempts === 1) {
        await writeFile(path.join(destination, names[0]), packs[0].bytes)
        throw new Error('Connection interrupted')
      }
      assert.deepEqual(names, [packs[1].descriptor.sha256 + '.zip'])
      await writeFile(path.join(destination, names[0]), packs[1].bytes)
    }
    const objects = new SyncObjects(root, store, cloud), destination = path.join(root, 'snapshot')
    await assert.rejects(objects.materialize('account', 'Sync', manifest, destination), /interrupted/)
    await objects.materialize('account', 'Sync', manifest, destination)
    assert.equal(attempts, 2)
    for (const [index, bytes] of values.entries()) assert.deepEqual(await readFile(path.join(destination, `.notebooks/${index}/nbk`)), bytes)
  } finally { await cloud.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('sync bundles reject altered data, traversal, symlinks, forged expansion sizes and duplicate destinations', async () => {
  const value = Buffer.from('Notebook original'), valid = await bundle([value])
  assert.equal(bundleEntries(valid.bytes, valid.descriptor).get(contentHash(value)), value.length)
  assert.throws(() => bundleEntries(Buffer.from('altered'), valid.descriptor), /校验失败/)
  const cases = [
    { name: '../' + contentHash(value), mode: 0o100644 },
    { name: contentHash(value), mode: 0o120777 },
  ]
  for (const item of cases) {
    const zip = new JSZip().file(item.name, value, { unixPermissions: item.mode, createFolders: false })
    const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
    assert.throws(() => bundleEntries(bytes, { ...valid.descriptor, sha256: contentHash(bytes), bytes: bytes.length }), /无效/)
  }
  const forged = Buffer.from(valid.bytes), central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  forged.writeUInt32LE(201 * 1024 ** 2, central + 24)
  assert.throws(() => bundleEntries(forged, { ...valid.descriptor, sha256: contentHash(forged), bytes: forged.length }), /无效/)
  const root = await mkdtemp(path.join(tmpdir(), 'KS-bundle-paths-')), store = new Store(root)
  const cloud = new CloudBridge('unused', root, { get: () => undefined, set: () => {} }, async () => {})
  try {
    const file = { relative: '.notebooks/a/nbk', bytes: value.length, sha256: contentHash(value) }
    const manifest = { version: 2, deviceId: randomUUID(), createdAt: new Date().toISOString(), files: [file, file], bundles: [] as SyncBundle[] }
    await assert.rejects(new SyncObjects(root, store, cloud).materialize('account', 'Sync', manifest, path.join(root, 'snapshot')), /重复/)
  } finally { store.close(); await cloud.close(); await rm(root, { recursive: true, force: true }) }
})
