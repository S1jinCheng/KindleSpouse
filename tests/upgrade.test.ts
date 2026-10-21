import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../electron/store'
import { ReadingHistory } from '../electron/history'
import { NotebookLibrary, parseClippings, parseKoreaderState } from '../electron/notes'
import { CloudBridge } from '../electron/cloud'
import { CloudSync } from '../electron/sync'
import { AppCore } from '../electron/core'
import { contentHash } from '../electron/books'
import { quoteMatches } from '../src/anchors'
import { runProcess } from '../electron/process'
import JSZip from 'jszip'
import type { ReadingSession, StoredNotebook, SyncDevice } from '../src/shared'

const directory = () => mkdtemp(path.join(tmpdir(), 'KS-upgrade-'))
const secrets = { get: () => undefined, set: () => {} }
const memoryDownloads = (cloud: CloudBridge) => {
  cloud.downloadMany = async (account, folder, names, destination) => {
    await mkdir(destination, { recursive: true })
    for (const name of names) {
      const target = path.join(destination, name)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, await cloud.readBytes(account, `${folder}/${name}`))
    }
  }
}
const session = (fields: Partial<ReadingSession> = {}): ReadingSession => ({
  id: 'one',
  deviceId: 'fixture-device',
  source: 'koreader',
  bookTitle: 'A book',
  startedAt: '2026-09-30T15:59:30.000Z',
  endedAt: '2026-09-30T16:00:30.000Z',
  seconds: 60,
  ...fields,
})

test('a pending cloud grant survives the former callback deadline and only persists after authorization succeeds', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const saved = new Map<string, string>([['cloud:existing', 'original-account']])
  const opened: string[] = []
  let complete!: () => void
  let signal: AbortSignal | undefined
  const execute: typeof runProcess = async (executable, args, options) =>
    new Promise<string>((resolve, reject) => {
      signal = options?.signal
      const deadline = setTimeout(() => reject(new Error('expired')), options?.timeout)
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      options?.onOutput?.('http://127.0.0.1:53682/auth?state=fixture-')
      assert.deepEqual(opened, [])
      options?.onOutput?.('auth\n')
      complete = () => {
        clearTimeout(deadline)
        resolve('{"access_token":"fixture-access","refresh_token":"fixture-refresh"}')
      }
    })
  const cloud = new CloudBridge(
    'fixture',
    'unused',
    { get: (key) => saved.get(key), set: (key, value) => { saved.set(key, value) } },
    async (url) => { opened.push(url) },
    execute,
  )
  const pending = cloud.connect('drive')
  await assert.rejects(cloud.connect('onedrive'), /正在进行/)
  context.mock.timers.tick(6 * 60 * 1000 + 1)
  await Promise.resolve()
  assert.equal(signal?.aborted, false)
  assert.equal(saved.size, 1)
  assert.deepEqual(opened, ['http://127.0.0.1:53682/auth?state=fixture-auth'])
  complete()
  const account = await pending
  assert.equal(account.connected, true)
  assert.equal(saved.get('cloud:existing'), 'original-account')
  assert.equal(JSON.parse(saved.get(`cloud:${account.id}`)!).token.refresh_token, 'fixture-refresh')
  await cloud.close()
})

