import { SourcePool } from '../electron/source-pool'
import { NotebookLibrary, parseClippings, parseKoreaderNotes, notesMarkdown } from '../electron/notes'
import { Store } from '../electron/store'
import { sourceReference, supportedSourceOrigin, ZlibSource } from '../electron/source'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir, copyFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import path from 'node:path'
import JSZip from 'jszip'
import { AppCore } from '../electron/core'
import { contentHash, inspectBook, safePreview } from '../electron/books'
import { safeRemotePath } from '../electron/cloud'
import type { DeviceInfo } from '../src/shared'

async function fixture(directory: string, options: { title?: string; script?: boolean } = {}) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
  zip.file('book.opf', `<package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${options.title ?? 'Acceptance &amp; Recovery'}</dc:title><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">KindleSpouse</dc:creator></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`)
  zip.file('chapter.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><h1>Reader acceptance</h1><p>The confirmed file must match the delivered file.</p>${options.script ? '<script>globalThis.secret = true</script><img src="https://example.com/tracker" onload="alert(1)"/>' : ''}</body></html>`)
  const filename = path.join(directory, 'acceptance.epub')
  await writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }))
  return filename
}

async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)) }
  throw new Error('Timed out waiting for task state')
}

async function setup(devices: DeviceInfo[] = [{ id: 'own-test-device', name: 'Test device' }]) {
  const root = await mkdtemp(path.join(tmpdir(), 'KindleSpouse-test-'))
  const file = await fixture(root)
  const copies: string[] = []
  const secretValues = new Map<string, string>()
  const core = new AppCore({ directory: path.join(root, 'data'), nativeDirectory: path.join(root, 'native'), secrets: { get: key => secretValues.get(key), set: (key, value) => { secretValues.set(key, value) } }, openBrowser: async () => {}, transport: { list: async () => devices, upload: async (id, source, filename, hash) => { const destination = path.join(root, 'device', filename); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); assert.equal(contentHash(await readFile(destination)), hash); copies.push(destination) } }, allowLocalDownloads: true })
  return { root, file, core, copies, cleanup: async () => { await core.close(); await rm(root, { recursive: true, force: true }) } }
}

test('import stays in preview until explicitly confirmed; identical content is deduplicated', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    assert.equal(await env.core.importFile(env.file), id)
    assert.equal(env.core.snapshot().candidates.length, 1)
    assert.equal(env.core.snapshot().candidates[0].library, false)
    assert.equal(env.core.snapshot().jobs.length, 0)
    assert.equal(env.copies.length, 0)
    assert.equal('path' in env.core.snapshot().candidates[0], false)
  } finally { await env.cleanup() }
})

test('approval requires preview and the exact content hash', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    const book = env.core.book(id)
    await assert.rejects(env.core.approve({ candidateId: id, sha256: book.sha256, method: 'usb' }), /先打开/)
    await env.core.preview(id)
    await assert.rejects(env.core.approve({ candidateId: id, sha256: '0'.repeat(64), method: 'usb' }), /不一致/)
    assert.equal(env.core.snapshot().jobs.length, 0)
    assert.equal(env.copies.length, 0)
  } finally { await env.cleanup() }
})

test('confirmed transmission imports and copies unchanged bytes exactly once', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    await env.core.preview(id)
    const approval = { candidateId: id, sha256: env.core.book(id).sha256, method: 'usb' as const, deviceId: 'own-test-device' }
    const [first, second] = await Promise.all([env.core.approve(approval), env.core.approve(approval)])
    assert.equal(first, second)
    await waitFor(() => env.core.snapshot().jobs[0].status === 'sent')
    assert.equal(env.copies.length, 1)
    assert.equal(env.core.book(id).library, true)
    assert.deepEqual(await readFile(env.copies[0]), await readFile(env.file))
    assert.equal(env.core.snapshot().jobs[0].sha256, contentHash(await readFile(env.copies[0])))
  } finally { await env.cleanup() }
})

