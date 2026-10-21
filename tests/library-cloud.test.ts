import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppCore } from '../electron/core'
import { CloudBridge } from '../electron/cloud'
import { contentHash, transferFilename } from '../electron/books'
import type { StoredCandidate } from '../src/shared'

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Library preparation or upload did not finish')
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-library-cloud-'))
  const core = new AppCore({ directory: root, nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
  const account = randomUUID(), remote = new Map<string, Buffer>()
  core.store.put('clouds', account, { id: account, provider: 'drive', name: 'Test drive', connected: true })
  core.sync.ensureBookFolder = async () => {}
  core.cloud.uploadManyAndVerify = async (_account, folder, files, onVerify) => {
    assert.equal(_account, account)
    for (const file of files) {
      const content = await readFile(file.source)
      assert.equal(contentHash(content), file.sha256)
      remote.set(folder + '/' + file.name, content)
    }
    onVerify()
  }
  const add = async (title: string, library = true) => {
    const filename = path.join(root, title + '.txt')
    await writeFile(filename, `${title} is a complete document for explicit library upload.`)
    const id = await core.importFile(filename)
    core.store.put('candidates', id, { ...core.book(id), library })
    return core.book(id)
  }
  const finish = () => waitFor(() => !core.snapshot().libraryCloudSync?.working && core.snapshot().jobs.every(job => ['cloud_ready', 'failed'].includes(job.status)))
  const close = async () => { await core.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) }
  return { root, core, account, remote, add, finish, close }
}

test('long transfer names preserve the content fingerprint and fit the Kindle UTF-8 filename limit', () => {
  const title = '相同的很长中文书名'.repeat(30)
  const first = transferFilename(title + '版本一', 'a'.repeat(64), 'epub'), second = transferFilename(title + '版本二', 'b'.repeat(64), 'epub')
  assert.notEqual(first, second)
  assert.ok(first.endsWith('_aaaaaaaaaaaa.epub'))
  assert.ok(Buffer.byteLength('aaaaaaaaaaaa-' + first, 'utf8') < 255)
  assert.equal(transferFilename('Short title', 'a'.repeat(64), 'pdf'), 'Short title_aaaaaaaaaaaa.pdf')
})

test('startup repairs pending batch names and preserves verified cloud paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-library-path-upgrade-'))
  const options = { directory: root, nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} }
  let core = new AppCore(options)
  try {
    const filename = path.join(root, 'book.txt')
    await writeFile(filename, 'Original document for pending queue path migration.')
    const id = await core.importFile(filename), book = core.book(id), title = '长文件名'.repeat(40), jobId = randomUUID(), verifiedId = randomUUID()
    core.store.put('candidates', id, { ...book, title, library: true })
    const job = { id: jobId, batchId: randomUUID(), candidateId: id, sha256: book.sha256, title, method: 'cloud', target: 'fixture', cloudAccountId: 'fixture', status: 'queued', progress: 0, createdAt: new Date().toISOString(), remotePath: 'KindleSpouse/Inbox/old-truncated-name.txt' }
    core.store.put('jobs', jobId, job)
    core.store.put('jobs', verifiedId, { ...job, id: verifiedId, status: 'cloud_ready', progress: 1 })
    await core.close()
    core = new AppCore(options)
    assert.equal(core.snapshot().jobs.find(job => job.id === jobId)?.remotePath, 'KindleSpouse/Inbox/' + transferFilename(title, book.sha256, 'txt'))
    assert.equal(core.snapshot().jobs.find(job => job.id === verifiedId)?.remotePath, job.remotePath)
    assert.equal(contentHash(await readFile(book.path)), book.sha256)
  } finally { await core.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) }
})

