import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { request } from 'node:https'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { AppCore } from '../electron/core'
import { avatarAsset } from '../electron/avatar'
import { contentHash } from '../electron/books'
import { avatarPng } from './image-fixture.mjs'

const directory = await mkdtemp(path.join(tmpdir(), 'KS-local-profile-'))
const secrets = new Map<string, string>()
const core = new AppCore({ directory: path.join(directory, 'desktop'), nativeDirectory: path.resolve('native'), secrets: { get: key => secrets.get(key), set: (key, value) => { secrets.set(key, value) } }, openBrowser: async () => {} })
const id = randomUUID(), account = randomUUID(), settings = path.join(directory, 'kindle'), mount = path.join(directory, 'mount')
const photo = avatarPng(), photoImage = 'data:image/png;base64,' + photo.toString('base64')
const rclone = process.env.KINDLESPOUSE_TEST_RCLONE || path.resolve('native/tools/rclone.exe')
const run = async () => JSON.parse((await promisify(execFile)(path.resolve('.test-data/companion-test.exe'), ['--config', path.join(settings, 'config.json'), '--profile-only'], { windowsHide: true, timeout: 120000 })).stdout)
try {
  core.store.put('clouds', account, { id: account, name: 'Reading library', provider: 'drive', connected: true })
  core.store.put('clouds', 'backup', { id: 'backup', name: 'Notebook backup', provider: 'onedrive', connected: false })
  core.store.put('sync-devices', id, { id, name: 'Test Kindle', accountId: account, pairedAt: new Date().toISOString(), status: 'connected' })
  const end = Date.now() - 60000
  core.history.record({ id: 'profile-reading', deviceId: id, source: 'koreader', bookTitle: 'Private reading title',
    startedAt: new Date(end - 2820000).toISOString(), endedAt: new Date(end).toISOString(), seconds: 2820 })
  await core.saveSettings({ displayName: 'Test Reader', avatarImage: photoImage })
  await core.localProfiles.start('127.0.0.1', 0)
  const config = JSON.parse(core.localProfiles.config(id).toString())
  const packagePath = path.join(directory, 'KindleSpouse-Private-Local-Profile.zip')
  await core.exportLocalProfilePairing(id, packagePath)
  const packageBytes = await readFile(packagePath), zip = await JSZip.loadAsync(packageBytes)
  assert.equal((await readFile(packagePath + '.sha256', 'utf8')).trim(), contentHash(packageBytes))
  assert.deepEqual(JSON.parse(await zip.file('kindlespouse/lan.json')!.async('string')), config)
  assert.deepEqual(await zip.file('kindlespouse/kindlespouse-sync-next')!.async('nodebuffer'), await readFile('native/tools/companion/kindlespouse-sync'))
  assert.ok(!Object.keys(zip.files).some(name => /rclone\.conf|config\.json|avatar|certificate\.pem|private-key/.test(name)))
  if (process.platform === 'win32') {
    const validated = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-File', path.resolve('scripts/install-local-profile.ps1'), '-Package', packagePath, '-ValidateOnly'], { windowsHide: true, timeout: 30000 })
    assert.equal(JSON.parse(validated.stdout).valid, true)
  }
  const cert = await readFile(path.join(directory, 'desktop/local-profile-identity/certificate.pem'))
  const http = (method: string, token: string, body?: unknown) => new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    const packet = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = request(config.urls[0] + '/v1/profiles/' + id + (method === 'POST' ? '/receipt' : ''), { method, ca: cert, servername: 'kindlespouse.local', headers: { Authorization: 'Bearer ' + token, ...(packet ? { 'Content-Length': packet.length } : {}) } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, bytes: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(packet)
  })
  assert.equal((await http('GET', 'invalid')).status, 401)
  const packet = JSON.parse((await http('GET', config.token)).bytes.toString())
  assert.equal(packet.profile.avatarHash, contentHash(photo))
  assert.equal(packet.profile.clouds.length, 2)
  assert.equal(packet.profile.clouds.find((item: any) => item.id === account).connected, true)
  assert.equal(packet.profile.clouds.find((item: any) => item.id === 'backup').connected, false)
  assert.equal(packet.profile.reading.totalSeconds, 2820)
  assert.equal(packet.profile.reading.bookCount, 1)
  assert.equal(packet.profile.reading.readingDays, core.history.stats().days.length)
  assert.ok(!JSON.stringify(packet.profile.reading).includes('Private reading title'))
  assert.deepEqual(Buffer.from(packet.avatar, 'base64'), photo)
  const receipt = { version: 1, profileVersion: 2, deviceId: id, revision: packet.profile.revision, avatarHash: packet.profile.avatarHash, receivedAt: new Date().toISOString() }
  assert.equal((await http('POST', config.token, { ...receipt, revision: '0'.repeat(64) })).status, 409)
  for (const folder of [settings, mount]) await mkdir(folder, { recursive: true })
  await writeFile(path.join(settings, 'config.json'), JSON.stringify({ version: 1, deviceId: id, remoteRoot: 'KindleSpouse/Sync', mount, rclone: path.join(directory, 'cloud-must-not-run.exe') }))
  await writeFile(path.join(settings, 'lan.json'), JSON.stringify(config))
  await writeFile(path.join(settings, 'pause.requested'), 'notes remain paused')
  const started = Date.now(), result = await run(), milliseconds = Date.now() - started
  assert.equal(result.profileRoute, 'lan')
  assert.equal(result.profileOnly, true)
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')).clouds, packet.profile.clouds)
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')).reading, packet.profile.reading)
  assert.deepEqual(await readFile(path.join(settings, 'avatars', packet.profile.avatarHash + '.png')), photo)
  assert.equal(core.snapshot().sync.devices[0].profileRoute, 'lan')
  assert.equal(core.snapshot().sync.devices[0].profileAvatarHash, avatarAsset(photoImage)?.hash)
  assert.equal(core.snapshot().sync.working, false)
  assert.equal(await readFile(path.join(settings, 'pause.requested'), 'utf8'), 'notes remain paused')
  core.sync.applyProfileReceipt({ ...receipt, revision: 'a'.repeat(64), avatarHash: undefined }, 'cloud')
  assert.equal(core.snapshot().sync.devices[0].profileRevision, packet.profile.revision)
  core.history.record({ id: 'updated-reading', deviceId: id, source: 'koreader', bookTitle: 'Private reading title',
    startedAt: new Date(end).toISOString(), endedAt: new Date(end + 60000).toISOString(), seconds: 60 })
  assert.equal((await http('POST', config.token, receipt)).status, 409)
  const updated = JSON.parse((await http('GET', config.token)).bytes.toString())
  assert.notEqual(updated.profile.revision, packet.profile.revision)
  assert.equal(updated.profile.reading.totalSeconds, 2880)
  await run()
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')).reading, updated.profile.reading)
  const invalid = { ...config, token: 'b'.repeat(64) }
  await writeFile(path.join(settings, 'lan.json'), JSON.stringify(invalid))
  await assert.rejects(run())
  await writeFile(path.join(settings, 'lan.json'), JSON.stringify(config))
  await core.localProfiles.close()
  const remote = path.join(directory, 'cloud'), root = path.join(remote, 'KindleSpouse/Sync'), base = path.join(root, 'devices', id)
  await mkdir(base, { recursive: true })
  await mkdir(path.join(root, 'pairings'), { recursive: true })
  await mkdir(path.join(root, 'avatars'), { recursive: true })
  await writeFile(path.join(root, 'pairings', id + '.json'), JSON.stringify({ version: 1, deviceId: id, active: true }))
  const cloudProfile = { ...packet.profile, displayName: 'Cloud fallback', revision: contentHash(Buffer.from('cloud revision')) }
  await writeFile(path.join(base, 'device-settings.json'), JSON.stringify(cloudProfile))
  await writeFile(path.join(root, 'avatars', packet.profile.avatarHash + '.png'), photo)
  await writeFile(path.join(settings, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`)
  await writeFile(path.join(settings, 'config.json'), JSON.stringify({ version: 1, deviceId: id, remoteRoot: 'KindleSpouse/Sync', mount, rclone }))
  const fallback = await run()
  assert.equal(fallback.profileRoute, 'cloud')
  assert.equal(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')).revision, cloudProfile.revision)
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')).clouds, packet.profile.clouds)
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')).reading, packet.profile.reading)
  await assert.rejects(readFile(path.join(base, 'latest.json')))
  const after = core.store.get<any>('sync-devices', id)
  core.store.put('sync-devices', id, { ...after, status: 'revoked' })
  await core.localProfiles.start('127.0.0.1', Number(new URL(config.urls[0]).port))
  assert.equal((await http('GET', config.token)).status, 401)
  const report = { passed: true, realTLSAndCompanion: true, localMilliseconds: milliseconds, cloudNeverCalledForLocalProfile: true, cloudFallbackVerified: true, pausedNotesPreserved: true, staleReceiptRejected: true, revokedDeviceRejected: true }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/local-profile-acceptance.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
