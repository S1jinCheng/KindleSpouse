import assert from 'node:assert/strict'
import { _electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'
import { readerRuntimeRoot } from '../electron/koreader'

await mkdir('.test-data', { recursive: true })
const directory = await mkdtemp(path.resolve('.test-data/reader-startup-'))
const runtimeRoot = readerRuntimeRoot(directory)
const bytes = await readFile(await getAcceptanceBook())
const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': bytes.length }).end(bytes))
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const application = await _electron.launch({ args: ['.'], env: { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_TEST_NATIVE_STARTUP: '1', KINDLESPOUSE_DATA_DIR: directory }, timeout: 45000 })
const page = await application.firstWindow()
let residentDirectory = ''
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).candidates.length, 0)
  const deadline = Date.now() + 150000
  while (Date.now() < deadline && !residentDirectory) {
    for (const name of await readdir(runtimeRoot).catch(() => [])) {
      const folder = path.join(runtimeRoot, name)
      const frame = await readFile(path.join(folder, 'frame.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      const documents = await readdir(path.join(folder, 'documents')).catch(() => [])
      if (frame?.seq === 0 && frame.version === 'v2026.07.1' && !frame.error && documents.some(document => existsSync(path.join(folder, 'documents', document, 'book.txt')))) residentDirectory = folder
    }
    if (!residentDirectory) await new Promise(resolve => setTimeout(resolve, 150))
  }
  assert.ok(residentDirectory, 'The native reader must be ready before importing a book or opening discovery')
  assert.ok(existsSync(path.join(directory, 'reader-startup/welcome.txt')))
  await page.evaluate(() => window.kindlespouse.saveSettings({ readerEngine: 'koreader' }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await page.evaluate(url => window.kindlespouse.download(url), `http://127.0.0.1:${address.port}/Guide.epub`)
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.reading-shell .native-reader-page')?.complete && document.querySelector<HTMLElement>('.reading-shell')?.dataset.readerReady === 'true', undefined, { timeout: 150000 })
  const first = await page.locator('.reading-shell .reader-card').getAttribute('data-session-id')
  const frame = JSON.parse(await readFile(path.join(residentDirectory, 'frame.json'), 'utf8'))
  assert.ok(frame.seq > 0)
  assert.ok(frame.pages > 1)
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.reading-shell')?.dataset.readerReady === 'true')
  assert.equal(await page.locator('.reading-shell .reader-card').getAttribute('data-session-id'), first)
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).jobs.length, 0)
} finally {
  await application.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
}
assert.ok(residentDirectory && !existsSync(residentDirectory), 'Quitting the app must close the resident reader and remove temporary copies')
console.log(JSON.stringify({ passed: true, emptyLibraryPrestartsNativeReader: true, firstBookReusesStartupRuntime: true, navigationReusesSession: true, noImplicitTransfer: true, runtimeCleanedOnExit: true }))
