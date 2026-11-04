import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = await mkdtemp(path.join(tmpdir(), 'KS-delivery-priority-'))
const remote = path.join(root, 'cloud'), mount = path.join(root, 'device'), settings = path.join(root, 'settings')
const device = randomUUID(), job = randomUUID(), base = 'KindleSpouse/Sync'
const bytes = Buffer.from('Generated document received before notebook backup')
const sha256 = createHash('sha256').update(bytes).digest('hex')
try {
  for (const directory of [settings, mount, path.join(remote, base, 'pairings'), path.join(remote, base, 'outbox'), path.join(remote, base, 'objects'), path.join(remote, 'KindleSpouse/Inbox')]) await mkdir(directory, { recursive: true })
  await writeFile(path.join(settings, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`)
  await writeFile(path.join(settings, 'config.json'), JSON.stringify({ version: 1, deviceId: device, name: 'Generated device', mount, remoteRoot: base, rclone: process.env.KINDLESPOUSE_TEST_RCLONE || path.resolve('native/tools/rclone.exe') }))
  await writeFile(path.join(settings, 'catalog.sh'), 'exit 1\n')
  await writeFile(path.join(remote, base, 'pairings', device+'.json'), JSON.stringify({ version: 1, deviceId: device, active: true }))
  await writeFile(path.join(remote, 'KindleSpouse/Inbox/generated.txt'), bytes)
  await writeFile(path.join(remote, base, 'outbox', job+'.json'), JSON.stringify({ version: 1, jobId: job, filename: 'generated.txt', bytes: bytes.length, sha256, remotePath: 'KindleSpouse/Inbox/generated.txt' }))
  await assert.rejects(run(path.resolve('.test-data/companion-test.exe'), ['--config', path.join(settings, 'config.json')], { windowsHide: true, timeout: 120000 }), error => typeof error.stdout === 'string' && /cannot refresh notebook titles/.test(error.stdout))
  const receipt = JSON.parse(await readFile(path.join(remote, base, 'devices', device, 'receipts.json'), 'utf8'))
  assert.ok(receipt.books.some(item => item.jobId === job && item.sha256 === sha256))
  assert.deepEqual(await readFile(path.join(mount, 'Books/Inbox', sha256.slice(0, 12)+'-generated.txt')), bytes)
  const progress = JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8'))
  assert.equal(progress.state, 'failed')
  assert.equal(progress.received, 1)
  console.log(JSON.stringify({ passed: true, realRclone: true, receivedAndAcknowledgedBeforeCatalogFailure: true, backupErrorRetainsDeliveryFeedback: true }))
} finally {
  assert.equal(path.dirname(root), tmpdir())
  await rm(root, { recursive: true, force: true })
}
