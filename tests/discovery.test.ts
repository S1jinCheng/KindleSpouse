import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DoubanCatalog, doubanSubject, doubanTarget, parseDoubanSearch } from '../electron/douban'
import { AppCore } from '../electron/core'
import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'
import { randomUUID } from 'node:crypto'

test('discovery binds the exact downloaded edition to verified bytes without uploading during preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-discovery-edition-'))
  const core = new AppCore({ directory: root, nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
  try {
    const filename = await getAcceptanceBook()
    core.source.download = async () => filename
    const id = await core.downloadSource('123:edition-a', 'edition-a')
    const binding = core.snapshot().discoveryFiles!.find(item => item.id === 'zlib:123:edition-a:edition-a')!
    assert.equal(binding.candidateId, id)
    assert.equal(binding.sha256, core.book(id).sha256)
    assert.equal(core.snapshot().discoveryFiles!.some(item => item.id.includes('edition-b')), false)
    await core.preview(id)
    assert.equal(core.snapshot().jobs.length, 0)
    assert.equal(core.book(id).library, false)
    const account = randomUUID()
    core.store.put('clouds', account, { id: account, connected: true, provider: 'drive', name: 'Fixture' })
    core.cloud.download = async (_id, _remote, target) => { await copyFile(filename, target); return target }
    assert.equal(await core.downloadCloud(account, 'KindleSpouse/Inbox/Guide.epub'), id)
    assert.equal(core.snapshot().discoveryFiles!.length, 2)
    assert.deepEqual(await readFile(core.book(id).path), await readFile(filename))
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})

test('lightweight receipts only acknowledge matching paired device, account and exact book bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-book-receipts-'))
  const core = new AppCore({ directory: root, nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
  try {
    const account = randomUUID(), device = randomUUID(), job = randomUUID(), candidate = randomUUID()
    core.store.put('sync-devices', device, { id: device, accountId: account, status: 'connected', name: 'Kindle', pairedAt: new Date().toISOString() })
    core.store.put('jobs', job, { id: job, candidateId: candidate, cloudAccountId: account, target: account, title: 'Fixture', sha256: 'a'.repeat(64), method: 'cloud', status: 'cloud_ready', progress: 1, createdAt: new Date().toISOString() })
    let receipt = { version: 1, deviceId: randomUUID(), receivedAt: new Date().toISOString(), books: [{ jobId: job, sha256: 'a'.repeat(64) }] }
    let reads = 0
    core.cloud.readBytes = async (_account, remote) => { assert.equal(_account, account); assert.ok(remote.endsWith('/receipts.json')); reads++; return Buffer.from(JSON.stringify(receipt)) }
    await core.refreshBookReceipts()
    assert.equal(core.snapshot().jobs[0].deviceReceivedAt, undefined)
    receipt.deviceId = device
    receipt.books[0].sha256 = 'b'.repeat(64)
    await core.refreshBookReceipts()
    assert.equal(core.snapshot().jobs[0].deviceReceivedAt, undefined)
    receipt.books[0].sha256 = 'a'.repeat(64)
    await core.refreshBookReceipts()
    assert.equal(core.snapshot().jobs[0].deviceReceivedAt, receipt.receivedAt)
    assert.equal(core.snapshot().sync.working, false)
    await core.refreshBookReceipts()
    assert.equal(reads, 3)
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})

const html = `<html><title>Search books</title><div class="result"><div class="pic"><img src="https://img3.doubanio.com/fixture.jpg"></div><h3><span>[书籍]</span><a href="https://www.douban.com/link2/?url=https%3A%2F%2Fbook.douban.com%2Fsubject%2F123456%2F&amp;query=fixture">Fixture &amp; Reading</a></h3><span class="rating_nums">8.4</span><span class="subject-cast">Fixture Author / Test Press / 2026</span></div></html>`

test('Douban search extracts book identity, edition and actual page ratings from relay links', () => {
  const books = parseDoubanSearch(html)
  assert.equal(books.length, 1)
  assert.equal(books[0].title, 'Fixture & Reading')
  assert.equal(books[0].author, 'Fixture Author')
  assert.equal(books[0].rating, 8.4)
  assert.equal(books[0].doubanUrl, 'https://book.douban.com/subject/123456/')
  assert.equal(books[0].source, 'douban')
  assert.equal(books[0].format, undefined)
  assert.equal(doubanTarget('unrelated', books[0].doubanUrl), books[0].doubanUrl)
  assert.match(doubanTarget('A & B'), /q=A%20%26%20B$/)
})

test('Douban metadata rejects foreign book links and image hosts and preserves absent ratings', () => {
  assert.equal(doubanSubject('https://book.douban.com.evil.test/subject/123456/'), undefined)
  assert.equal(doubanSubject('javascript:alert(1)'), undefined)
  assert.throws(() => doubanTarget('', 'https://example.com/'), /无效/)
  assert.equal(parseDoubanSearch(html.replace('https%3A%2F%2Fbook.douban.com', 'https%3A%2F%2Fevil.test')).length, 0)
  const [book] = parseDoubanSearch(html.replace('https://img3.doubanio.com', 'https://evil.test').replace('>8.4<', '>invalid<'))
  assert.equal(book.cover, undefined)
  assert.equal(book.rating, undefined)
})

test('Douban searches cache successful metadata and block external redirects before following them', async () => {
  let requests = 0
  const catalog = new DoubanCatalog(async () => { requests++; return new Response(html) })
  await catalog.search('Fixture')
  await catalog.search(' fixture ')
  assert.equal(requests, 1)
  const redirect = new DoubanCatalog(async () => { requests++; return new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }) })
  await assert.rejects(redirect.search('Fixture'), /不支持的网站/)
  assert.equal(requests, 2)
})

