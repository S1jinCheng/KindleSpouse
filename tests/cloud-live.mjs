import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'
import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

if (process.env.KINDLESPOUSE_LIVE_CLOUD !== '1') throw new Error('Set KINDLESPOUSE_LIVE_CLOUD=1 for the interactive, real-account acceptance test.')
const application = await electron.launch({ args: ['.'], timeout: 45000 })
const page = await application.firstWindow()
const waitFor = async predicate => { const deadline = Date.now() + 300000; while (Date.now() < deadline) { if (await predicate()) return; await page.waitForTimeout(300) } throw new Error('Cloud acceptance timed out') }
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  let state = await page.evaluate(() => window.kindlespouse.state())
  let account = state.clouds.find(item => item.provider === 'drive')
  let valid = false
  if (account) valid = await page.evaluate(id => window.kindlespouse.checkCloud(id).then(() => true).catch(() => false), account.id)
  if (!valid) {
    console.log('BROWSER_AUTHORIZATION_REQUIRED')
    await page.evaluate(() => window.kindlespouse.connectCloud('drive'))
    state = await page.evaluate(() => window.kindlespouse.state())
    account = state.clouds.filter(item => item.provider === 'drive').at(-1)
  }
  if (!account) throw new Error('No authorized Google Drive account')
  const fixture = await getAcceptanceBook()
  await application.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, fixture)
  await page.getByRole('button', { name: '导入书籍', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true')
  state = await page.evaluate(() => window.kindlespouse.state())
  const book = state.candidates.find(item => item.title === 'KindleSpouse 使用指南')
  const jobId = await page.evaluate(({ book, account }) => window.kindlespouse.approve({ candidateId: book.id, sha256: book.sha256, method: 'cloud', cloudAccountId: account.id }), { book, account })
  await waitFor(async () => (await page.evaluate(() => window.kindlespouse.state())).jobs.some(job => job.id === jobId && ['cloud_ready', 'failed'].includes(job.status)))
  state = await page.evaluate(() => window.kindlespouse.state())
  const job = state.jobs.find(item => item.id === jobId)
  if (job.status !== 'cloud_ready') throw new Error(job.error ?? 'Cloud upload failed')
  const entries = await page.evaluate(({ id, folder }) => window.kindlespouse.listCloud(id, folder), { id: account.id, folder: job.remotePath.split('/').slice(0, -1).join('/') })
  if (!entries.some(entry => entry.path === job.remotePath)) throw new Error('Uploaded book is not listed')
  const id = await page.evaluate(({ id, filename }) => window.kindlespouse.downloadCloud(id, filename), { id: account.id, filename: job.remotePath })
  state = await page.evaluate(() => window.kindlespouse.state())
  if (state.candidates.find(item => item.id === id).sha256 !== book.sha256) throw new Error('Cloud download fingerprint mismatch')
  const outbox = await page.evaluate(id => window.kindlespouse.listCloud(id, 'KindleSpouse/Sync/outbox'), account.id)
  if (!outbox.some(entry => entry.name === `${jobId}.json`)) throw new Error('Device acquisition manifest is missing')
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/cloud-live-result.json', JSON.stringify({ provider: 'Google Drive', uploadReadback: true, remoteList: true, downloadDeduplicated: true, acquisitionManifest: true, kindleReceipt: Boolean(job.deviceReceivedAt) }, null, 2))
  console.log('REAL_CLOUD_UPLOAD_LIST_DOWNLOAD_VERIFIED')
} finally { await application.close() }
