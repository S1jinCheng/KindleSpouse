import assert from 'node:assert/strict'
import { _electron } from 'playwright'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'

await mkdir('.test-data', { recursive: true })
const directory = await mkdtemp(path.resolve('.test-data/row-download-'))
const bytes = await readFile(await getAcceptanceBook())
const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'application/epub+zip' }).end(bytes))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const application = await _electron.launch({ args: ['.'], env: { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_TEST_NATIVE_STARTUP: '1', KINDLESPOUSE_DATA_DIR: directory }, timeout: 45000 })
const page = await application.firstWindow()
const errors = []
page.on('pageerror', error => errors.push(error.stack || error.message))
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  await page.evaluate(() => window.kindlespouse.saveSettings({ readerEngine: 'koreader' }))
  const account = randomUUID(), jobId = randomUUID()
  await application.evaluate(({ ipcMain, BrowserWindow }, { account, jobId, url }) => {
    const handlers = ipcMain._invokeHandlers
    const originalState = handlers.get('state'), download = handlers.get('download')
    const window = BrowserWindow.getAllWindows()[0]
    const trustedEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const fixture = { downloads: 0, approvals: [], retries: 0, receiptChecks: 0, bindings: [], job: undefined, received: false }
    const decorate = state => ({ ...state, sourceConnected: true, sourceAccount: { status: 'connected' }, settings: { ...state.settings, defaultCloudId: account }, clouds: [{ id: account, name: 'Fixture drive', provider: 'drive', connected: true }], discoveryFiles: fixture.bindings, jobs: fixture.job ? [fixture.job] : [] })
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === 'state' ? [decorate(args[0])] : args))
    const emit = async () => window.webContents.send('state', await originalState(trustedEvent))
    const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    replace('state', async event => decorate(await originalState(event)))
    replace('search-discovery', async (_event, _query, scope) => ({ results: scope === 'source' ? ['a', 'b'].map(version => ({ id: `zlib:fixture-${version}:edition-${version}`, title: `KindleSpouse Guide ${version.toUpperCase()}`, author: 'Fixture Author', source: 'zlib', format: 'epub', sourceBook: { id: `fixture-${version}`, hash: `edition-${version}`, name: `Guide ${version}`, extension: 'epub' } })) : [], warnings: [] }))
    replace('download-source', async (event, id, hash) => {
      fixture.downloads++
      await download(event, url)
      const state = await originalState(event), book = state.candidates[0]
      fixture.bindings.push({ id: `zlib:${id}:${hash}`, candidateId: book.id, sha256: book.sha256 })
      await emit()
      return book.id
    })
    replace('approve', async (_event, approval) => {
      fixture.approvals.push(approval)
      const book = (await originalState(trustedEvent)).candidates.find(book => book.id === approval.candidateId)
      if (!book || approval.sha256 !== book.sha256 || approval.cloudAccountId !== account || approval.method !== 'cloud') throw new Error('Incorrect edition or destination')
      fixture.job = { id: jobId, candidateId: book.id, title: book.title, sha256: book.sha256, method: 'cloud', cloudAccountId: account, target: account, status: 'queued', progress: 0, createdAt: new Date().toISOString() }
      await emit()
      return jobId
    })
    replace('retry', async (_event, id) => { if (id !== jobId) throw new Error('Wrong retry job'); fixture.retries++; fixture.job.status = 'transferring'; fixture.job.progress = .35; await emit() })
    replace('refresh-book-receipts', async () => {
      fixture.receiptChecks++
      if (fixture.received) { fixture.job.deviceReceivedAt = new Date().toISOString(); await emit() }
    })
    fixture.phase = async status => { fixture.job.status = status; fixture.job.progress = status === 'cloud_ready' ? 1 : .5; await emit() }
    globalThis.rowFixture = fixture
    return emit()
  }, { account, jobId, url: `http://127.0.0.1:${server.address().port}/Guide.epub` })
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  await page.getByLabel('统一搜索书籍').fill('Guide')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '试读 KindleSpouse Guide A', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true', undefined, { timeout: 150000 })
  await page.getByRole('button', { name: '下载 KindleSpouse Guide A', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下载 KindleSpouse Guide A', exact: true }).locator('small').innerText(), '仅本机试读')
  assert.equal(await page.getByRole('button', { name: '试读 KindleSpouse Guide B', exact: true }).isVisible(), true)
  assert.equal(await application.evaluate(() => globalThis.rowFixture.approvals.length), 0)
  assert.equal(await page.locator('.workspace-download, .compact-send').count(), 0)
  await page.getByRole('button', { name: '下载 KindleSpouse Guide A', exact: true }).dblclick()
  await page.getByRole('button', { name: '准备上传 KindleSpouse Guide A', exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog', { name: '确认传输', exact: true }).count(), 0)
  assert.equal(await application.evaluate(() => globalThis.rowFixture.approvals.length), 1)
  await application.evaluate(() => globalThis.rowFixture.phase('failed'))
  await page.getByRole('button', { name: '重试下载 KindleSpouse Guide A', exact: true }).click()
  assert.equal(await application.evaluate(() => globalThis.rowFixture.retries), 1)
  await application.evaluate(() => globalThis.rowFixture.phase('cloud_ready'))
  await page.getByRole('button', { name: '待收书 KindleSpouse Guide A', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '待收书 KindleSpouse Guide A', exact: true }).locator('small').innerText(), '已上传网盘')
  assert.equal(await page.getByRole('button', { name: '已在 Kindle KindleSpouse Guide A', exact: true }).count(), 0)
  await application.evaluate(() => { globalThis.rowFixture.received = true })
  await page.getByRole('button', { name: '已在 Kindle KindleSpouse Guide A', exact: true }).waitFor({ timeout: 35000 })
  assert.equal(await application.evaluate(() => globalThis.rowFixture.downloads), 1)
  assert.ok(await application.evaluate(() => globalThis.rowFixture.receiptChecks >= 2))
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '已在 Kindle KindleSpouse Guide A', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '试读 KindleSpouse Guide B', exact: true }).isVisible(), true)
  assert.deepEqual(errors, [])
  await mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/row-download-workflow.png' })
  console.log(JSON.stringify({ passed: true, actualNativePreview: true, externalServicesStubbed: true, previewThenOneClickDownload: true, noUploadBeforeClick: true, exactEditionAndDefaultDrive: true, duplicateClickProtected: true, retryReusesDownload: true, cloudReadyIsNotKindleReceived: true, backgroundReceiptRefresh: true, newEditionStillNeedsPreview: true, duplicateToolbarRemoved: true }))
} finally {
  await application.close()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
