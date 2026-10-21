import assert from 'node:assert/strict'
import { avatarPng } from './image-fixture.mjs'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'KS-annotation-cloud-'))
const mount = path.join(root, 'device'), settings = path.join(root, 'settings'), remote = path.join(root, 'cloud')
const deviceId = randomUUID(), cloudRoot = 'KindleSpouse/Sync', base = path.join(remote, cloudRoot, 'devices', deviceId)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const run = () => promisify(execFile)(path.resolve('.test-data/companion-test.exe'), ['--config', path.join(settings, 'config.json')], { windowsHide: true, timeout: 120000 })
try {
  for (const directory of [settings, path.join(mount, 'Books/Test.sdr'), path.join(remote, cloudRoot, 'pairings'), path.join(remote, cloudRoot, 'outbox'), path.join(remote, cloudRoot, 'objects'), path.join(base, 'annotation-outbox')]) await mkdir(directory, { recursive: true })
  const original = Buffer.from('unchanged edition bytes'), sidecar = Buffer.from('return { annotations = {} }')
  await writeFile(path.join(mount, 'Books/Test.epub'), original)
  await writeFile(path.join(mount, 'Books/Test.sdr/metadata.epub.lua'), sidecar)
  await writeFile(path.join(settings, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`)
  await writeFile(path.join(settings, 'config.json'), JSON.stringify({ version: 1, deviceId, mount, remoteRoot: cloudRoot, rclone: path.resolve('native/tools/rclone.exe') }))
  await writeFile(path.join(remote, cloudRoot, 'pairings', `${deviceId}.json`), JSON.stringify({ version: 1, deviceId, active: true }))
  const job = { version: 1, jobId: randomUUID(), deviceId, noteId: hash('note'), bookHash: hash(original), bookRelative: 'Books/Test.epub', relative: 'Books/Test.sdr/metadata.epub.lua', expected: { text: 'Quote', note: 'Old', datetime: 'Today', pos0: '/p[1]', pos1: '/p[2]' }, operation: 'edit', note: 'New' }
  await writeFile(path.join(base, 'annotation-outbox', `${job.jobId}.json`), JSON.stringify(job))
  const avatar = avatarPng()
  await mkdir(path.join(remote, cloudRoot, 'avatars'), { recursive: true })
  await writeFile(path.join(remote, cloudRoot, 'avatars', hash(avatar) + '.png'), avatar)
  const profile = { version: 1, revision: hash('public preferences'), enabled: true, displayName: 'Test Reader', avatar: 'TR', avatarHash: hash(avatar) }
  await writeFile(path.join(base, 'device-settings.json'), JSON.stringify(profile))
  const blockedBook = path.join(remote, cloudRoot, 'outbox', randomUUID() + '.json')
  await writeFile(blockedBook, JSON.stringify({ invalid: true }))
  await assert.rejects(run())
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')), profile)
  assert.equal(JSON.parse(await readFile(path.join(base, 'profile-receipt.json'), 'utf8')).avatarHash, profile.avatarHash)
  await assert.rejects(readFile(path.join(base, 'latest.json')))
  await rm(blockedBook)
  await run()
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'sleep-profile.json'), 'utf8')), profile)
  assert.deepEqual(await readFile(path.join(settings, 'avatars', profile.avatarHash + '.png')), avatar)
  const profileReceipt = JSON.parse(await readFile(path.join(base, 'profile-receipt.json'), 'utf8'))
  assert.equal(profileReceipt.profileVersion, 2)
  assert.equal(profileReceipt.avatarHash, profile.avatarHash)
  assert.equal(profileReceipt.revision, profile.revision)
  const pending = JSON.parse(await readFile(path.join(settings, 'annotation-jobs', `${job.jobId}.json`), 'utf8'))
  assert.equal(pending.bookSize, original.length)
  assert.ok(pending.bookModified > 0)
  assert.deepEqual(await readFile(path.join(mount, job.relative)), sidecar)
  await writeFile(path.join(settings, 'annotation-results', `${job.jobId}.json`), JSON.stringify({ jobId: job.jobId, status: 'applied' }))
  const wrong = { ...job, jobId: randomUUID(), bookHash: hash('other edition') }
  await writeFile(path.join(base, 'annotation-outbox', `${wrong.jobId}.json`), JSON.stringify(wrong))
  await run()
  const receipts = JSON.parse(await readFile(path.join(base, 'annotation-receipts.json'), 'utf8'))
  assert.equal(receipts.deviceId, deviceId)
  assert.equal(receipts.results.find(item => item.jobId === job.jobId).status, 'applied')
  assert.equal(receipts.results.find(item => item.jobId === wrong.jobId).status, 'conflict')
  assert.deepEqual(await readFile(path.join(mount, 'Books/Test.epub')), original)
  console.log(JSON.stringify({ passed: true, realCompanionAndRclone: true, backend: 'isolated local alias', profileReceivedBeforeBooksAndBackups: true, editionValidated: true, queuedWithoutTouchingSidecar: true, receiptTransportVerified: true, actualLuaMutationTest: 'tests/annotation-apply.lua' }))
} finally { await rm(root, { recursive: true, force: true }) }