test('explicit whole-library sync preserves originals, reuses KFX copies and excludes trials and notebook resources', async () => {
  const env = await setup()
  try {
    const original = await env.add('Original personal document'), copy = await env.add('Readable personal document'), normal = await env.add('Normal book')
    await env.add('Unconfirmed trial', false)
    env.core.store.put('candidates', original.id, { ...original, format: 'kfx', fromDevice: true })
    env.core.store.put('candidates', copy.id, { ...copy, fromDevice: true, derivedFromHash: original.sha256, derivedFromId: original.id })
    const resource = { ...normal, id: randomUUID(), fromDevice: true, path: path.join(env.root, '.notebooks/thumbnails/private.png'), format: 'png' } as StoredCandidate
    env.core.store.put('candidates', resource.id, resource)
    const readable = env.core.readableBook.bind(env.core)
    let conversions = 0
    env.core.readableBook = async id => { if (id !== original.id) return readable(id); conversions++; return env.core.book(copy.id) }
    await assert.rejects(env.core.approve({ candidateId: normal.id, sha256: normal.sha256, method: 'cloud', cloudAccountId: env.account }), /先打开/)
    const batch = env.core.syncLibraryToCloud(env.account)
    assert.equal(env.core.syncLibraryToCloud(env.account), batch)
    await env.finish()
    const state = env.core.snapshot()
    assert.equal(state.libraryCloudSync?.total, 2)
    assert.equal(state.libraryCloudSync?.queued, 2)
    assert.equal(state.libraryCloudSync?.failures.length, 0)
    assert.equal(conversions, 1)
    assert.equal(state.jobs.length, 2)
    assert.ok(state.jobs.every(job => job.batchId === batch && job.status === 'cloud_ready' && !job.deviceReceivedAt))
    assert.deepEqual(new Set(state.jobs.map(job => job.candidateId)), new Set([copy.id, normal.id]))
    assert.equal(contentHash(await readFile(original.path)), original.sha256)
    assert.equal(env.core.book(original.id).format, 'kfx')
    for (const job of state.jobs) {
      const manifest = JSON.parse(env.remote.get(`KindleSpouse/Sync/outbox/${job.id}.json`)!.toString())
      assert.equal(manifest.sha256, job.sha256)
      assert.equal(manifest.bytes, env.core.book(job.candidateId).bytes)
      assert.equal(contentHash(env.remote.get(manifest.remotePath)!), job.sha256)
    }
    env.core.syncLibraryToCloud(env.account)
    await env.finish()
    assert.equal(env.core.snapshot().jobs.length, 2)
    assert.equal(env.core.snapshot().libraryCloudSync?.queued, 0)
    assert.equal(env.core.snapshot().libraryCloudSync?.skipped, 2)
  } finally { await env.close() }
})

test('whole-library preparation reports changed or protected files while healthy books continue', async () => {
  const env = await setup()
  try {
    const changed = await env.add('Changed book'), protectedBook = await env.add('Protected book'), valid = await env.add('Valid book')
    await writeFile(changed.path, 'Changed after indexing')
    env.core.store.put('candidates', protectedBook.id, { ...protectedBook, warnings: ['平台 DRM'] })
    env.core.syncLibraryToCloud(env.account)
    await env.finish()
    assert.equal(env.core.snapshot().libraryCloudSync?.failures.length, 2)
    assert.equal(env.core.snapshot().jobs.length, 1)
    assert.equal(env.core.snapshot().jobs[0].candidateId, valid.id)
    assert.equal(env.core.snapshot().jobs[0].status, 'cloud_ready')
  } finally { await env.close() }
})

test('legacy native imports restore protection warnings without changing original titles or bytes', async () => {
  const env = await setup()
  try {
    const bytes = Buffer.alloc(200)
    bytes.write('BOOKMOBI', 60)
    bytes.writeUInt16BE(1, 76)
    bytes.writeUInt32BE(88, 78)
    bytes.writeUInt16BE(1, 88)
    bytes.writeUInt16BE(1, 100)
    const filename = path.join(env.root, 'dictionary.azw')
    await writeFile(filename, bytes)
    const id = await env.core.importFile(filename)
    const original = { ...env.core.book(id), title: 'Device dictionary title', author: 'Device dictionary author', library: true, fromDevice: true, warnings: ['Original device file'] }
    env.core.store.put('candidates', id, original)
    await env.core.refreshLibraryReadability()
    assert.ok(env.core.book(id).warnings.some(warning => warning.includes('平台 DRM')))
    assert.deepEqual({ ...env.core.book(id), warnings: original.warnings }, original)
    assert.deepEqual(await readFile(original.path), bytes)
    let opened = false
    env.core.koreader.open = async () => { opened = true; throw new Error('Protected file reached reader') }
    await assert.rejects(env.core.openKoreader(id), /平台 DRM/)
    assert.equal(opened, false)
    env.core.store.put('candidates', id, original)
    env.core.syncLibraryToCloud(env.account)
    await env.finish()
    assert.equal(env.core.snapshot().jobs.length, 0)
    assert.equal(env.core.snapshot().libraryCloudSync?.failures.length, 1)
    assert.ok(env.core.book(id).warnings.some(warning => warning.includes('平台 DRM')))
    assert.deepEqual(await readFile(original.path), bytes)
  } finally { await env.close() }
})

