import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import path from 'node:path'
import JSZip from 'jszip'
import { KOREADER_EXTENSIONS, bookFormatFromFilename, bookMimeType, isKoreaderFormat, isKoreaderFilename, stripBookExtension } from '../src/book-formats'
import { inspectBook, contentHash, safeFilename } from '../electron/books'
import { AppCore } from '../electron/core'
import { CloudBridge } from '../electron/cloud'
import { koreaderLocation, parseKoreaderLocation } from '../src/koreader-location'

function mobi(encrypted = false) {
  const bytes = Buffer.alloc(200)
  bytes.write('Format validation', 0)
  bytes.write('BOOKMOBI', 60)
  bytes.writeUInt16BE(1, 76)
  bytes.writeUInt32BE(88, 78)
  bytes.writeUInt16BE(1, 88)
  bytes.writeUInt16BE(encrypted ? 1 : 0, 100)
  return bytes
}

test('format matching preserves compound suffixes, case, filenames and actual acquisition MIME types', () => {
  assert.equal(bookFormatFromFilename('目录/原著.FB2.ZIP'), 'fb2.zip')
  assert.equal(stripBookExtension('原著.FB2.ZIP'), '原著')
  assert.equal(safeFilename('原著.FB2.ZIP', 'fb2.zip'), '原著.fb2.zip')
  assert.equal(bookMimeType('mobi'), 'application/x-mobipocket-ebook')
  assert.equal(bookMimeType('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(isKoreaderFilename('original.MOBI'), true)
  for (const value of ['azw3', 'kfx', 'sh', 'py', 'exe']) assert.equal(isKoreaderFormat(value), false)
  assert.ok(KOREADER_EXTENSIONS.length > 40)
  assert.deepEqual(parseKoreaderLocation(koreaderLocation('/body/DocFragment[2]/p[3]', 20240114)), { position: '/body/DocFragment[2]/p[3]', domVersion: 20240114 })
  assert.deepEqual(parseKoreaderLocation('koreader:/body/1'), { position: '/body/1', domVersion: undefined })
})

test('imports inspect original native formats and retain exact bytes and embedded metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-formats-'))
  try {
    const doc = new JSZip().file('word/document.xml', '<w:document/>').file('docProps/core.xml', '<coreProperties><title>Original title</title><creator>Original author</creator></coreProperties>')
    const fb2 = '<FictionBook><description><title-info><book-title>原著书名</book-title><author><first-name>原</first-name><last-name>作者</last-name></author><lang>zh</lang></title-info></description><body><section><p>正文。</p></section></body></FictionBook>'
    const zip = await new JSZip().file('book.fb2', fb2).generateAsync({ type: 'nodebuffer' })
    const fixtures: [string, Buffer][] = [['original.mobi', mobi()], ['原著.FB2.ZIP', zip], ['document.docx', await doc.generateAsync({ type: 'nodebuffer' })], ['原著.fb2', Buffer.from(fb2)], ['原著.txt', Buffer.from('这是完整的中文正文。')], ['article.html', Buffer.from('<html><head><title>原始文章</title></head><body><p>原始正文</p></body></html>')], ['original.rtf', Buffer.from('{\\rtf1 Original body}')]]
    for (const [name, bytes] of fixtures) {
      const filename = path.join(root, name)
      await writeFile(filename, bytes)
      const book = await inspectBook(filename)
      assert.equal(book.format, bookFormatFromFilename(name))
      assert.equal(book.sha256, contentHash(bytes))
      assert.deepEqual(book.bytes, bytes)
      if (name.endsWith('.docx')) { assert.equal(book.title, 'Original title'); assert.equal(book.author, 'Original author') }
      if (name.endsWith('.fb2')) { assert.equal(book.title, '原著书名'); assert.equal(book.language, 'zh') }
    }
    const encrypted = path.join(root, 'encrypted.mobi')
    await writeFile(encrypted, mobi(true))
    assert.ok((await inspectBook(encrypted)).warnings.some(value => value.includes('平台 DRM')))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('new formats continue rejecting disguised pages, wrong containers, binaries and XML entities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-format-invalid-'))
  try {
    const fixtures: [string, Buffer][] = [['fake.mobi', Buffer.from('<html>login</html>')], ['fake.docx', await new JSZip().file('fake.txt', 'not a document').generateAsync({ type: 'nodebuffer' })], ['fake.cbz', await new JSZip().file('run.exe', 'MZ').generateAsync({ type: 'nodebuffer' })], ['fake.txt', Buffer.from('MZ\0\0binary')], ['fake.fb2', Buffer.from('<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "file:///secret">]><FictionBook/>')], ['fake.html', Buffer.from('<html><head><title>Login</title></head><body>Account</body></html>')]]
    for (const [name, bytes] of fixtures) {
      const filename = path.join(root, name)
      await writeFile(filename, bytes)
      await assert.rejects(inspectBook(filename))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('MOBI download, native preview approval and OPDS deliver the same original file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-mobi-delivery-'))
  const original = mobi()
  const server = createServer((request, response) => response.writeHead(200, { 'Content-Type': 'application/x-mobipocket-ebook', 'Content-Disposition': 'attachment; filename="Original.MOBI"' }).end(original))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const core = new AppCore({ directory: path.join(root, 'data'), nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {}, allowLocalDownloads: true })
  try {
    await core.download(`http://127.0.0.1:${(server.address() as { port: number }).port}/download`)
    const book = core.snapshot().candidates[0]
    assert.equal(book.format, 'mobi')
    assert.equal(core.snapshot().jobs.length, 0)
    await assert.rejects(core.approve({ candidateId: book.id, sha256: book.sha256, method: 'opds' }), /先打开/)
    core.koreader.open = async current => {
      assert.equal(current.format, 'mobi')
      assert.deepEqual(await readFile(current.path), original)
      return { sessionId: 'native-test', image: new Uint8Array(), page: 1, pages: 2, location: '/body/1', version: 'v2026.07.1', exactBook: false, toc: [] }
    }
    await core.openKoreader(book.id)
    await core.catalog.start('127.0.0.1')
    await core.approve({ candidateId: book.id, sha256: book.sha256, method: 'opds' })
    for (let attempt = 0; attempt < 100 && core.snapshot().jobs[0].status !== 'published'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    const info = core.catalog.info!
    const headers = { Authorization: 'Basic ' + Buffer.from(info.username + ':' + info.password).toString('base64') }
    const feed = await (await fetch(info.address, { headers })).text()
    assert.match(feed, /application\/x-mobipocket-ebook/)
    const target = feed.match(/href="(\/books\/[^" ]+)"/)![1]
    const response = await fetch(new URL(target, info.address), { headers })
    assert.equal(response.headers.get('content-type'), 'application/x-mobipocket-ebook')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original)
    core.store.put('clouds', 'cloud', { id: 'cloud', name: 'Test cloud', provider: 'drive', connected: true })
    core.store.put('sync-devices', 'old', { id: 'old', accountId: 'cloud', status: 'connected' })
    await assert.rejects(core.approve({ candidateId: book.id, sha256: book.sha256, method: 'cloud', cloudAccountId: 'cloud' }), /更新设备组件/)
    assert.equal(core.snapshot().jobs.length, 1)
  } finally { await core.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('cloud discovery includes upper-case and compound book suffixes and excludes unrelated files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-format-cloud-'))
  const cloud = new CloudBridge('unused', root, { get: () => JSON.stringify({ provider: 'drive', token: {} }), set: () => {} }, async () => {}, async (executable, args) => {
    assert.ok(args.includes('--ignore-case'))
    assert.ok(args.includes('*.mobi'))
    assert.ok(args.includes('*.fb2.zip'))
    return JSON.stringify([{ Name: 'Original.MOBI', Path: 'Original.MOBI', Size: 200 }, { Name: 'Original.FB2.ZIP', Path: 'Original.FB2.ZIP', Size: 200 }, { Name: 'Original.exe', Path: 'Original.exe', Size: 200 }])
  })
  try { assert.equal((await cloud.search('account', 'Original')).length, 2) }
  finally { await cloud.close(); await rm(root, { recursive: true, force: true }) }
})
