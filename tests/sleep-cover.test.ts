import test from 'node:test'
import assert from 'node:assert/strict'
import { profileReading, readingStreak, sleepProfile } from '../src/sleep-cover'
import type { CloudAccount, Settings } from '../src/shared'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { avatarAsset, avatarBytes } from '../electron/avatar'
import { SleepPreviewCache } from '../electron/sleep-preview'
import { contentHash } from '../electron/books'
import { AppCore } from '../electron/core'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=', 'base64')
const photo = 'data:image/png;base64,' + png.toString('base64')

test('profile reading keeps lifetime metrics and bounds the calendar without book titles', () => {
  const stats = { totalSeconds: 7200.5, todaySeconds: 900.5, books: [{ title: 'Private title', seconds: 7200.5 }], days: [
    { date: '2024-01-01', seconds: 6000, books: ['Private title'] },
    { date: '2026-10-19', seconds: 900.5, books: ['Private title'] },
    { date: '2026-10-18', seconds: 300, books: ['Private title'] },
  ] }
  const reading = profileReading(stats, Date.parse('2026-10-18T16:01:00Z'))
  assert.deepEqual(reading, { asOf: '2026-10-19', totalSeconds: 7200.5, todaySeconds: 900.5, readingDays: 3, bookCount: 1,
    days: [{ date: '2026-10-18', seconds: 300 }, { date: '2026-10-19', seconds: 900.5 }] })
  assert.ok(!JSON.stringify(reading).includes('Private'))
  const empty = profileReading({ totalSeconds: 0, todaySeconds: 0, books: [], days: [] })
  assert.equal(empty.readingDays, 0)
  assert.deepEqual(empty.days, [])
})

test('reading streak uses device days, tolerates an unread today, and ends at gaps', () => {
  const day = (date: string, seconds = 60) => ({ date, seconds, books: [] })
  const now = Date.parse('2026-10-19T00:01:00+08:00')
  assert.equal(readingStreak([day('2026-10-17'), day('2026-10-18')], now), 2)
  assert.equal(readingStreak([day('2026-10-19'), day('2026-10-18'), day('2026-10-16')], now), 2)
  assert.equal(readingStreak([day('2026-10-19', 0), day('2026-10-17')], now), 0)
  assert.equal(readingStreak([], now), 0)
})

test('sleep profile carries only explicit public-facing preferences', () => {
  const settings = { sleepCoverEnabled: false, displayName: ' Sijin ', avatar: 'SJ', sourceUrl: 'private', calibreDirectory: 'private' } as Settings
  assert.deepEqual(sleepProfile(settings), { version: 1, enabled: false, displayName: 'Sijin', avatar: 'SJ' })
})

test('avatar assets reject disguised formats, oversized bytes and unbounded image dimensions', () => {
  assert.deepEqual(avatarBytes(photo), png)
  assert.equal(avatarAsset(photo)?.hash, contentHash(png))
  assert.equal(avatarAsset(''), undefined)
  for (const value of ['data:image/svg+xml;base64,' + png.toString('base64'), 'data:image/png;base64,' + Buffer.from('<svg/>').toString('base64'), 'data:image/png;base64,' + Buffer.alloc(600000).toString('base64')]) assert.throws(() => avatarBytes(value))
  const huge = Buffer.from(png)
  huge.writeUInt32BE(100000, 16)
  assert.throws(() => avatarBytes('data:image/png;base64,' + huge.toString('base64')))
})

