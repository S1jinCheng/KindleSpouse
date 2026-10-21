import test from 'node:test'
import assert from 'node:assert/strict'
import { AutomaticCloudSync } from '../electron/auto-sync'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppCore } from '../electron/core'
import { contentHash } from '../electron/books'

test('automatic cloud sync deduplicates accounts, serializes work and backs off each failing account independently', async () => {
  let now = 0, online = true, failed = true
  const calls: string[] = []
  const sync = new AutomaticCloudSync(() => ['first', 'first', 'second'], () => online, async account => {
    calls.push(account)
    if (account === 'first' && failed) throw new Error('Offline')
  }, () => now)
  await sync.tick()
  assert.deepEqual(calls, ['first', 'second'])
  await sync.tick()
  assert.equal(calls.length, 2)
  now = 60000
  await sync.tick()
  assert.deepEqual(calls.slice(2), ['first', 'second'])
  now = 120000
  await sync.tick()
  assert.equal(calls.at(-1), 'second')
  assert.equal(calls.filter(account => account === 'first').length, 2)
  now = 180000
  failed = false
  await sync.tick()
  assert.deepEqual(calls.slice(-2), ['first', 'second'])
  online = false
  now = 240000
  const count = calls.length
  await sync.tick()
  assert.equal(calls.length, count)
  online = true
  await sync.tick()
  assert.equal(calls.length, count + 2)
  await sync.close()
  now = 300000
  await sync.tick()
  assert.equal(calls.length, count + 2)
})

test('automatic sync never overlaps and shutdown waits before storage can be closed', async () => {
  let finish!: () => void, calls = 0, closed = false
  const sync = new AutomaticCloudSync(() => ['account'], () => true, async () => {
    calls++
    await new Promise<void>(resolve => { finish = resolve })
  })
  const operation = sync.tick()
  assert.equal(sync.tick(), operation)
  const closing = sync.close().then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  finish()
  await closing
  await sync.tick()
  assert.equal(calls, 1)
})

test('background timer starts without opening a page, pauses while busy and stops on exit', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let enabled = false, calls = 0, now = 0
  const sync = new AutomaticCloudSync(() => ['account'], () => enabled, async () => { calls++ }, () => now)
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  sync.start()
  sync.start()
  context.mock.timers.tick(8000)
  await settle()
  assert.equal(calls, 0)
  enabled = true
  now = 60000
  context.mock.timers.tick(60000)
  await settle()
  assert.equal(calls, 1)
  await sync.close()
  now = 120000
  context.mock.timers.tick(60000)
  await settle()
  assert.equal(calls, 1)
})

test('application startup imports Kindle annotations automatically and leaves unchanged snapshots alone', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-auto-cloud-'))
  let usbCalls = 0, reads = 0, downloads = 0
  const core = new AppCore({ directory, nativeDirectory: directory, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {}, transport: {
    list: async () => { usbCalls++; return [] }, upload: async () => { usbCalls++; throw new Error('Unexpected USB access') },
  } })
  const account = randomUUID(), device = randomUUID(), now = new Date().toISOString()
  await core.saveSettings({ kindleMode: 'koreader' })
  const note = Buffer.from('return {doc_props={title="Automatic fixture"},annotations={{text="A synced highlight",note="A Kindle note",datetime="2026-10-19 12:00:00",pos0="/body/p[1]",pos1="/body/p[2]",pageno=2}},percent_finished=0.42}')
  const manifest = Buffer.from(JSON.stringify({ version: 1, deviceId: device, createdAt: now, files: [{ relative: 'Books/Inbox/Automatic fixture.sdr/metadata.epub.lua', bytes: note.length, sha256: contentHash(note) }] }))
  const remote = new Map([[contentHash(note), note], [contentHash(manifest) + '.json', manifest]])
  core.store.put('clouds', account, { id: account, name: 'Fixture Drive', provider: 'drive', connected: true })
  core.store.put('sync-devices', device, { id: device, accountId: account, name: 'Fixture Kindle', pairedAt: now, status: 'connected' })
  let created = false, configured = false
  core.cloud.mutate = async (_account, mutation) => { assert.deepEqual(mutation, { action: 'mkdir', path: 'KindleSpouse/Inbox' }); created = true }
  core.cloud.writeBytes = async (_account, filename, bytes) => {
    assert.equal(filename, 'KindleSpouse/Sync/book-folder.json')
    assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()), { version: 1, folder: 'KindleSpouse/Inbox' })
    configured = true
  }
  core.cloud.readSyncState = async id => {
    assert.equal(id, account)
    reads++
    return new Map([['latest.json', Buffer.from(JSON.stringify({ manifest: contentHash(manifest) }))]])
  }
  core.cloud.readBytes = async (_account, filename) => {
    const bytes = remote.get(path.posix.basename(filename))
    assert.ok(bytes)
    return bytes
  }
  core.cloud.downloadMany = async (_account, _folder, names, destination) => {
    downloads++
    await mkdir(destination, { recursive: true })
    for (const name of names) await writeFile(path.join(destination, name), remote.get(name)!)
  }
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    context.mock.timers.tick(8000)
    await settle()
    await core.sync.close()
    await settle()
    assert.equal(reads, 1)
    assert.ok(created && configured)
    assert.equal(usbCalls, 0)
    assert.equal(core.snapshot().readingNotes.length, 1)
    assert.equal(core.snapshot().readingNotes[0].note, 'A Kindle note')
    const snapshot = path.join(directory, 'cloud-snapshots', device, contentHash(manifest), 'Books/Inbox/Automatic fixture.sdr/metadata.epub.lua')
    assert.deepEqual(await readFile(snapshot), note)
    const firstDownloads = downloads
    await core.sync.sync(account, true)
    assert.equal(downloads, firstDownloads)
    assert.equal(core.snapshot().readingNotes.length, 1)
    await core.saveSettings({ autoCloudSync: false })
    context.mock.timers.tick(60000)
    await settle()
    assert.equal(reads, 2)
    assert.equal(usbCalls, 0)
  } finally {
    await core.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('new book receipts get a bounded quiet window before automatic note refresh resumes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-receipt-priority-'))
  const core = new AppCore({ directory, nativeDirectory: directory, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
  const account = randomUUID(), device = randomUUID(), job = randomUUID()
  await core.saveSettings({ kindleMode: 'koreader' })
  let checks = 0
  core.store.put('clouds', account, { id: account, name: 'Fixture Drive', provider: 'drive', connected: true })
  core.store.put('sync-devices', device, { id: device, accountId: account, name: 'Fixture Kindle', pairedAt: new Date().toISOString(), status: 'connected' })
  core.store.put('jobs', job, { id: job, candidateId: randomUUID(), title: 'Recently uploaded book', sha256: 'a'.repeat(64), method: 'cloud', cloudAccountId: account, target: account, status: 'cloud_ready', progress: 1, createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString() })
  core.cloud.mutate = async () => {}
  core.cloud.writeBytes = async () => {}
  core.cloud.readSyncState = async () => { checks++; return new Map() }
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    context.mock.timers.tick(8000)
    await settle()
    assert.equal(checks, 0)
    for (let interval = 0; interval < 2; interval++) { context.mock.timers.tick(60000); await settle() }
    assert.equal(checks, 0)
    context.mock.timers.tick(60000)
    await settle()
    await core.sync.close()
    assert.equal(checks, 1)
    await settle()
    await core.saveSettings({ autoCloudSync: false })
    context.mock.timers.tick(60000)
    await settle()
    assert.equal(checks, 1)
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})