test('disconnected device preserves an approved task and cancellation prevents later copying', async () => {
  const devices: DeviceInfo[] = []
  const env = await setup(devices)
  try {
    const id = await env.core.importFile(env.file)
    await env.core.preview(id)
    const job = await env.core.approve({ candidateId: id, sha256: env.core.book(id).sha256, method: 'usb' })
    await waitFor(() => env.core.snapshot().jobs[0].status === 'waiting_device')
    await env.core.cancel(job)
    devices.push({ id: 'later-device', name: 'Later device' })
    await env.core.refreshDevices()
    assert.equal(env.core.snapshot().jobs[0].status, 'cancelled')
    assert.equal(env.copies.length, 0)
  } finally { await env.cleanup() }
})

test('a changed file cannot be confirmed or sent', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    await env.core.preview(id)
    const book = env.core.book(id)
    await writeFile(book.path, 'a different file')
    await assert.rejects(env.core.approve({ candidateId: id, sha256: book.sha256, method: 'usb' }), /不一致/)
    assert.equal(env.core.snapshot().jobs.length, 0)
    assert.equal(env.copies.length, 0)
  } finally { await env.cleanup() }
})

test('collecting a book never transmits it; library files cannot be discarded as temporary files', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    await env.core.collect(id)
    assert.equal(env.core.book(id).library, true)
    assert.equal(env.copies.length, 0)
    await assert.rejects(env.core.discard(id), /已入库/)
    assert.equal((await stat(env.core.book(id).path)).isFile(), true)
  } finally { await env.cleanup() }
})

test('discarding a candidate deletes only its private copy', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    await env.core.discard(id)
    assert.equal(env.core.snapshot().candidates.length, 0)
    assert.equal((await stat(env.file)).isFile(), true)
  } finally { await env.cleanup() }
})

test('a disguised HTML download is rejected instead of becoming a book', async () => {
  const env = await setup()
  try {
    const fake = path.join(env.root, 'login.epub')
    await writeFile(fake, '<html>Please log in</html>')
    await assert.rejects(env.core.importFile(fake), /下载页面/)
    assert.equal(env.core.snapshot().candidates.length, 0)
  } finally { await env.cleanup() }
})

test('preview removes scripts and event handlers while preserving the original transfer bytes', async () => {
  const env = await setup()
  try {
    const malicious = await fixture(env.root, { script: true })
    const metadata = await inspectBook(malicious)
    const originalHash = contentHash(await readFile(malicious))
    const clean = await safePreview(malicious, metadata.sha256)
    const zip = await JSZip.loadAsync(clean)
    const html = await zip.file('chapter.xhtml')!.async('string')
    assert.equal(html.includes('<script'), false)
    assert.equal(html.includes('onload='), false)
    assert.ok(html.includes('The confirmed file'))
    assert.equal(contentHash(await readFile(malicious)), originalHash)
  } finally { await env.cleanup() }
})

test('OPDS serves only approved books and validates authentication', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    const info = await env.core.catalog.start('127.0.0.1')
    assert.equal((await fetch(info.address)).status, 401)
    const headers = { Authorization: 'Basic ' + Buffer.from(`${info.username}:${info.password}`).toString('base64') }
    assert.equal((await (await fetch(info.address, { headers })).text()).includes('<entry>'), false)
    await env.core.preview(id)
    await env.core.approve({ candidateId: id, sha256: env.core.book(id).sha256, method: 'opds' })
    await waitFor(() => env.core.snapshot().jobs[0].status === 'published')
    const feed = await (await fetch(info.address, { headers })).text()
    assert.ok(feed.includes('Acceptance &amp; Recovery'))
    const route = feed.match(/href="(\/books\/[^\"]+)"/)![1]
    const bytes = new Uint8Array(await (await fetch(new URL(route, info.address), { headers })).arrayBuffer())
    assert.equal(contentHash(bytes), env.core.book(id).sha256)
    assert.equal(env.core.snapshot().jobs[0].status, 'published')
    assert.equal(env.copies.length, 0)
  } finally { await env.cleanup() }
})

