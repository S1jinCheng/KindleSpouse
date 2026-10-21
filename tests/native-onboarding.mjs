import assert from 'node:assert/strict'
import { _electron } from 'playwright'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'
import { smtpFixture } from './smtp-fixture.mjs'

await mkdir('.test-data', { recursive: true })
const directory = await mkdtemp(path.resolve('.test-data/native-onboarding-'))
const data = path.join(directory, 'user-data')
const smtp = await smtpFixture()
const bytes = await readFile(await getAcceptanceBook())
const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'application/epub+zip' }).end(bytes))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const environment = { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_TEST_ONBOARDING: '1', KINDLESPOUSE_TEST_SMTP_PORT: String(smtp.port), KINDLESPOUSE_DATA_DIR: data }
let application
const errors = []
async function waitFor(predicate) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('Timed out waiting for native Kindle state')
}
try {
  application = await _electron.launch({ args: ['.'], env: environment, timeout: 45000 })
  let page = await application.firstWindow()
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(data))
  page.on('pageerror', error => errors.push(error.message))
  const wizard = page.getByRole('dialog', { name: 'Kindle 首次使用向导' })
  await wizard.waitFor()
  await page.getByRole('button', { name: '稍后设置设备', exact: true }).click()
  await page.getByRole('region', { name: '设备设置提醒' }).waitFor()
  const blocked = await page.evaluate(async () => {
    try { await window.kindlespouse.approve({ candidateId: crypto.randomUUID(), sha256: 'a'.repeat(64), method: 'kindle-email' }); return false } catch (error) { return String(error).includes('请先完成设备设置') }
  })
  assert.equal(blocked, true)
  await page.getByRole('button', { name: '继续设置', exact: true }).click()
  await wizard.waitFor()
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).settings.kindleMode, 'native')
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).kindleMail, undefined)
  await page.getByLabel('设备型号').selectOption('scribe-2022')
  await page.screenshot({ path: path.join(directory, '01-device.png') })
  await wizard.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: /Kindle 原生模式/ }).click()
  await page.screenshot({ path: path.join(directory, '02-reading-mode.png') })
  await wizard.getByRole('button', { name: '继续', exact: true }).click()
  assert.equal(await page.getByLabel('原生传书方式').count(), 0)
  await page.getByLabel('Kindle 收件邮箱').fill('fixture@kindle.com')
  await page.getByLabel('发件邮箱', { exact: true }).fill('fixture@example.org')
  await page.getByText('邮件服务器设置', { exact: true }).click()
  await page.getByLabel('SMTP 服务器').fill('smtp.example.org')
  await page.getByLabel('邮件授权码').fill(randomUUID())
  await page.getByRole('checkbox', { name: '我已将上面的发件邮箱加入 Amazon 的认可发件地址列表' }).check()
  await page.getByRole('button', { name: '保存并测试连接', exact: true }).click()
  await waitFor(async () => (await page.evaluate(() => window.kindlespouse.state())).kindleMail?.configured === true)
  assert.equal(await page.getByLabel('邮件授权码').inputValue(), '')
  assert.equal(smtp.messages.length, 0)
  await page.getByRole('button', { name: '发送测试文档', exact: true }).click()
  await waitFor(async () => smtp.messages.length === 1 && Boolean((await page.evaluate(() => window.kindlespouse.state())).kindleMail?.testSubmittedAt))
  assert.equal(smtp.messages.length, 1)
  await page.screenshot({ path: path.join(directory, '03-email-ready.png') })
  await page.getByRole('button', { name: '完成设置', exact: true }).click()
  await wizard.waitFor({ state: 'detached' })
  await page.getByRole('region', { name: 'Kindle 首次导入' }).waitFor()
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).initialImport.status, 'waiting_device')
  const runtime = path.join(tmpdir(), 'KindleSpouse-reader', createHash('sha256').update(path.resolve(data)).digest('hex').slice(0, 16))
  assert.equal(existsSync(runtime), false)
  assert.equal(existsSync(path.join(data, 'reader-startup')), false)
  await page.evaluate(url => window.kindlespouse.download(url), `http://127.0.0.1:${server.address().port}/Guide.epub`)
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true', undefined, { timeout: 45000 })
  const book = (await page.evaluate(() => window.kindlespouse.state())).candidates[0]
  assert.equal(existsSync(runtime), false)
  assert.equal(smtp.messages.length, 1)
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    const state = ipcMain._invokeHandlers.get('state')
    const window = BrowserWindow.getAllWindows()[0]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    ipcMain.removeHandler('search-discovery')
    ipcMain.handle('search-discovery', async (_event, _query, scope) => ({ results: scope === 'catalog' ? (await state(event)).candidates.map(book => ({ id: 'local:' + book.id, title: book.title, author: book.author, format: book.format, source: 'local', bookId: book.id, cover: book.cover })) : [], warnings: [] }))
  })
  await page.getByLabel('统一搜索书籍').fill('KindleSpouse')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const send = page.getByRole('button', { name: '发送到 Kindle ' + book.title, exact: true })
  await send.waitFor()
  await send.dblclick()
  await waitFor(async () => (await page.evaluate(() => window.kindlespouse.state())).jobs[0]?.status === 'email_submitted')
  assert.equal(smtp.messages.length, 2)
  await page.getByRole('button', { name: '已提交 ' + book.title, exact: true }).waitFor()
  const state = await page.evaluate(() => window.kindlespouse.state())
  assert.equal(state.jobs[0].deviceReceivedAt, undefined)
  assert.equal(state.jobs[0].sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal('password' in state.kindleMail, false)
  assert.equal(state.settings.readerEngine, 'browser')
  await page.screenshot({ path: path.join(directory, '04-preview-and-send.png') })
  await application.close()
  application = await _electron.launch({ args: ['.'], env: environment, timeout: 45000 })
  page = await application.firstWindow()
  await page.getByRole('button', { name: '打开个人资料菜单' }).waitFor()
  assert.equal(await page.getByRole('dialog', { name: 'Kindle 首次使用向导' }).count(), 0)
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).kindleMail.configured, true)
  await page.getByRole('region', { name: 'Kindle 首次导入' }).waitFor()
  await page.getByRole('button', { name: '打开个人资料菜单' }).click()
  await page.getByRole('button', { name: '设置与设备', exact: true }).click()
  await page.getByRole('button', { name: '选择设备与使用方式', exact: true }).click()
  await page.getByLabel('设备型号').selectOption('scribe-2025')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByLabel('原生传书方式').selectOption('native-cloud')
  assert.equal(await page.getByRole('button', { name: '完成设置', exact: true }).isDisabled(), true)
  await page.getByText('连接网盘后，从设备手动导入', { exact: true }).waitFor()
  await page.getByLabel('原生传书方式').selectOption('kindle-email')
  await page.getByRole('button', { name: '完成设置', exact: true }).click()
  assert.equal((await page.evaluate(() => window.kindlespouse.state())).settings.deviceModel, 'scribe-2025')
  await page.getByRole('button', { name: '选择设备与使用方式', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('button', { name: /KOReader 增强模式/ }).click()
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByRole('heading', { name: '准备 Kindle 上的 KOReader', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '完成设置', exact: true }).isDisabled(), true)
  await page.screenshot({ path: path.join(directory, '04-enhanced-setup.png') })
  await page.getByRole('button', { name: '稍后设置设备', exact: true }).click()
  const enhanced = await page.evaluate(() => window.kindlespouse.state())
  assert.equal(enhanced.settings.kindleMode, 'koreader')
  assert.equal(enhanced.settings.readerEngine, 'koreader')
  assert.equal(enhanced.kindleMail.configured, true)
  assert.equal(enhanced.candidates[0].sha256, book.sha256)
  assert.equal(smtp.messages.length, 2)
  assert.deepEqual(errors, [])
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, realLocalSmtpMessages: smtp.messages.length, nativePreviewWithoutWsl: true, exactOriginalHash: true, credentialsRedacted: true, restartPreservesSetup: true, enhancedModePreserved: true, noDeviceReceiptClaim: true }, null, 2))
  console.log(JSON.stringify({ passed: true, artifacts: directory, messages: smtp.messages.length }))
} catch (error) {
  if (application) await (await application.firstWindow()).screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await application?.close().catch(() => {})
  await smtp.close()
  await new Promise(resolve => server.close(resolve))
}