test('photo preferences publish independently, reuse assets, retry failures and import device receipt without losing fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-profile-'))
  const core = new AppCore({ directory, nativeDirectory: 'unused', secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
  const account = randomUUID(), deviceId = randomUUID(), remote = new Map<string, Buffer>(), writes: string[] = []
  let metadataReads = 0, fail = false
  core.store.put('clouds', account, { id: account, name: 'Test Drive', provider: 'drive', connectedAt: new Date().toISOString() })
  core.store.put('sync-devices', deviceId, { id: deviceId, name: 'Test Kindle', accountId: account, status: 'connected', pairedAt: new Date().toISOString() })
  core.cloud.writeBytes = async (_account, filename, bytes) => { if (fail) throw new Error('offline'); writes.push(filename); remote.set(filename, Buffer.from(bytes)) }
  core.cloud.readBytes = async (_account, filename) => Buffer.from(remote.get(filename)!)
  core.cloud.readSyncState = async () => {
    metadataReads++
    const profile = JSON.parse(remote.get(`${core.sync.root()}/devices/${deviceId}/device-settings.json`)!.toString())
    return new Map([
      ['profile-receipt.json', Buffer.from(JSON.stringify({ version: 1, profileVersion: 2, deviceId, revision: profile.revision, avatarHash: profile.avatarHash, receivedAt: new Date().toISOString() }))],
      ['receipts.json', Buffer.from(JSON.stringify({ version: 1, bookFormatsVersion: 2, deviceId, receivedAt: new Date().toISOString(), books: [] }))],
    ])
  }
  try {
    await core.saveSettings({ kindleMode: 'koreader', defaultCloudId: account, displayName: 'Test Reader', avatarImage: photo, bio: 'Private biography', location: 'Private city' })
    assert.equal(core.snapshot().sync.preferences?.state, 'pending')
    await Promise.all([core.publishPreferences(), core.publishPreferences()])
    assert.equal(writes.length, 2)
    assert.equal(metadataReads, 0)
    const settingsPath = `${core.sync.root()}/devices/${deviceId}/device-settings.json`
    const profile = JSON.parse(remote.get(settingsPath)!.toString())
    assert.equal(profile.avatarHash, contentHash(png))
    assert.equal(profile.bio, undefined)
    assert.equal(profile.location, undefined)
    assert.equal(profile.avatarImage, undefined)
    assert.deepEqual(remote.get(`${core.sync.root()}/avatars/${profile.avatarHash}.png`), png)
    assert.equal(core.snapshot().sync.preferences?.state, 'uploaded')
    await core.saveSettings({ displayName: 'Renamed Reader' })
    fail = true
    await assert.rejects(core.publishPreferences(), /offline/)
    assert.equal(core.snapshot().settings.displayName, 'Renamed Reader')
    assert.equal(core.snapshot().sync.preferences?.state, 'error')
    fail = false
    await core.publishPreferences()
    assert.equal(writes.length, 3)
    await core.sync.sync(account)
    const device = core.snapshot().sync.devices[0]
    assert.equal(device.profileVersion, 2)
    assert.equal(device.bookFormatsVersion, 2)
    assert.equal(device.profileRevision, core.snapshot().sync.preferences?.revision)
    assert.equal(device.profileAvatarHash, contentHash(png))
    await core.saveSettings({ avatarImage: '' })
    await core.publishPreferences()
    assert.equal(JSON.parse(remote.get(settingsPath)!.toString()).avatarHash, undefined)
    assert.equal(writes.length, 4)
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a slow cloud backup cannot replace the revision already received over LAN', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-profile-race-'))
  const core = new AppCore({ directory, nativeDirectory: 'unused', secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
  const account = randomUUID(), deviceId = randomUUID(), remote = new Map<string, Buffer>()
  let release!: () => void, started!: () => void, first = true
  const blocked = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  core.store.put('clouds', account, { id: account, name: 'Test Drive', provider: 'drive', connectedAt: new Date().toISOString() })
  core.store.put('sync-devices', deviceId, { id: deviceId, name: 'Test Kindle', accountId: account, status: 'connected', pairedAt: new Date().toISOString() })
  core.cloud.writeBytes = async (_account, filename, bytes) => { if (first) { first = false; started(); await gate }; remote.set(filename, Buffer.from(bytes)) }
  core.cloud.readBytes = async (_account, filename) => Buffer.from(remote.get(filename)!)
  try {
    await core.saveSettings({ kindleMode: 'koreader', displayName: 'Before edit', defaultCloudId: account })
    const older = core.publishPreferences()
    await blocked
    const oldRevision = core.snapshot().sync.preferences!.revision!
    await core.saveSettings({ displayName: 'New LAN profile' })
    const revision = core.snapshot().sync.preferences!.revision!
    core.sync.applyProfileReceipt({ version: 1, profileVersion: 2, deviceId, revision, receivedAt: new Date().toISOString() }, 'lan')
    release()
    await older
    assert.notEqual(revision, oldRevision)
    assert.equal(core.snapshot().sync.preferences!.revision, revision)
    assert.equal(core.snapshot().sync.devices[0].profileRevision, revision)
    assert.equal(core.snapshot().sync.devices[0].profileRoute, 'lan')
    core.sync.applyProfileReceipt({ version: 1, profileVersion: 2, deviceId, revision: oldRevision, receivedAt: new Date().toISOString() }, 'cloud')
    assert.equal(core.snapshot().sync.devices[0].profileRevision, revision)
    await core.publishPreferences()
    assert.equal(core.snapshot().sync.preferences!.revision, revision)
    assert.equal(core.snapshot().sync.preferences!.state, 'uploaded')
  } finally { release(); await core.close(); await rm(directory, { recursive: true, force: true }) }
})

test('sleep previews deduplicate concurrent rendering, persist across restarts, serialize work and replace damaged cache', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-cover-cache-'))
  const cache = new SleepPreviewCache(directory)
  let renders = 0, active = 0
  const render = async () => {
    assert.equal(active++, 0)
    renders++
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return png
  }
  try {
    const key = contentHash(Buffer.from('book, profile and local statistics'))
    await Promise.all([cache.get(key, render), cache.get(key, render)])
    assert.equal(renders, 1)
    assert.deepEqual(await new SleepPreviewCache(directory).get(key, render), png)
    assert.equal(renders, 1)
    await writeFile(path.join(directory, key + '.png'), 'incomplete')
    await Promise.all([cache.get(key, render), cache.get(contentHash(Buffer.from('changed profile')), render)])
    assert.equal(renders, 3)
    assert.deepEqual(await readFile(path.join(directory, key + '.png')), png)
  } finally { await cache.close(); await rm(directory, { recursive: true, force: true }) }
})


test('reader profile publishes only stable cloud display metadata and clears removed bindings', () => {
  const settings = { displayName: 'Reader' } as Settings
  const accounts = [
    { id: 'b', name: 'Backup', provider: 'onedrive', connected: true, error: 'Reconnect', extra: 'private' },
    { id: 'a', name: 'Reading', provider: 'drive', connected: true, checkedAt: '2026-01-01' },
  ] as CloudAccount[]
  const profile = sleepProfile(settings, undefined, accounts)
  assert.deepEqual(profile.clouds, [
    { id: 'a', name: 'Reading', provider: 'drive', connected: true },
    { id: 'b', name: 'Backup', provider: 'onedrive', connected: false },
  ])
  assert.equal(JSON.stringify(profile).includes('private'), false)
  assert.deepEqual(sleepProfile(settings, undefined, []).clouds, [])
  assert.notDeepEqual(profile, sleepProfile(settings, undefined, [accounts[0]]))
})