test('download and validation preserve bytes; redirected HTML is not accepted', async () => {
  const env = await setup()
  const bytes = await readFile(env.file)
  const server = createServer((request, response) => {
    if (request.url === '/book.epub') response.writeHead(200, { 'Content-Type': 'application/epub+zip' }).end(bytes)
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Login required</html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await env.core.download(`http://127.0.0.1:${address.port}/book.epub`)
    assert.equal(env.core.snapshot().candidates[0].sha256, contentHash(bytes))
    await assert.rejects(env.core.download(`http://127.0.0.1:${address.port}/login`), /返回的是网页/)
    assert.equal(env.core.snapshot().candidates.length, 1)
    assert.equal(env.core.snapshot().jobs.length, 0)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await env.cleanup() }
})

test('remote paths cannot escape their selected root through traversal', () => {
  assert.equal(safeRemotePath('/KindleSpouse/Inbox/'), 'KindleSpouse/Inbox')
  for (const invalid of ['../secret', 'Inbox/../../secret', 'C:\\Users', 'a/./b', 'a\u0000b']) assert.throws(() => safeRemotePath(invalid))
})

test('interrupted transfers are recovered as retryable instead of marked delivered', async () => {
  const env = await setup()
  try {
    env.core.store.put('jobs', 'interrupted', { id: 'interrupted', candidateId: 'not-used', status: 'transferring', method: 'usb', createdAt: new Date().toISOString() })
    await env.core.close()
    const core = new AppCore({ directory: path.join(env.root, 'data'), nativeDirectory: path.join(env.root, 'native'), secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
    assert.equal(core.snapshot().jobs[0].status, 'failed')
    assert.match(core.snapshot().jobs[0].error ?? '', /中断/)
    await core.close()
  } finally { await rm(env.root, { recursive: true, force: true }) }
})

test('platform-encrypted EPUB is archived with a warning and cannot be previewed or approved', async () => {
  const env = await setup()
  try {
    const zip = await JSZip.loadAsync(await readFile(env.file))
    zip.file('META-INF/encryption.xml', '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>')
    await writeFile(env.file, await zip.generateAsync({ type: 'nodebuffer' }))
    const original = await readFile(env.file)
    const id = await env.core.importFile(env.file)
    assert.ok(env.core.book(id).warnings.some(warning => warning.includes('DRM')))
    await assert.rejects(env.core.preview(id), /DRM/)
    await assert.rejects(env.core.approve({ candidateId: id, sha256: contentHash(original), method: 'usb' }), /先打开/)
    assert.equal(env.copies.length, 0)
    assert.deepEqual(await readFile(env.file), original)
  } finally { await env.cleanup() }
})

test('font obfuscation does not incorrectly block an otherwise readable EPUB', async () => {
  const env = await setup()
  try {
    const zip = await JSZip.loadAsync(await readFile(env.file))
    zip.file('META-INF/encryption.xml', '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>')
    await writeFile(env.file, await zip.generateAsync({ type: 'nodebuffer' }))
    const id = await env.core.importFile(env.file)
    assert.ok((await env.core.preview(id)).length > 0)
  } finally { await env.cleanup() }
})

test('device snapshot indexing preserves all originals and sidecars and deduplicates content', async () => {
  const env = await setup()
  try {
    const snapshot = path.join(env.root, 'data', 'device-backups', 'snapshot-test')
    await mkdir(path.join(snapshot, 'documents', 'book.sdr'), { recursive: true })
    const originals = [
      { relative: 'documents/book.epub', content: await readFile(env.file) },
      { relative: 'documents/article.txt', content: Buffer.from('A personal article copied from the device.') },
      { relative: 'documents/book.sdr/reading.txt', content: Buffer.from('Preserved reading sidecar') },
    ]
    const files = []
    for (const file of originals) {
      await writeFile(path.join(snapshot, file.relative), file.content)
      files.push({ relative: file.relative, bytes: file.content.length, sha256: contentHash(file.content) })
    }
    await writeFile(path.join(snapshot, 'snapshot-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files }))
    await env.core.importDevice()
    const state = env.core.snapshot()
    assert.equal(state.candidates.length, 2)
    assert.equal(state.candidates.every(book => book.library && book.fromDevice), true)
    assert.equal(state.deviceImport?.files, 3)
    assert.equal(state.deviceImport?.imported, 2)
    assert.equal(state.jobs.length, 0)
    assert.equal(env.copies.length, 0)
    for (const file of originals) assert.deepEqual(await readFile(path.join(snapshot, file.relative)), file.content)
    const epub = state.candidates.find(book => book.format === 'epub')!
    assert.equal(await env.core.importFile(env.file), epub.id)
    assert.equal(env.core.snapshot().candidates.length, 2)
    assert.equal('previewPath' in state.candidates[0], false)
  } finally { await env.cleanup() }
})

test('modified private snapshot cannot be indexed as a verified device book', async () => {
  const env = await setup()
  try {
    const snapshot = path.join(env.root, 'data', 'device-backups', 'snapshot-test')
    await mkdir(snapshot, { recursive: true })
    await writeFile(path.join(snapshot, 'article.txt'), 'changed!')
    await writeFile(path.join(snapshot, 'snapshot-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: [{ relative: 'article.txt', bytes: 8, sha256: contentHash(Buffer.from('original')) }] }))
    await assert.rejects(env.core.importDevice(), /校验不一致/)
    assert.equal(env.core.snapshot().candidates.length, 0)
    assert.equal(await readFile(path.join(snapshot, 'article.txt'), 'utf8'), 'changed!')
  } finally { await env.cleanup() }
})

test('cloud transmission requires confirmation and reports remote availability without claiming Kindle receipt', async () => {
  const env = await setup()
  try {
    const uploads: string[] = []
    const manifests: unknown[] = []
    env.core.cloud.writeBytes = async (account, remote, bytes) => { assert.equal(account, 'test-cloud'); assert.ok(remote.includes('/outbox/')); manifests.push(JSON.parse(Buffer.from(bytes).toString('utf8'))) }
    env.core.store.put('clouds', 'test-cloud', { id: 'test-cloud', name: 'Test cloud', provider: 'drive', connected: true })
    env.core.cloud.uploadAndVerify = async (account, source, remote, hash, onVerify) => {
      assert.equal(account, 'test-cloud')
      assert.equal(contentHash(await readFile(source)), hash)
      uploads.push(remote)
      onVerify()
    }
    const id = await env.core.importFile(env.file)
    await env.core.preview(id)
    assert.equal(uploads.length, 0)
    await env.core.approve({ candidateId: id, sha256: env.core.book(id).sha256, method: 'cloud', cloudAccountId: 'test-cloud' })
    await waitFor(() => env.core.snapshot().jobs[0].status === 'cloud_ready')
    assert.equal(uploads.length, 1)
    assert.equal(manifests.length, 1)
    assert.equal((manifests[0] as { sha256: string }).sha256, env.core.book(id).sha256)
    assert.ok(uploads[0].startsWith('KindleSpouse/Inbox/'))
    assert.equal(env.core.snapshot().jobs[0].status, 'cloud_ready')
    assert.equal(env.copies.length, 0)
  } finally { await env.cleanup() }
})

test('books confirmed during an active cloud upload are drained automatically without a refresh or duplicate transfers', async () => {
  const env = await setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const uploaded: string[] = []
  const manifests: string[] = []
  try {
    env.core.store.put('clouds', 'test-cloud', { id: 'test-cloud', name: 'Test cloud', provider: 'drive', connected: true })
    env.core.cloud.writeBytes = async (_account, _remote, bytes) => { manifests.push(JSON.parse(Buffer.from(bytes).toString()).sha256) }
    env.core.cloud.uploadAndVerify = async (_account, source, _remote, expected, onVerify) => {
      uploaded.push(expected)
      if (uploaded.length === 1) await gate
      assert.equal(contentHash(await readFile(source)), expected)
      onVerify()
    }
    const first = await env.core.importFile(env.file)
    const second = await env.core.importFile(await fixture(env.root, { title: 'Second explicitly confirmed book' }))
    await env.core.preview(first)
    await env.core.preview(second)
    const approve = (id: string) => env.core.approve({ candidateId: id, sha256: env.core.book(id).sha256, method: 'cloud', cloudAccountId: 'test-cloud' })
    const firstJob = await approve(first)
    await waitFor(() => env.core.snapshot().jobs.find(job => job.id === firstJob)?.status === 'transferring')
    const secondJob = await approve(second)
    assert.equal(env.core.snapshot().jobs.find(job => job.id === secondJob)?.status, 'queued')
    assert.equal(await approve(first), firstJob)
    assert.equal(uploaded.length, 1)
    release()
    await waitFor(() => env.core.snapshot().jobs.every(job => job.status === 'cloud_ready'))
    assert.equal(uploaded.length, 2)
    assert.deepEqual(manifests, uploaded)
    assert.equal(env.core.snapshot().jobs.length, 2)
    assert.ok(env.core.snapshot().jobs.every(job => !job.deviceReceivedAt))
  } finally { release(); await env.cleanup() }
})

test('a cloud verification failure never becomes a delivered or downloadable book', async () => {
  const env = await setup()
  try {
    env.core.store.put('clouds', 'test-cloud', { id: 'test-cloud', name: 'Test cloud', provider: 'onedrive', connected: true })
    env.core.cloud.uploadAndVerify = async () => { throw new Error('Remote readback hash mismatch') }
    const id = await env.core.importFile(env.file)
    await env.core.preview(id)
    await env.core.approve({ candidateId: id, sha256: env.core.book(id).sha256, method: 'cloud', cloudAccountId: 'test-cloud' })
    await waitFor(() => env.core.snapshot().jobs[0].status === 'failed')
    assert.equal(env.core.snapshot().jobs[0].verifiedAt, undefined)
    const info = await env.core.catalog.start('127.0.0.1')
    const headers = { Authorization: 'Basic ' + Buffer.from(`${info.username}:${info.password}`).toString('base64') }
    assert.equal((await (await fetch(info.address, { headers })).text()).includes('<entry>'), false)
  } finally { await env.cleanup() }
})

test('saving a preview exports exact original bytes without collecting or sending the book', async () => {
  const env = await setup()
  try {
    const id = await env.core.importFile(env.file)
    await env.core.preview(id)
    const target = path.join(env.root, 'Downloaded original.epub')
    await env.core.exportBook(id, target)
    assert.deepEqual(await readFile(target), await readFile(env.file))
    assert.equal(env.core.book(id).library, false)
    assert.equal(env.core.snapshot().jobs.length, 0)
    assert.equal(env.copies.length, 0)
    await assert.rejects(env.core.exportBook(id, path.join(env.root, 'data', 'settings.json')), /资料目录之外/)
    const original = env.core.book(id)
    await writeFile(original.path, Buffer.alloc(original.bytes, 42))
    await assert.rejects(env.core.exportBook(id, target), /校验失败/)
    assert.deepEqual(await readFile(target), await readFile(env.file))
  } finally { await env.cleanup() }
})

test('upstream source IDs preserve their embedded version and reject mismatched or injected flags', () => {
  assert.equal(sourceReference('12345:abcdef', 'abcdef'), '12345:abcdef')
  assert.equal(sourceReference('12345', 'abcdef'), '12345:abcdef')
  assert.equal(sourceReference('abc123'), 'abc123')
  assert.throws(() => sourceReference('12345:abcdef', 'other'))
  assert.throws(() => sourceReference('--send-to-kindle --dir=private'))
  assert.throws(() => sourceReference('12345', '../../secret'))
})

test('source entry URL can map to an allowed login origin without forwarding credentials to unsupported sites', () => {
  const values = new Map<string, string>()
  const source = new ZlibSource('unused', 'unused', { get: key => values.get(key), set: (key, value) => { values.set(key, value) } })
  assert.equal(supportedSourceOrigin('https://zh.z-lib.help/'), undefined)
  assert.equal(supportedSourceOrigin('https://zlib.bz.attacker.example/'), undefined)
  assert.equal(supportedSourceOrigin('https://zh.zlib.bz/book/123'), 'https://zh.zlib.bz')
  assert.equal(source.saveSession('https://zh.z-lib.help/', { remix_userid: '123', remix_userkey: 'test-key' }), false)
  assert.equal(values.size, 0)
  assert.equal(source.saveSession('https://zh.z-lib.help/', { remix_userid: '123', remix_userkey: 'test-key' }, 'https://zh.zlib.bz/'), true)
  assert.equal(source.hasSession('https://zh.z-lib.help/'), true)
  assert.equal(source.connected('https://zh.z-lib.help/'), false)
  assert.equal(JSON.parse(values.get('zlib-session')!).domain, 'https://zh.zlib.bz')
  assert.equal(source.connected('https://unrelated.example/'), false)
})

test('source checks validate JSON and reject unsupported redirects without sending any credentials', async () => {
  const requests: string[] = []
  const pool = new SourcePool(() => {}, async (input, options) => {
    const url = String(input)
    requests.push(url)
    assert.equal(new Headers(options?.headers).has('Cookie'), false)
    assert.equal(new Headers(options?.headers).has('Authorization'), false)
    assert.equal(new Headers(options?.headers).has('remix-userkey'), false)
    if (url.startsWith('https://zlib.bz/')) return new Response(JSON.stringify({ success: 1, domains: [] }))
    if (url.startsWith('https://z-lib.gd/')) return new Response('<html>Login page</html>')
    if (url.startsWith('https://zliba.ru/')) return new Response(null, { status: 302, headers: { Location: 'https://unrelated.example/' } })
    return new Response('', { status: 503 })
  })
  try {
    const first = pool.refresh()
    assert.equal(first, pool.refresh())
    await first
    assert.deepEqual(pool.usable(), ['https://zlib.bz'])
    assert.equal(requests.some(url => url.includes('unrelated.example')), false)
    const count = requests.length
    await pool.ensureFresh()
    assert.equal(requests.length, count)
    assert.equal(pool.snapshot().entries.find(entry => entry.origin === 'https://z-lib.gd')?.status, 'offline')
  } finally { pool.stop() }
})

test('source switches a failed connection to a healthy backup and preserves the private entry-domain association', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-source-test-'))
  const values = new Map<string, string>()
  const pool = new SourcePool(() => {}, async input => new Response(JSON.stringify(String(input).startsWith('https://zlib.bz/') || String(input).startsWith('https://z-lib.gd/') ? { success: 1, domains: [] } : { success: 0 })))
  const calls: string[] = []
  const source = new ZlibSource('unused', root, { get: key => values.get(key), set: (key, value) => { values.set(key, value) } }, () => {}, pool, async (executable, args, options) => {
    const origin = String(options?.env?.ZLIB_DOMAIN)
    calls.push(origin)
    assert.equal(args.some(arg => arg.includes('test-private-key')), false)
    if (origin === 'https://zlib.bz') throw new Error('network request timed out')
    if (args[0] === 'profile') return JSON.stringify({ daily_remaining: 10, daily_allowed: 10 })
    return JSON.stringify({ books: [{ id: '123:abc', name: 'A book', extension: 'epub' }] })
  })
  try {
    source.saveSession('https://zh.z-lib.help/', { remix_userid: '123', remix_userkey: 'test-private-key' }, 'https://zlib.bz')
    const books = await source.search('A book', 'https://zh.z-lib.help/')
    assert.equal(books.length, 1)
    assert.deepEqual(calls, ['https://zlib.bz', 'https://z-lib.gd', 'https://z-lib.gd'])
    const saved = JSON.parse(values.get('zlib-session')!)
    assert.equal(saved.domain, 'https://z-lib.gd')
    assert.equal(saved.entryDomain, 'https://zh.z-lib.help')
  } finally { pool.stop(); await rm(root, { recursive: true, force: true }) }
})

test('account quota errors stop immediately instead of retrying across mirrors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-source-test-'))
  const values = new Map<string, string>()
  const pool = new SourcePool(() => {}, async () => new Response(JSON.stringify({ success: 1, domains: [] })))
  let calls = 0
  const source = new ZlibSource('unused', root, { get: key => values.get(key), set: (key, value) => { values.set(key, value) } }, () => {}, pool, async () => { calls++; throw new Error('daily download limit reached') })
  try {
    source.saveSession('https://zlib.bz', { remix_userid: '123', remix_userkey: 'test-key' })
    await assert.rejects(source.search('book', 'https://zlib.bz'), /额度/)
    assert.equal(calls, 1)
  } finally { pool.stop(); await rm(root, { recursive: true, force: true }) }
})

test('Kindle clippings preserve highlights, personal notes and bookmarks and deduplicate reimports', () => {
  const highlight = 'An Original Guide (Guide Author)\n- Your Highlight on page 2 | Location 14-18 | Added on Friday\n\nRead a few pages before confirming.\n==========\n'
  const personal = '个人指南（作者）\n- 您在第 3 页的笔记 | 添加于星期五\n\n这是我的读书想法。\n==========\n'
  const bookmark = 'An Original Guide (Guide Author)\n- Your Bookmark on page 4 | Added on Friday\n\n\n==========\n'
  const notes = parseClippings('\uFEFF' + highlight + highlight + personal + bookmark)
  assert.equal(notes.length, 3)
  assert.equal(notes.find(note => note.kind === 'highlight')?.author, 'Guide Author')
  assert.equal(notes.find(note => note.kind === 'note')?.text, '这是我的读书想法。')
  assert.equal(notes.filter(note => note.kind === 'bookmark').length, 1)
  assert.ok(notesMarkdown(notes).includes('这是我的读书想法。'))
})

test('KOReader annotations are read as data without evaluating Lua code', () => {
  const text = `os.execute('this must never run')
return { doc_props = { title = "Original Guide", authors = "Guide Author" }, annotations = { { text = "A real highlight", note = "中文笔记", pageno = 12, datetime = "2026-10-17" } }, suspicious = function() return os.execute('unused') end }`
  const notes = parseKoreaderNotes(text, 'Fallback')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].bookTitle, 'Original Guide')
  assert.equal(notes[0].note, '中文笔记')
  assert.equal(notes[0].location, '12')
})

test('notebook PDF import, reading and export keep the original intact and hide private paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-notebook-test-'))
  const store = new Store(path.join(root, 'data'))
  const library = new NotebookLibrary(store, path.join(root, 'data'), path.join(root, 'native'), () => {})
  try {
    const source = path.join(root, 'My Notebook.pdf')
    const bytes = Buffer.from('%PDF-1.4\nA local notebook fixture\n%%EOF')
    await writeFile(source, bytes)
    const id = await library.importFile(source)
    assert.equal(await library.importFile(source), id)
    assert.equal(library.notebooks().length, 1)
    assert.equal('path' in library.notebooks()[0], false)
    assert.deepEqual(Buffer.from(await library.preview(id)), bytes)
    const exported = path.join(root, 'Exported.pdf')
    await library.exportPdf(id, exported)
    assert.deepEqual(await readFile(exported), bytes)
    assert.deepEqual(await readFile(source), bytes)
    const book = store.get<{ path: string }>('notebooks', id)!
    await assert.rejects(library.exportPdf(id, book.path), /其他导出位置/)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})

test('a usable login entry is returned while slower source checks continue in the background', async () => {
  const pool = new SourcePool(() => {}, async (input, options) => {
    if (String(input).startsWith('https://zlib.bz/')) return new Response(JSON.stringify({ success: 1, domains: [] }))
    return new Promise((resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
  })
  try {
    assert.equal(await pool.firstAvailable(), 'https://zlib.bz')
    assert.equal(pool.snapshot().checking, true)
  } finally { pool.stop() }
})
