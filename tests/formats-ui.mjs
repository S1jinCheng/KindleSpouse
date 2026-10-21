import assert from 'node:assert/strict'
import { _electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { getAcceptanceFormats } from '../scripts/acceptance-formats.mjs'

await mkdir('.test-data', { recursive: true })
const directory = await mkdtemp(path.resolve('.test-data/format-ui-'))
const files = await getAcceptanceFormats(path.join(directory, 'books'))
const mobi = files.find(filename => filename.endsWith('.mobi'))
const originals = new Map([['/Original.mobi', await readFile(mobi)], ['/Original.epub', await readFile(files[0])]])
const server = createServer((request, response) => {
  const bytes = originals.get(request.url)
  if (!bytes) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'Content-Type': request.url.endsWith('.mobi') ? 'application/x-mobipocket-ebook' : 'application/epub+zip', 'Content-Length': bytes.length }).end(bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const application = await _electron.launch({ args: ['.'], env: { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_DATA_DIR: path.join(directory, 'data') }, timeout: 45000 })
const page = await application.firstWindow()
const errors = []
page.on('pageerror', error => errors.push(error.stack || error.message))
const state = () => page.evaluate(() => window.kindlespouse.state())
const session = () => page.locator('.reading-shell .reader-card').getAttribute('data-session-id')
const waitReady = () => page.waitForFunction(() => {
  const image = document.querySelector('.reading-shell .native-reader-page')
  return image?.complete && image.naturalWidth === 1860 && !document.querySelector('.reading-shell .paper-overlay') && document.querySelector('.reading-shell')?.dataset.readerReady === 'true'
}, undefined, { timeout: 150000 })
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960))
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.evaluate(url => window.kindlespouse.download(url), origin + '/Original.epub')
  const other = (await state()).candidates[0]
  await page.evaluate(url => window.kindlespouse.download(url), origin + '/Original.mobi')
  await waitReady()
  assert.equal((await state()).settings.readerEngine, 'browser')
  const book = (await state()).candidates.find(candidate => candidate.format === 'mobi')
  assert.ok(book)
  const initial = await session()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.native-reader-page')?.alt.startsWith('KOReader 第 2 页'))
  await waitReady()
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  await waitReady()
  assert.equal(await session(), initial)
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.evaluate(id => window.kindlespouse.openKoreader(id), other.id)
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  await page.waitForFunction(id => document.querySelector('.reading-shell .reader-card')?.dataset.sessionId !== id, initial, { timeout: 150000 })
  await waitReady()
  assert.match(await page.locator('.native-reader-page').getAttribute('alt'), /^KOReader 第 2 页/)
  const restored = await session()
  await page.getByRole('button', { name: 'Aa', exact: true }).click()
  await page.getByRole('button', { name: '重新加载设备排版', exact: true }).click()
  await page.waitForFunction(id => {
    const current = document.querySelector('.reading-shell .reader-card')?.dataset.sessionId
    return current && current !== id
  }, restored, { timeout: 150000 })
  await waitReady()
  assert.match(await page.locator('.native-reader-page').getAttribute('alt'), /^KOReader 第 2 页/)
  assert.equal((await state()).jobs.length, 0)
  await page.getByRole('button', { name: '书籍信息', exact: true }).click()
  const pages = Number((await page.locator('.native-reader-page').getAttribute('alt')).match(/共 (\d+) 页/)[1])
  for (let number = 3; number <= Math.min(12, pages); number++) {
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(expected => document.querySelector('.native-reader-page')?.alt.startsWith(`KOReader 第 ${expected} 页`), number)
    await waitReady()
  }
  await mkdir('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/mobi_native_preview.png' })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ passed: true, nativeMobiInBrowserPreference: true, navigationReusesSession: true, displacedSessionRestoresPage: true, layoutReloadRestartsAtSamePage: true, noTransferBeforeApproval: true }))
} catch (error) {
  await writeFile('.test-data/format-ui-error.json', JSON.stringify({ error: String(error), overlays: await page.locator('.paper-overlay').allTextContents(), engine: await page.locator('.reading-shell .reader-card').getAttribute('data-engine'), errors }))
  await page.screenshot({ path: '.test-data/format-ui-failure.png' })
  throw error
} finally {
  await application.close()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