test('closing a cloud bridge cancels an unfinished browser grant and preserves the connected account', async () => {
  const saved = new Map<string, string>([['cloud:existing', 'original-account']])
  let signal: AbortSignal | undefined
  const execute: typeof runProcess = async (executable, args, options) =>
    new Promise<string>((resolve, reject) => {
      signal = options?.signal
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  const cloud = new CloudBridge(
    'fixture',
    'unused',
    { get: (key) => saved.get(key), set: (key, value) => { saved.set(key, value) } },
    async () => {},
    execute,
  )
  const rejected = assert.rejects(cloud.connect('drive'), /授权已取消/)
  await cloud.close()
  await rejected
  assert.equal(signal?.aborted, true)
  assert.deepEqual([...saved.entries()], [['cloud:existing', 'original-account']])
})

test('aborting an authorization subprocess stops its local callback listener', async () => {
  const controller = new AbortController()
  let announce!: (port: number) => void
  const ready = new Promise<number>((resolve) => { announce = resolve })
  const child = runProcess(process.execPath, ['-e', 'const http=require("node:http");const server=http.createServer((req,res)=>res.end("waiting"));server.listen(0,"127.0.0.1",()=>process.stdout.write(JSON.stringify({port:server.address().port})));'], {
    timeout: 10000,
    signal: controller.signal,
    onOutput: (chunk) => {
      const port = chunk.match(/"port":(\d+)/)?.[1]
      if (port) announce(Number(port))
    },
  })
  const rejected = assert.rejects(child, /abort/i)
  try {
    const port = await ready
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'waiting')
    controller.abort()
    await rejected
    let stopped = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) }) }
      catch { stopped = true; break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(stopped, true)
  } finally {
    controller.abort()
  }
})