test('bulk upload drains later preparation batches while the first batch is still transferring', async () => {
  const env = await setup()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    for (let index = 0; index < 18; index++) await env.add(`Batch book ${index}`)
    const upload = env.core.cloud.uploadManyAndVerify.bind(env.core.cloud)
    let first = true
    env.core.cloud.uploadManyAndVerify = async (...args) => {
      assert.ok(args[2].length <= 8)
      if (first) { first = false; await held }
      return upload(...args)
    }
    env.core.syncLibraryToCloud(env.account)
    await waitFor(() => !env.core.snapshot().libraryCloudSync?.working)
    assert.equal(env.core.snapshot().libraryCloudSync?.queued, 18)
    release()
    await env.finish()
    assert.equal(env.core.snapshot().jobs.length, 18)
    assert.ok(env.core.snapshot().jobs.every(job => job.status === 'cloud_ready'))
  } finally { release(); await env.close() }
})

test('failed bulk uploads retry without duplicate jobs and changing the destination creates a distinct transfer', async () => {
  const env = await setup()
  try {
    await env.add('Retry book')
    const upload = env.core.cloud.uploadManyAndVerify.bind(env.core.cloud)
    let failing = true
    env.core.cloud.uploadManyAndVerify = async (...args) => { if (failing) throw new Error('Test network unavailable'); return upload(...args) }
    env.core.syncLibraryToCloud(env.account)
    await env.finish()
    assert.equal(env.core.snapshot().jobs[0].status, 'failed')
    const id = env.core.snapshot().jobs[0].id
    failing = false
    env.core.syncLibraryToCloud(env.account)
    await env.finish()
    assert.equal(env.core.snapshot().jobs.length, 1)
    assert.equal(env.core.snapshot().jobs[0].id, id)
    assert.equal(env.core.snapshot().jobs[0].status, 'cloud_ready')
    await env.core.saveSettings({ cloudFolder: 'KindleSpouse/OtherInbox' })
    env.core.syncLibraryToCloud(env.account)
    await env.finish()
    assert.equal(env.core.snapshot().jobs.length, 2)
    assert.ok(env.core.snapshot().jobs.some(job => job.remotePath?.startsWith('KindleSpouse/OtherInbox/')))
  } finally { await env.close() }
})

test('batch cloud transfer shares a connection, checks every returned hash and rejects unsafe names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-cloud-batch-')), remote = new Map<string, Buffer>(), commands: string[][] = []
  let corrupt = false, verifies = 0
  const cloud = new CloudBridge('fixture', root, { get: () => JSON.stringify({ provider: 'drive', token: {} }), set: () => {} }, async () => {}, async (_exe, args) => {
    commands.push(args)
    assert.equal(args[0], 'copy')
    assert.equal(args[args.indexOf('--transfers') + 1], '4')
    const names = (await readFile(args[args.indexOf('--files-from-raw') + 1], 'utf8')).trim().split('\n')
    for (const name of names) {
      if (args[1].startsWith('remote:')) await writeFile(path.join(args[2], name), corrupt ? Buffer.from('altered') : remote.get(name)!)
      else remote.set(name, await readFile(path.join(args[1], name)))
    }
    return ''
  })
  try {
    const source = path.join(root, 'source.txt'), content = Buffer.from('Verified complete document')
    await writeFile(source, content)
    const files = [{ source, name: '中文书籍.txt', sha256: contentHash(content) }]
    await cloud.uploadManyAndVerify('account', 'KindleSpouse/Inbox', files, () => { verifies++ })
    assert.equal(commands.length, 2)
    assert.equal(verifies, 1)
    corrupt = true
    await assert.rejects(cloud.uploadManyAndVerify('account', 'KindleSpouse/Inbox', files, () => {}), /回读校验/)
    assert.deepEqual(await readdir(root), ['source.txt'])
    for (const name of ['../escape.txt', 'nested/file.txt', 'C:\\escape.txt', 'line\nbreak.txt']) await assert.rejects(cloud.uploadManyAndVerify('account', 'KindleSpouse/Inbox', [{ ...files[0], name }], () => {}))
    await assert.rejects(cloud.uploadManyAndVerify('account', 'KindleSpouse/Inbox', [files[0], files[0]], () => {}))
  } finally { await cloud.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }) }
})
