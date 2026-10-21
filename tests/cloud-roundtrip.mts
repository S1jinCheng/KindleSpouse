import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { CloudBridge } from '../electron/cloud.ts'
import { CloudSync } from '../electron/sync.ts'
import { Store } from '../electron/store.ts'
import { NotebookLibrary } from '../electron/notes.ts'
import { ReadingHistory } from '../electron/history.ts'
import { runProcess } from '../electron/process.ts'
import { getAcceptancePdf } from '../scripts/acceptance-book.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'KS-cloud-roundtrip-'))
const binary = path.resolve('.test-data/companion-test.exe'), rclone = path.resolve('native/tools/rclone.exe')
const mount = path.join(root, 'kindle'), remote = path.join(root, 'cloud'), settings = path.join(root, 'settings'), desktop = path.join(root, 'desktop')
const deviceId = randomUUID(), base = 'KindleSpouse/Sync', remoteBase = path.join(remote, base), fixtureCount = 500
const store = new Store(desktop), notes = new NotebookLibrary(store, desktop, root, () => {}), history = new ReadingHistory(store)
const commands: string[][] = []
const cloud = new CloudBridge(rclone, desktop, { get: () => JSON.stringify({ provider: 'drive', token: {} }), set: () => {} }, async () => {}, async (executable, args, options) => {
  const config = args[args.indexOf('--config') + 1]
  await writeFile(config, `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`)
  commands.push(args)
  return runProcess(executable, args, options)
})
const sync = new CloudSync(store, cloud, notes, history, desktop, root, () => ({ sourceUrl: '', calibreDirectory: '', cloudFolder: 'KindleSpouse/Inbox', profile: { font: 'song', fontSize: 19, lineHeight: 1.8, margin: 20, paper: 'warm' } }), () => {})
const run = async (executable = binary, target = settings) => JSON.parse(await runProcess(executable, ['--config', path.join(target, 'config.json')], { timeout: 10 * 60 * 1000 }))
const manifest = async () => {
  const pointer = JSON.parse(await readFile(path.join(remoteBase, 'devices', deviceId, 'latest.json'), 'utf8'))
  return JSON.parse(await readFile(path.join(remoteBase, 'devices', deviceId, 'snapshots', pointer.manifest + '.json'), 'utf8'))
}
try {
  for (const folder of [path.join(mount, '.notebooks'), path.join(mount, 'documents'), settings, path.join(remoteBase, 'pairings'), path.join(remoteBase, 'outbox'), path.join(remoteBase, 'objects')]) await mkdir(folder, { recursive: true })
  await writeFile(path.join(settings, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${remote.replaceAll('\\', '/')}\n`)
  await writeFile(path.join(settings, 'config.json'), JSON.stringify({ version: 1, deviceId, name: 'Fixture Kindle', remoteRoot: base, mount, rclone }))
  await writeFile(path.join(remoteBase, 'pairings', deviceId + '.json'), JSON.stringify({ version: 1, deviceId, active: true }))
  const seed = randomBytes(32768)
  for (let index = 0; index < fixtureCount; index++) {
    const value = Buffer.from(seed)
    value.writeUInt32LE(index, 0)
    await writeFile(path.join(mount, '.notebooks', `fixture-${index}.bin`), value)
  }
  await writeFile(path.join(mount, '.notebooks', 'notebook.pdf'), await readFile(await getAcceptancePdf()))
  const clipping = 'Fixture book\n- Your Highlight on Location 10 | Added on today\n\nA wireless annotation\n=========='
  await writeFile(path.join(mount, 'documents', 'My Clippings.txt'), clipping)
  const baselinePath = process.argv[2]
  let baselineMs: number | undefined
  if (baselinePath) {
    const baselineSettings = path.join(root, 'baseline'), baselineRemote = path.join(root, 'baseline-remote')
    for (const folder of [baselineSettings, path.join(baselineRemote, base, 'pairings'), path.join(baselineRemote, base, 'outbox'), path.join(baselineRemote, base, 'objects')]) await mkdir(folder, { recursive: true })
    await writeFile(path.join(baselineSettings, 'config.json'), await readFile(path.join(settings, 'config.json')))
    await writeFile(path.join(baselineSettings, 'rclone.conf'), `[remote]\ntype = alias\nremote = ${baselineRemote.replaceAll('\\', '/')}\n`)
    await writeFile(path.join(baselineRemote, base, 'pairings', deviceId + '.json'), JSON.stringify({ version: 1, deviceId, active: true }))
    const start = performance.now()
    await run(path.resolve(baselinePath), baselineSettings)
    baselineMs = Math.round(performance.now() - start)
    console.log(JSON.stringify({ event: 'baseline-complete', files: fixtureCount + 2, milliseconds: baselineMs }))
  }
  const start = performance.now()
  await run()
  const bundledMs = Math.round(performance.now() - start), first = await manifest()
  assert.equal(first.version, 2)
  assert.equal(first.files.length, fixtureCount + 2)
  assert.equal(first.bundles.length, 1)
  store.put('sync-devices', deviceId, { id: deviceId, name: 'Fixture Kindle', accountId: 'fixture', pairedAt: new Date().toISOString(), status: 'awaiting_pairing' })
  const metadata = await cloud.readSyncState('fixture', `${base}/devices/${deviceId}`)
  assert.ok(metadata.has('latest.json'))
  assert.ok(metadata.has('receipts.json'))
  assert.ok(metadata.has('status.json'))
  await sync.sync('fixture')
  assert.equal(sync.snapshot().devices[0].status, 'connected')
  assert.equal(notes.notebooks().filter((book) => book.classification === 'notebook').length, 1)
  assert.equal(notes.notes().length, 1)
  const downloads = () => commands.filter((args) => args.includes('--files-from-raw'))
  assert.equal(downloads().length, 1)
  await sync.sync('fixture')
  assert.equal(downloads().length, 1)
  await mkdir(path.join(settings, 'catalog'))
  const database = new DatabaseSync(path.join(settings, 'catalog', 'ksdk.content.db'))
  database.exec('CREATE TABLE Nodes(uuid TEXT,title_collation TEXT,node_type TEXT)')
  database.prepare('INSERT INTO Nodes VALUES(?,?,?)').run(randomUUID(), 'Wireless title fixture', 'STANDALONE_NOTEBOOK')
  database.close()
  await writeFile(path.join(mount, 'documents', 'My Clippings.txt'), clipping + '\n' + clipping.replace('10', '20').replace('A wireless annotation', 'A changed annotation'))
  await run()
  const next = await manifest()
  assert.equal(next.files.length, fixtureCount + 3)
  assert.equal(next.bundles.filter((bundle: { sha256: string }) => !first.bundles.some((old: { sha256: string }) => old.sha256 === bundle.sha256)).length, 2)
  const before = commands.length
  await sync.sync('fixture')
  assert.equal(commands.slice(before).filter((args) => args.includes('--files-from-raw')).length, 2)
  assert.equal(notes.notes().length, 2)
  const updatedMetadata = await cloud.readSyncState('fixture', `${base}/devices/${deviceId}`)
  assert.ok(updatedMetadata.has('catalog/latest.json'))
  await sync.syncTitles('fixture')
  const bundlesBefore = await readdir(path.join(remoteBase, 'bundles'))
  await run()
  assert.deepEqual(await readdir(path.join(remoteBase, 'bundles')), bundlesBefore)
  const report = { passed: true, cloudBackend: 'isolated rclone alias, no USB', files: fixtureCount + 2, initialDataUploads: first.bundles.length, baselineMs, bundledMs, localSpeedup: baselineMs ? Number((baselineMs / bundledMs).toFixed(1)) : undefined, incrementalAnnotationsVerified: true, nestedTitleMetadataVerified: true, repeatedDesktopSyncDoesNotDownloadObjects: true }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/cloud-sync-roundtrip.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await sync.close(); await cloud.close(); await notes.close(); store.close(); await rm(root, { recursive: true, force: true }) }
