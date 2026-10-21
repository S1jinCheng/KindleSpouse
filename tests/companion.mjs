import JSZip from 'jszip'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { getAcceptanceBook, getAcceptancePdf } from '../scripts/acceptance-book.mjs'

const execute = promisify(execFile),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const root = await mkdtemp(path.join(tmpdir(), 'KS-companion-'))
const remote = path.join(root, 'cloud'),
  mount = path.join(root, 'device'),
  settings = path.join(root, 'settings')
const deviceId = randomUUID(),
  jobId = randomUUID(),
  cloudRoot = 'KindleSpouse/Sync'
const binary = path.resolve('.test-data/companion-test.exe')
const guide = await readFile(await getAcceptanceBook()),
  pdf = await readFile(await getAcceptancePdf())
const config = path.join(settings, 'config.json')
const run = async (...args) =>
  JSON.parse((await execute(binary, ['--config', config, ...args], { windowsHide: true, timeout: 120000 })).stdout)
try {
  for (const folder of [
    settings,
    path.join(mount, 'documents'),
    path.join(mount, '.notebooks'),
    path.join(remote, cloudRoot, 'pairings'),
    path.join(remote, cloudRoot, 'outbox'),
    path.join(remote, cloudRoot, 'objects'),
    path.join(remote, 'KindleSpouse/Inbox'),
  ])
    await mkdir(folder, { recursive: true })
  await writeFile(
    path.join(settings, 'rclone.conf'),
    `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`,
  )
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      deviceId,
      name: 'Offline fixture Kindle',
      remoteRoot: cloudRoot,
      mount,
      rclone: path.resolve('native/tools/rclone.exe'),
    }),
  )
  await writeFile(
    path.join(remote, cloudRoot, 'pairings', `${deviceId}.json`),
    JSON.stringify({ version: 1, deviceId, active: true }),
  )
  const installationId = randomUUID(), revision = hash(Buffer.from('Generated component revision'))
  await writeFile(path.join(settings, 'component-manifest.json'), JSON.stringify({ version: 1, protocol: 1, installationId, revision }))
  await writeFile(path.join(remote, 'KindleSpouse/Inbox/guide.epub'), guide)
  await writeFile(
    path.join(remote, cloudRoot, 'outbox', `${jobId}.json`),
    JSON.stringify({
      version: 1,
      jobId,
      title: 'Guide',
      filename: 'Guide.epub',
      bytes: guide.length,
      sha256: hash(guide),
      remotePath: 'KindleSpouse/Inbox/guide.epub',
    }),
  )
  await writeFile(path.join(mount, '.notebooks/notes.pdf'), pdf)
  await writeFile(path.join(remote, cloudRoot, 'objects', hash(pdf)), pdf)
  await writeFile(
    path.join(mount, 'documents/My Clippings.txt'),
    'Guide\n- Your Highlight on Location 10 | Added on today\n\nA safe fixture quote\n==========',
  )
  await writeFile(path.join(settings, 'last-result.json'), JSON.stringify({ ok: true, marker: 'previous-completed-sync' }))
  const running = run()
  let live
  for (let attempt = 0; attempt < 400; attempt++) {
    live = await readFile(path.join(settings, 'progress.json'), 'utf8').then(JSON.parse).catch(() => undefined)
    if (live?.state === 'running') break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(live?.state, 'running')
  assert.equal(JSON.parse(await readFile(path.join(settings, 'last-result.json'), 'utf8')).marker, 'previous-completed-sync')
  await assert.rejects(run, /Command failed/)
  assert.equal(JSON.parse(await readFile(path.join(settings, 'last-result.json'), 'utf8')).marker, 'previous-completed-sync')
  const first = await running
  const progress = JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8'))
  assert.equal(progress.state, 'completed')
  assert.equal(progress.received, 1)
  assert.equal(progress.files, 2)
  assert.ok(progress.completedAt >= progress.startedAt)
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'last-result.json'), 'utf8')), first)
  assert.equal(first.ok, true)
  const installation = JSON.parse(await readFile(path.join(remote, cloudRoot, 'devices', deviceId, 'installation-receipt.json'), 'utf8'))
  assert.equal(installation.installationId, installationId)
  assert.equal(installation.revision, revision)
  assert.equal(installation.deviceId, deviceId)
  assert.equal(installation.protocol, 1)
  assert.equal(first.received, 1)
  const received = path.join(mount, 'Books/Inbox', `${hash(guide).slice(0, 12)}-Guide.epub`)
  assert.deepEqual(await readFile(received), guide)
  const base = path.join(remote, cloudRoot, 'devices', deviceId)
  const pointer = JSON.parse(await readFile(path.join(base, 'latest.json'), 'utf8'))
  const manifestBytes = await readFile(path.join(base, 'snapshots', `${pointer.manifest}.json`))
  assert.equal(hash(manifestBytes), pointer.manifest)
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.files.length, 2)
  assert.equal(
    manifest.files.some((file) => file.relative.startsWith('Books/Inbox/')),
    false,
  )
  assert.equal(manifest.version, 2)
  const unpacked = new Map()
  for (const bundle of manifest.bundles) {
    const bytes = await readFile(path.join(remote, cloudRoot, 'bundles', bundle.sha256 + '.zip'))
    assert.equal(hash(bytes), bundle.sha256)
    const zip = await JSZip.loadAsync(bytes)
    for (const object of bundle.objects) unpacked.set(object, await zip.file(object).async('nodebuffer'))
  }
  for (const file of manifest.files) {
    const content = unpacked.get(file.sha256) ?? await readFile(path.join(remote, cloudRoot, 'objects', file.sha256))
    assert.equal(hash(content), file.sha256)
    assert.equal(content.length, file.bytes)
  }
  const receipt = JSON.parse(await readFile(path.join(base, 'receipts.json'), 'utf8'))
  assert.deepEqual(receipt.books, [{ jobId, sha256: hash(guide) }])
  const count = (await readdir(path.join(remote, cloudRoot, 'bundles'))).length
  await writeFile(path.join(settings, 'pause.requested'), 'paused')
  await assert.rejects(run, /Command failed/)
  assert.equal(JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8')).state, 'paused')
  assert.deepEqual(JSON.parse(await readFile(path.join(settings, 'last-result.json'), 'utf8')), first)
  await rm(path.join(settings, 'pause.requested'))
  const second = await run()
  assert.equal(second.received, 0)
  assert.equal((await readdir(path.join(remote, cloudRoot, 'bundles'))).length, count)
  const beforeBooksOnly = await readFile(path.join(base, 'latest.json'))
  await writeFile(path.join(settings, 'pause.requested'), 'notes stay paused')
  const autoJob = randomUUID()
  await writeFile(path.join(remote, 'KindleSpouse/Inbox/Automatic.pdf'), pdf)
  await writeFile(path.join(remote, cloudRoot, 'outbox', autoJob + '.json'), JSON.stringify({ version: 1, jobId: autoJob, filename: 'Automatic.pdf', bytes: pdf.length, sha256: hash(pdf), remotePath: 'KindleSpouse/Inbox/Automatic.pdf' }))
  const booksOnly = await run('--books-only')
  assert.equal(booksOnly.ok, true)
  assert.equal(booksOnly.booksOnly, true)
  assert.equal(booksOnly.received, 1)
  assert.deepEqual(await readFile(path.join(mount, 'Books/Inbox', hash(pdf).slice(0, 12) + '-Automatic.pdf')), pdf)
  assert.deepEqual(await readFile(path.join(base, 'latest.json')), beforeBooksOnly)
  assert.deepEqual(await readFile(path.join(mount, '.notebooks/notes.pdf')), pdf)
  assert.equal(JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8')).booksOnly, true)
  assert.equal(await readFile(path.join(settings, 'pause.requested'), 'utf8'), 'notes stay paused')
  await rm(path.join(settings, 'pause.requested'))
  const rawBook = Buffer.from(guide)
  const rawArchive = await JSZip.loadAsync(rawBook)
  rawArchive.file('cloud-folder-marker.txt', 'A book placed directly in the dedicated cloud folder')
  const directBytes = await rawArchive.generateAsync({ type: 'nodebuffer' })
  await writeFile(path.join(remote, 'KindleSpouse/Inbox/Direct.epub'), directBytes)
  const directReceipt = await run('--books-only')
  assert.equal(directReceipt.received, 1)
  const directPath = path.join(mount, 'Books/Inbox', hash(directBytes).slice(0, 12) + '-Direct.epub')
  assert.deepEqual(await readFile(directPath), directBytes)
  assert.equal((await run('--books-only')).received, 0)
  await rm(directPath)
  assert.equal((await run('--books-only')).received, 1)
  assert.deepEqual(await readFile(directPath), directBytes)
  await rm(path.join(remote, 'KindleSpouse/Inbox/Direct.epub'))
  assert.equal((await run('--books-only')).received, 0)
  assert.deepEqual(await readFile(directPath), directBytes)
  const folderReceipt = JSON.parse(await readFile(path.join(base, 'folder-receipts.json'), 'utf8'))
  assert.equal(folderReceipt.folder, 'KindleSpouse/Inbox')
  assert.equal(folderReceipt.deviceId, deviceId)
  assert.equal(manifest.bundles.flatMap((bundle) => bundle.objects).includes(hash(pdf)), false)
  const beforeUpdatesOnly = await readFile(path.join(base, 'latest.json'))
  const annotationJob = randomUUID(), sidecar = received.replace(/\.epub$/, '.sdr')
  await mkdir(sidecar, { recursive: true })
  const originalSidecar = 'return {annotations={{text="Fixture quote",note="Original"}}}'
  await writeFile(path.join(sidecar, 'metadata.epub.lua'), originalSidecar)
  await mkdir(path.join(base, 'annotation-outbox'), { recursive: true })
  await writeFile(path.join(base, 'annotation-outbox', annotationJob + '.json'), JSON.stringify({ version: 1, jobId: annotationJob, deviceId, noteId: 'a'.repeat(64), bookHash: hash(guide), bookRelative: `Books/Inbox/${hash(guide).slice(0, 12)}-Guide.epub`, relative: `Books/Inbox/${hash(guide).slice(0, 12)}-Guide.sdr/metadata.epub.lua`, expected: { text: 'Fixture quote', note: 'Original', datetime: '', pos0: '', pos1: '' }, operation: 'edit', note: 'Edited on computer' }))
  const updatesOnly = await run('--updates-only')
  assert.equal(updatesOnly.ok, true)
  assert.equal(updatesOnly.updatesOnly, true)
  assert.deepEqual(await readFile(path.join(base, 'latest.json')), beforeUpdatesOnly)
  assert.equal(await readFile(path.join(sidecar, 'metadata.epub.lua'), 'utf8'), originalSidecar)
  assert.equal(JSON.parse(await readFile(path.join(settings, 'annotation-jobs', annotationJob + '.json'), 'utf8')).note, 'Edited on computer')
  assert.equal(JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8')).updatesOnly, true)
  await writeFile(path.join(settings, 'pause.requested'), 'paused')
  await assert.rejects(() => run('--updates-only'), /Command failed/)
  await rm(path.join(settings, 'pause.requested'))
  for (const name of await readdir(path.join(remote, cloudRoot, 'bundles'))) await rm(path.join(remote, cloudRoot, 'bundles', name))
  await rmdir(path.join(remote, cloudRoot, 'bundles'))
  const resumed = await run()
  assert.equal(resumed.ok, true)
  assert.equal((await readdir(path.join(remote, cloudRoot, 'bundles'))).length, count)
  await mkdir(path.join(settings, 'catalog'))
  const titleDb = new DatabaseSync(path.join(settings, 'catalog/ksdk.content.db'))
  titleDb.exec('CREATE TABLE Nodes(uuid TEXT,title_collation TEXT,node_type TEXT)')
  titleDb.prepare('INSERT INTO Nodes VALUES(?,?,?)').run(randomUUID(), 'Fixture notebook', 'STANDALONE_NOTEBOOK')
  titleDb.close()
  await writeFile(path.join(settings, 'pause.requested'), 'paused')
  const fullPointerBeforeTitles = await readFile(path.join(base, 'latest.json'), 'utf8')
  const titlesOnly = JSON.parse((await execute(binary, ['--config', config, '--titles-only'], { windowsHide: true, timeout: 120000 })).stdout)
  assert.equal(titlesOnly.ok, true)
  assert.equal(titlesOnly.titlesOnly, true)
  assert.equal(JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8')).titlesOnly, true)
  const titlePointer = JSON.parse(await readFile(path.join(base, 'catalog/latest.json'), 'utf8'))
  const titleManifest = JSON.parse(await readFile(path.join(base, 'catalog/snapshots', titlePointer.manifest + '.json'), 'utf8'))
  assert.deepEqual(titleManifest.files.map((file) => file.relative), ['ksdk.content.db'])
  assert.equal(await readFile(path.join(base, 'latest.json'), 'utf8'), fullPointerBeforeTitles)
  assert.equal(await readFile(path.join(settings, 'pause.requested'), 'utf8'), 'paused')
  await rm(path.join(settings, 'pause.requested'))
  const malicious = randomUUID()
  await writeFile(
    path.join(remote, cloudRoot, 'outbox', `${malicious}.json`),
    JSON.stringify({
      version: 1,
      jobId: malicious,
      filename: '../../escape.epub',
      bytes: guide.length,
      sha256: hash(guide),
      remotePath: 'KindleSpouse/Inbox/guide.epub',
    }),
  )
  await assert.rejects(run, /Command failed/)
  assert.equal(JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8')).state, 'failed')
  assert.match(JSON.parse(await readFile(path.join(settings, 'last-result.json'), 'utf8')).error, /invalid book filename/)
  assert.deepEqual(await readFile(received), guide)
  await writeFile(
    path.join(remote, cloudRoot, 'pairings', `${deviceId}.json`),
    JSON.stringify({ version: 1, deviceId, active: false }),
  )
  await assert.rejects(run, /Command failed/)
  assert.match(JSON.parse(await readFile(path.join(settings, 'progress.json'), 'utf8')).error, /revoked/)
  const report = {
    passed: true,
    standaloneProcess: true,
    realRclone: true,
    cloudBackend: 'isolated local alias for protocol acceptance; not live Google or OneDrive',
    verifiedFiles: manifest.files.length,
    repeatedSyncDeduplicated: true,
    receiptVerified: true,
    automaticBooksOnlyWithoutNotebookBackup: true,
    dedicatedFolderBooksWithoutDesktopJobs: true,
    missingBooksRestoredWithoutDeletingDeviceOriginals: true,
    lightweightAnnotationEditsWithoutSnapshotUpload: true,
    traversalRejected: true,
    revokedDeviceRejected: true,
    liveProgressVerified: true,
    previousResultPreservedDuringSync: true,
    duplicateLaunchPreservesRunningResult: true,
    failureProgressVerified: true,
    pausePreservesCompletedResult: true,
    resumeSkipsUploadedObjects: true,
    titleIndexSyncsWhileFullBackupPaused: true,
    legacyObjectsReusedByBundledSnapshots: true,
    missingBundleDirectoryRecoversFromSavedLedger: true,
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/v03-companion-acceptance.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await rm(root, { recursive: true, force: true })
}
