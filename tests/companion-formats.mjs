import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { getAcceptanceFormats } from '../scripts/acceptance-formats.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'KS-companion-formats-'))
const execute = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const remote = path.join(root, 'cloud'), mount = path.join(root, 'device'), directory = path.join(root, 'settings')
const remoteRoot = 'KindleSpouse/Sync', deviceId = randomUUID()
try {
  for (const folder of [directory, path.join(mount, 'documents'), path.join(mount, '.notebooks'), path.join(remote, remoteRoot, 'pairings'), path.join(remote, remoteRoot, 'outbox'), path.join(remote, remoteRoot, 'objects'), path.join(remote, 'KindleSpouse/Inbox')]) await mkdir(folder, { recursive: true })
  const config = path.join(directory, 'config.json')
  await writeFile(config, JSON.stringify({ version: 1, deviceId, name: 'Format acceptance device', remoteRoot, mount, rclone: path.resolve('native/tools/rclone.exe') }))
  await writeFile(path.join(directory, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`)
  await writeFile(path.join(remote, remoteRoot, 'pairings', deviceId + '.json'), JSON.stringify({ version: 1, deviceId, active: true }))
  await writeFile(path.join(mount, 'documents/My Clippings.txt'), 'Original reading notes')
  const generated = await getAcceptanceFormats(path.join(root, 'books'))
  const selected = generated.filter(filename => ['.mobi', '.fb2.zip', '.txt'].some(suffix => filename.endsWith(suffix)))
  assert.equal(selected.length, 3)
  const originals = []
  for (const filename of selected) {
    const bytes = await readFile(filename), jobId = randomUUID(), name = path.basename(filename)
    const remotePath = 'KindleSpouse/Inbox/' + name
    await writeFile(path.join(remote, remotePath), bytes)
    await writeFile(path.join(remote, remoteRoot, 'outbox', jobId + '.json'), JSON.stringify({ version: 1, jobId, filename: name, bytes: bytes.length, sha256: hash(bytes), remotePath }))
    originals.push({ name, bytes, jobId })
  }
  const run = async () => JSON.parse((await execute(path.resolve('.test-data/companion-test.exe'), ['--config', config], { windowsHide: true, timeout: 120000 })).stdout)
  assert.equal((await run()).received, 3)
  const receipts = JSON.parse(await readFile(path.join(directory, 'receipts.json'), 'utf8'))
  assert.equal(receipts.bookFormatsVersion, 2)
  assert.equal(receipts.books.length, 3)
  for (const original of originals) {
    assert.deepEqual(await readFile(path.join(mount, 'Books/Inbox', hash(original.bytes).slice(0, 12) + '-' + original.name)), original.bytes)
    assert.ok(receipts.books.some(book => book.jobId === original.jobId && book.sha256 === hash(original.bytes)))
  }
  assert.equal((await run()).received, 0)
  console.log(JSON.stringify({ passed: true, formats: ['mobi', 'fb2.zip', 'txt'], sameBytesReceived: true, capabilityReceipt: 2, repeatSyncDeduplicated: true, backend: 'isolated rclone cloud alias' }))
} catch (error) {
  console.error(await readFile(path.join(directory, 'progress.json'), 'utf8').catch(() => 'No progress'))
  throw error
} finally { await rm(root, { recursive: true, force: true }) }