test('challenge pages request normal in-app verification while empty results remain valid', async () => {
  const catalog = new DoubanCatalog(async () => new Response('<title>安全验证</title>检测到有异常请求'))
  await assert.rejects(catalog.search('Fixture'), /登录或验证/)
  assert.deepEqual(parseDoubanSearch('<title>搜索无匹配</title><a>登录豆瓣</a>'), [])
  const oversized = new DoubanCatalog(async () => new Response('large', { headers: { 'content-length': String(3 * 1024 ** 2) } }))
  await assert.rejects(oversized.search('Fixture'), /超过读取上限/)
})

test('catalog results do not wait for cloud files and file search is scoped to the upload folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-discovery-'))
  const core = new AppCore({ directory: root, nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {}, douban: { search: async () => parseDoubanSearch(html) } })
  try {
    core.store.put('clouds', 'fixture', { id: 'fixture', name: 'Fixture drive', provider: 'drive', connected: true })
    let cloudRequests = 0
    core.cloud.search = async (id, query, folder) => {
      cloudRequests++
      assert.equal(folder, 'KindleSpouse/Inbox')
      return [{ name: 'Fixture.epub', path: folder + '/Fixture.epub', size: 100, isDir: false }]
    }
    const catalog = await core.searchDiscovery('Fixture', 'catalog')
    assert.equal(cloudRequests, 0)
    assert.equal(catalog.results[0].source, 'douban')
    const files = await core.searchDiscovery('Fixture', 'files')
    assert.equal(cloudRequests, 1)
    assert.equal(files.results.length, 1)
    assert.equal(files.results[0].source, 'cloud')
    assert.ok(files.warnings.some((warning) => warning.includes('登录书源')))
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})

test('source file results return independently of a stalled cloud lookup and preserve edition metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-discovery-source-'))
  const core = new AppCore({ directory: root, nativeDirectory: root, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {}, douban: { search: async () => { throw new Error('Catalog must not block file search') } } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    core.store.put('clouds', 'fixture', { id: 'fixture', name: 'Fixture drive', provider: 'drive', connected: true })
    core.source.hasSession = () => true
    core.source.search = async () => [{ id: '123:abc', hash: 'abc', name: 'Original guide', authors: ['Original author'], extension: 'epub', publisher: 'Test press', year: '2026' }]
    core.cloud.search = async () => { await held; return [] }
    const cloud = core.searchDiscovery('Original', 'cloud')
    const result = await Promise.race([core.searchDiscovery('Original', 'source'), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Source search waited for cloud')), 1000); timer.unref() })])
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].source, 'zlib')
    assert.equal(result.results[0].edition, 'Test press · 2026')
    assert.equal(result.warnings.length, 0)
    release()
    const completed = await cloud
    assert.equal(completed.results.length, 0)
    assert.equal(completed.warnings.length, 0)
  } finally { release(); await core.close(); await rm(root, { recursive: true, force: true }) }
})