test('pairing packages contain a separate device grant and remain pending until an actual device appears', async () => {
  const root = await directory(),
    store = new Store(root),
    notes = new NotebookLibrary(store, root, root, () => {}),
    history = new ReadingHistory(store)
  const cloud = new CloudBridge('unused', root, secrets, async () => {})
  const native = path.join(root, 'native'),
    bundle = path.join(native, 'tools', 'companion'),
    plugin = path.join(native, 'companion', 'plugin')
  const sync = new CloudSync(
    store,
    cloud,
    notes,
    history,
    root,
    native,
    () => ({
      sourceUrl: '',
      cloudFolder: 'KindleSpouse/Inbox',
      calibreDirectory: '',
      profile: { font: 'song', fontSize: 19, lineHeight: 1.8, margin: 20, paper: 'warm' },
    }),
    () => {},
  )
  try {
    await mkdir(bundle, { recursive: true })
    await mkdir(plugin, { recursive: true })
    for (const file of ['kindlespouse-sync', 'rclone', 'ca.pem', 'Go-LICENSE.txt', 'rclone-LICENSE.txt', 'CA-MPL-2.0.txt'])
      await writeFile(path.join(bundle, file), 'Fixture resource')
    await mkdir(path.join(native, 'tools/sleep-screen'), { recursive: true })
    await mkdir(path.join(native, 'tools/reader-fonts'), { recursive: true })
    await writeFile(path.join(native, 'reader-fonts.json'), JSON.stringify({ assets: [] }))
    for (const file of ['spouse_preset.lua', 'upstream-source.zip']) await writeFile(path.join(native, 'tools/sleep-screen', file), 'Fixture resource')
    await writeFile(path.join(plugin, 'main.lua'), 'return {}')
    await writeFile(path.join(native, 'companion', 'sync.sh'), await readFile('native/companion/sync.sh'))
    await writeFile(path.join(native, 'companion', 'catalog.sh'), await readFile('native/companion/catalog.sh'))
    const remote = new Map<string, Buffer>()
    cloud.list = async () => []
    cloud.writeBytes = async (id, filename, bytes) => {
      remote.set(filename, Buffer.from(bytes))
    }
    cloud.readBytes = async (id, filename) => Buffer.from(remote.get(filename)!)
    cloud.separateDeviceCredential = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { accountId: 'separate-device-account', config: '[remote]\ntype=drive\ntoken=fixture-device-grant\n' }
    }
    const filename = path.join(root, 'PrivatePairing.zip')
    const credential = cloud.separateDeviceCredential
    cloud.separateDeviceCredential = async () => { throw new Error('授权等待已结束，请重新开始。') }
    await assert.rejects(sync.pair('desktop-account', 'My Kindle', filename), /授权等待已结束/)
    assert.equal(sync.snapshot().pairing, false)
    assert.match(sync.snapshot().error ?? '', /授权等待已结束/)
    assert.equal(sync.snapshot().devices.length, 0)
    await assert.rejects(readFile(filename), { code: 'ENOENT' })
    cloud.separateDeviceCredential = credential
    const pairing = sync.pair('desktop-account', 'My Kindle', filename)
    await assert.rejects(sync.pair('desktop-account', 'Another', filename), /正在授权/)
    await pairing
    assert.equal(sync.snapshot().error, undefined)
    assert.equal(sync.snapshot().devices[0].status, 'awaiting_pairing')
    const zip = await JSZip.loadAsync(await readFile(filename))
    assert.match(await zip.file('kindlespouse/rclone.conf')!.async('string'), /fixture-device-grant/)
    assert.equal((await zip.file('kindlespouse/config.json')!.async('string')).includes(root), false)
    assert.equal(Boolean(zip.file('extensions/kindlespouse/config.xml')), true)
    const launcher = await zip.file('kindlespouse/sync.sh')!.async('string')
    assert.equal(launcher.includes('> /mnt/us/kindlespouse/last-result.json'), false)
    assert.match(launcher, /kindlespouse-sync-next/)
    assert.equal(Boolean(zip.file('kindlespouse/licenses/rclone-LICENSE.txt')), true)
    assert.equal(sync.snapshot().devices[0].lastSeen, undefined)
  } finally {
    await sync.close()
    await notes.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('reading sessions deduplicate repeated syncs, overlapping intervals and split at Shanghai midnight', async () => {
  const root = await directory(),
    store = new Store(root),
    history = new ReadingHistory(store)
  try {
    history.record(session())
    history.record(session())
    history.record(
      session({ id: 'overlap', startedAt: '2026-09-30T15:59:45.000Z', endedAt: '2026-09-30T16:00:45.000Z' }),
    )
    const stats = history.stats(Date.parse('2026-10-01T12:00:00Z'))
    assert.equal(stats.totalSeconds, 75)
    assert.equal(stats.todaySeconds, 45)
    assert.deepEqual(
      stats.days.map((day) => [day.date, day.seconds]),
      [
        ['2026-09-30', 30],
        ['2026-10-01', 45],
      ],
    )
    assert.equal(stats.books[0].seconds, 75)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('statistics reject fabricated future durations and long desktop idle intervals', async () => {
  const root = await directory(),
    store = new Store(root),
    history = new ReadingHistory(store)
  try {
    assert.throws(() => history.record(session({ seconds: 200 })), /时间范围/)
    assert.throws(
      () => history.record(session({ source: 'desktop', endedAt: '2026-09-30T16:01:30.000Z', seconds: 120 })),
      /活跃时间/,
    )
    assert.throws(
      () =>
        history.record(session({ startedAt: '2099-01-01T00:00:00Z', endedAt: '2099-01-01T00:00:30Z', seconds: 30 })),
      /时间范围/,
    )
    assert.equal(history.stats().totalSeconds, 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Kindle totals exclude archived desktop sessions without deleting either source', async () => {
  const root = await directory(), store = new Store(root), history = new ReadingHistory(store)
  try {
    history.record(session())
    history.record(session({ id: 'desktop-one', source: 'desktop', deviceId: 'desktop', bookTitle: 'Computer preview' }))
    history.record(session({ id: 'preview-one', source: 'koreader', deviceId: 'desktop-preview', bookTitle: 'Simulator' }))
    const stats = history.stats(Date.parse('2026-10-01T12:00:00Z'))
    assert.equal(stats.totalSeconds, 60)
    assert.equal(stats.todaySeconds, 30)
    assert.deepEqual(stats.books, [{ title: 'A book', seconds: 60 }])
    assert.ok(stats.days.every(day => day.books.length === 1 && day.books[0] === 'A book'))
    assert.equal(store.list('reading-sessions').length, 3)
    history.record(session({ id: 'desktop-two', source: 'desktop', deviceId: 'desktop', bookTitle: 'More computer preview', startedAt: '2026-09-30T16:10:00Z', endedAt: '2026-09-30T16:11:00Z' }))
    assert.equal(history.stats(Date.parse('2026-10-01T12:00:00Z')).totalSeconds, 60)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('quote anchors tolerate whitespace and full width characters but expose ambiguous repetitions', () => {
  const text = '前文。ＡＢＣ \n读书，\n有益。 后文。'
  const matches = quoteMatches(text, 'ABC读书，有益。')
  assert.equal(matches.length, 1)
  assert.equal(text.slice(matches[0].start, matches[0].end).replace(/\s/g, ''), 'ＡＢＣ读书，有益。')
  assert.equal(quoteMatches('甲引文乙，丙引文丁', '引文').length, 2)
  assert.equal(quoteMatches('甲引文乙，丙引文丁', '引文', '丙', '丁').length, 1)
  assert.equal(quoteMatches('wrong edition', 'missing quote').length, 0)
})

test('KOReader progress remains a source-specific position and is never treated as an EPUB CFI', () => {
  const state = parseKoreaderState(
    'return { doc_props = { title = "A book" }, percent_finished = 0.42, last_xpointer = "/body/DocFragment[2]/body/p[3]", summary = { status = "complete" } }',
    'fallback',
  )
  assert.equal(state.title, 'A book')
  assert.equal(state.progress, 0.42)
  assert.equal(state.finished, true)
  assert.equal(state.position?.startsWith('epubcfi('), false)
  assert.equal(parseKoreaderState('return {percent_finished = 999}', 'fallback').progress, undefined)
})

test('offline recovery rebuilds missing book indexes from verified snapshots without touching a device', async () => {
  const root = await directory()
  let deviceCalls = 0
  const core = new AppCore({
    directory: root,
    nativeDirectory: path.join(root, 'native'),
    secrets,
    openBrowser: async () => {},
    transport: {
      list: async () => {
        deviceCalls++
        return []
      },
      upload: async () => {
        throw new Error('unexpected write')
      },
    },
  })
  try {
    const snapshot = path.join(root, 'device-backups', 'snapshot-private')
    await mkdir(path.join(snapshot, 'documents', 'article.sdr'), { recursive: true })
    const bytes = Buffer.from('Original personal article')
    await writeFile(path.join(snapshot, 'documents', 'article.txt'), bytes)
    await writeFile(path.join(snapshot, 'documents', 'article.sdr', 'sidecar'), 'preserve')
    await writeFile(
      path.join(snapshot, 'snapshot-manifest.json'),
      JSON.stringify({
        createdAt: '2026-10-01T00:00:00Z',
        files: [
          { relative: 'documents/article.txt', sha256: contentHash(bytes), bytes: bytes.length },
          { relative: 'documents/article.sdr/sidecar', sha256: contentHash(Buffer.from('preserve')), bytes: 8 },
        ],
      }),
    )
    await core.recoverLibrary()
    await core.recoverLibrary()
    assert.equal(core.snapshot().candidates.length, 1)
    assert.equal(core.snapshot().candidates[0].fromDevice, true)
    assert.equal(core.snapshot().candidates[0].library, true)
    assert.equal(deviceCalls, 0)
    assert.equal(await readFile(path.join(snapshot, 'documents/article.sdr/sidecar'), 'utf8'), 'preserve')
    assert.equal(core.snapshot().jobs.length, 0)
  } finally {
    await core.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('refreshing notebook titles uses the selected cloud account without inspecting USB devices', async () => {
  const root = await directory()
  let deviceCalls = 0
  const core = new AppCore({ directory: root, nativeDirectory: root, secrets, openBrowser: async () => {}, transport: {
    list: async () => { deviceCalls++; return [{ id: 'connected-device', name: 'Connected Kindle' }] },
    upload: async () => { throw new Error('Unexpected device write') },
    exportTitles: async () => { throw new Error('USB must not be used for routine title refresh') },
  } })
  try {
    core.store.put('clouds', 'selected-cloud', { id: 'selected-cloud', provider: 'drive', name: 'Fixture drive', connected: true })
    await core.saveSettings({ defaultCloudId: 'selected-cloud' })
    const accounts: string[] = []
    core.sync.syncTitles = async (account) => { accounts.push(account) }
    await core.refreshNotebookTitles()
    assert.deepEqual(accounts, ['selected-cloud'])
    assert.equal(deviceCalls, 0)
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})

test('annotation matching refuses same-title editions until a user chooses the original', async () => {
  const root = await directory(),
    store = new Store(root)
  const notes = new NotebookLibrary(store, root, root, () => {})
  try {
    const note = parseClippings(
      'Same Book (Writer)\n- Your Highlight on Location 10 | Added on today\n\nA quotation\n==========',
    )[0]
    store.put('reading-notes', note.id, note)
    const first = { id: randomUUID(), title: 'Same Book', author: 'Writer', sha256: 'a'.repeat(64), format: 'epub' }
    const second = { ...first, id: randomUUID(), sha256: 'b'.repeat(64) }
    store.put('candidates', first.id, first)
    store.put('candidates', second.id, second)
    notes.linkBooks()
    assert.equal(notes.notes()[0].bookId, undefined)
    notes.link(note.id, second.id)
    assert.equal(notes.notes()[0].bookHash, second.sha256)
    assert.equal(notes.notes()[0].anchor?.quote, 'A quotation')
  } finally {
    await notes.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('device catalog titles resolve by identity and never replace manually chosen titles', async () => {
  const root = await directory(),
    store = new Store(root),
    notes = new NotebookLibrary(store, root, root, () => {})
  try {
    const catalog = new DatabaseSync(path.join(root, 'cc.db'))
    catalog.exec('CREATE TABLE Entries (p_uuid TEXT, p_titles_0_nominal TEXT)')
    catalog.prepare('INSERT INTO Entries VALUES (?,?)').run('notebook-one', 'Actual device title')
    catalog.close()
    const book: StoredNotebook = {
      id: randomUUID(),
      title: '未识别标题',
      identity: 'notebook-one',
      titleSource: 'unresolved',
      classification: 'notebook',
      sourceKey: 'fixture',
      path: 'not-read',
      sha256: 'a'.repeat(64),
      bytes: 1,
      importedAt: '2026-10-01',
      format: 'nbk',
      status: 'original',
    }
    store.put('notebooks', book.id, book)
    notes.matchTitles(root)
    assert.equal(notes.notebooks()[0].title, 'Actual device title')
    notes.rename(book.id, 'My custom title')
    notes.matchTitles(root)
    assert.equal(notes.notebooks()[0].title, 'My custom title')
  } finally {
    await notes.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cloud management protects sync directories and preserves the previous text version', async () => {
  const cloud = new CloudBridge('unused', 'unused', secrets, async () => {})
  for (const filename of ['', 'KindleSpouse', 'KindleSpouse/Sync', 'KindleSpouse/Sync/outbox'])
    await assert.rejects(cloud.mutate('account', { action: 'trash', path: filename }), /由应用管理/)
  const original = Buffer.from('original text')
  const written = new Map<string, Buffer>()
  cloud.readBytes = async () => original
  cloud.writeBytes = async (id, filename, bytes) => {
    written.set(filename, Buffer.from(bytes))
  }
  await assert.rejects(
    cloud.mutate('account', { action: 'write', path: 'Notes/a.md', text: 'new', expectedHash: 'a'.repeat(64) }),
    /已更新/,
  )
  assert.equal(written.size, 0)
  await cloud.mutate('account', {
    action: 'write',
    path: 'Notes/a.md',
    text: 'new',
    expectedHash: contentHash(original),
  })
  assert.deepEqual(written.get(`.KindleSpouse-Versions/${contentHash(original)}/a.md`), original)
  assert.equal(written.get('Notes/a.md')?.toString(), 'new')
})

test('Scribe notebook titles come from Nodes.title_collation with exact UUID matching and preserve manual names', async () => {
  const root = await directory(), store = new Store(root), notes = new NotebookLibrary(store, root, root, () => {})
  const identity = randomUUID(), other = randomUUID(), folder = randomUUID()
  const notebook = (id: string): StoredNotebook => ({ id, identity: id, title: '未识别标题', titleSource: 'unresolved', classification: 'notebook', format: 'nbk', status: 'original', path: 'not-read', sourceKey: id, sha256: 'a'.repeat(64), bytes: 1, importedAt: new Date().toISOString() })
  try {
    const legacy = new DatabaseSync(path.join(root, 'cc.db'))
    legacy.exec('CREATE TABLE Entries(p_uuid TEXT,p_titles_0_nominal TEXT)')
    legacy.prepare('INSERT INTO Entries VALUES(?,?)').run(identity, 'Old library title')
    legacy.close()
    const catalog = new DatabaseSync(path.join(root, 'ksdk.content.db'))
    catalog.exec('CREATE TABLE Nodes(uuid TEXT PRIMARY KEY,title_collation TEXT,node_type TEXT,additional_data TEXT)')
    catalog.prepare('INSERT INTO Nodes VALUES(?,?,?,?)').run(identity, '课程笔记 · 第一章', 'STANDALONE_NOTEBOOK', '{}')
    catalog.prepare('INSERT INTO Nodes VALUES(?,?,?,?)').run(folder, 'A folder', 'FOLDER', '{}')
    catalog.close()
    store.put('notebooks', identity, { ...notebook(identity), identity: `urn:uuid:${identity.toUpperCase()}` })
    store.put('notebooks', other, notebook(other))
    store.put('notebooks', folder, notebook(folder))
    notes.matchTitles(root)
    assert.equal(store.get<StoredNotebook>('notebooks', identity)?.title, '课程笔记 · 第一章')
    assert.equal(store.get<StoredNotebook>('notebooks', other)?.titleSource, 'unresolved')
    assert.equal(store.get<StoredNotebook>('notebooks', folder)?.titleSource, 'unresolved')
    assert.equal(notes.titleStatus().matched, 1)
    notes.rename(identity, '我保留的名字')
    notes.matchTitles(root)
    assert.equal(store.get<StoredNotebook>('notebooks', identity)?.title, '我保留的名字')
    await writeFile(path.join(root, 'ksdk.content.db'), 'invalid SQLite data')
    await rm(path.join(root, 'cc.db'))
    assert.match(notes.matchTitles(root).error ?? '', /读取失败/)
    assert.equal(store.get<StoredNotebook>('notebooks', identity)?.title, '我保留的名字')
  } finally { await notes.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('cloud title indexes import before a complete notebook snapshot and reject altered bytes or device identity', async () => {
  const root = await directory(), store = new Store(root), notes = new NotebookLibrary(store, root, root, () => {}), history = new ReadingHistory(store)
  const cloud = new CloudBridge('unused', root, secrets, async () => {})
  const sync = new CloudSync(store, cloud, notes, history, root, root, () => ({ sourceUrl: '', calibreDirectory: '', cloudFolder: 'KindleSpouse/Inbox', profile: { font: 'song', fontSize: 19, lineHeight: 1.8, margin: 20, paper: 'warm' } }), () => {})
  const device: SyncDevice = { id: randomUUID(), name: 'Fixture Kindle', accountId: 'account', pairedAt: new Date().toISOString(), status: 'awaiting_pairing' }
  const identity = randomUUID(), base = `KindleSpouse/Sync/devices/${device.id}`
  try {
    store.put('sync-devices', device.id, device)
    store.put('notebooks', identity, { id: identity, identity, title: '未识别标题', titleSource: 'unresolved', classification: 'notebook', format: 'nbk', status: 'original', sourceKey: identity, path: 'not-read', sha256: 'a'.repeat(64), bytes: 1, importedAt: new Date().toISOString() })
    const filename = path.join(root, 'source.db'), catalog = new DatabaseSync(filename)
    catalog.exec('CREATE TABLE Nodes(uuid TEXT,title_collation TEXT,node_type TEXT)')
    catalog.prepare('INSERT INTO Nodes VALUES(?,?,?)').run(identity, 'Wireless notebook title', 'STANDALONE_NOTEBOOK')
    catalog.close()
    const bytes = await readFile(filename), objectHash = contentHash(bytes)
    let manifest = Buffer.from(JSON.stringify({ version: 1, deviceId: device.id, createdAt: new Date().toISOString(), files: [{ relative: 'ksdk.content.db', bytes: bytes.length, sha256: objectHash }] }))
    const manifestHash = contentHash(manifest)
    cloud.list = async () => [{ name: 'catalog', path: `${base}/catalog`, isDir: true, size: 0 }]
    let altered = false
    cloud.readBytes = async (account, remote) => remote.endsWith('/latest.json') ? Buffer.from(JSON.stringify({ manifest: contentHash(manifest) })) : remote.includes('/snapshots/') ? manifest : altered ? Buffer.from('altered bytes') : bytes
    cloud.readSyncState = async () => new Map([['catalog/latest.json', Buffer.from(JSON.stringify({ manifest: contentHash(manifest) }))]])
    memoryDownloads(cloud)
    await sync.syncTitles('account')
    assert.equal(notes.notebooks()[0].title, 'Wireless notebook title')
    assert.equal(notes.titleStatus().matched, 1)
    assert.equal(sync.snapshot().devices[0].status, 'awaiting_pairing')
    await rm(path.join(root, 'notebook-catalogs', device.id, manifestHash, 'ksdk.content.db'))
    await rm(path.join(root, 'cloud-objects', objectHash))
    altered = true
    await assert.rejects(sync.syncTitles('account'), /校验失败/)
    assert.equal(notes.notebooks()[0].title, 'Wireless notebook title')
    manifest = Buffer.from(JSON.stringify({ version: 1, deviceId: randomUUID(), createdAt: new Date().toISOString(), files: [{ relative: 'ksdk.content.db', bytes: bytes.length, sha256: objectHash }] }))
    await assert.rejects(sync.syncTitles('account'), /不属于/)
  } finally { await sync.close(); await notes.close(); store.close(); await rm(root, { recursive: true, force: true }) }
})

test('cloud snapshots require a paired identity, verified bytes and matching receipts before device delivery is shown', async () => {
  const root = await directory(),
    store = new Store(root),
    notes = new NotebookLibrary(store, root, root, () => {}),
    history = new ReadingHistory(store)
  const cloud = new CloudBridge('unused', root, secrets, async () => {})
  const settings = () => ({
    sourceUrl: '',
    calibreDirectory: '',
    displayName: 'Fixture Reader',
    cloudFolder: 'KindleSpouse/Inbox',
    profile: { font: 'song' as const, fontSize: 19, lineHeight: 1.8, margin: 20, paper: 'warm' as const },
  })
  const sync = new CloudSync(store, cloud, notes, history, root, root, settings, () => {})
  try {
    const device: SyncDevice = {
      id: randomUUID(),
      name: 'Fixture Kindle',
      accountId: 'account',
      pairedAt: '2026-10-01',
      status: 'awaiting_pairing',
    }
    store.put('sync-devices', device.id, device)
    const file = Buffer.from('Downloaded original article'),
      fileHash = contentHash(file),
      jobId = randomUUID()
    store.put('jobs', jobId, {
      id: jobId,
      method: 'cloud',
      status: 'cloud_ready',
      cloudAccountId: 'account',
      sha256: fileHash,
    })
    const statisticsPath = path.join(root, 'source-statistics.sqlite3')
    const statistics = new DatabaseSync(statisticsPath)
    statistics.exec(
      "CREATE TABLE book(id INTEGER PRIMARY KEY,title TEXT); CREATE TABLE page_stat_data(id_book INTEGER,page INTEGER,start_time INTEGER,duration INTEGER); INSERT INTO book VALUES(1,'Fixture book'); INSERT INTO page_stat_data VALUES(1,1,1790812800,60); CREATE VIEW page_stat AS SELECT id_book,page,start_time,duration/2 AS duration FROM page_stat_data;",
    )
    statistics.close()
    const statisticsBytes = await readFile(statisticsPath),
      statisticsHash = contentHash(statisticsBytes)
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        deviceId: device.id,
        createdAt: '2026-10-01T00:00:00Z',
        files: [
          { relative: 'documents/a.txt', bytes: file.length, sha256: fileHash },
          { relative: 'statistics.sqlite3', bytes: statisticsBytes.length, sha256: statisticsHash },
        ],
      }),
    )
    const manifestHash = contentHash(manifest)
    const objects = new Map<string, Buffer>([
      [`KindleSpouse/Sync/objects/${fileHash}`, file],
      [`KindleSpouse/Sync/objects/${statisticsHash}`, statisticsBytes],
      [`KindleSpouse/Sync/devices/${device.id}/snapshots/${manifestHash}.json`, manifest],
    ])
    const profiles: { revision: string; reading: { totalSeconds: number; readingDays: number } }[] = []
    cloud.writeBytes = async (_account, filename, bytes) => {
      objects.set(filename, Buffer.from(bytes))
      if (filename.endsWith('/device-settings.json')) profiles.push(JSON.parse(Buffer.from(bytes).toString()))
    }
    cloud.list = async () => [
      { name: 'latest.json', path: '', size: 1, isDir: false },
      { name: 'receipts.json', path: '', size: 1, isDir: false },
    ]
    cloud.readBytes = async (id, filename) =>
      filename.endsWith('/latest.json')
        ? Buffer.from(JSON.stringify({ manifest: manifestHash }))
        : filename.endsWith('/receipts.json')
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                deviceId: device.id,
                receivedAt: '2026-10-01T00:01:00Z',
                books: [{ jobId, sha256: fileHash }],
              }),
            )
          : Buffer.from(objects.get(filename)!)
    cloud.readSyncState = async () => new Map(await Promise.all(['latest.json', 'receipts.json'].map(async (name) => [name, await cloud.readBytes('account', `KindleSpouse/Sync/devices/${device.id}/${name}`)] as const)))
    memoryDownloads(cloud)
    await sync.sync('account')
    assert.deepEqual(profiles.map(profile => profile.reading.totalSeconds), [0, 60])
    assert.equal(profiles[1].reading.readingDays, 1)
    assert.notEqual(profiles[0].revision, profiles[1].revision)
    await sync.sync('account')
    assert.equal(profiles.length, 2)
    assert.equal(sync.snapshot().devices[0].status, 'connected')
    assert.equal(history.stats().totalSeconds, 60)
    assert.equal(store.get<{ deviceReceivedAt: string }>('jobs', jobId)?.deviceReceivedAt, '2026-10-01T00:01:00Z')
    assert.deepEqual(
      await readFile(path.join(root, 'cloud-snapshots', device.id, manifestHash, 'documents/a.txt')),
      file,
    )
    objects.set(`KindleSpouse/Sync/objects/${fileHash}`, Buffer.from('tampered'))
    await rm(path.join(root, 'cloud-snapshots', device.id, manifestHash, 'documents/a.txt'))
    await sync.sync('account')
    assert.deepEqual(await readFile(path.join(root, 'cloud-snapshots', device.id, manifestHash, 'documents/a.txt')), file)
    await rm(path.join(root, 'cloud-objects', fileHash))
    await rm(path.join(root, 'cloud-snapshots', device.id, manifestHash, 'documents/a.txt'))
    await assert.rejects(sync.sync('account'), /校验失败/)
  } finally {
    await sync.close()
    await notes.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
