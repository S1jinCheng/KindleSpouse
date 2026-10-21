import { _electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.resolve('.test-data/discovery-filters-'))
const application = await _electron.launch({ args: ['.'], env: { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_DATA_DIR: directory }, timeout: 45000 })
const page = await application.firstWindow()
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  await application.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const original = ipcMain._invokeHandlers.get('state')
    const window = BrowserWindow.getAllWindows()[0]
    const local = { id: '10000000-0000-4000-8000-000000000001', title: 'Guide on Kindle', author: 'Fixture Author', format: 'epub', sha256: 'a'.repeat(64), filename: 'guide.epub', bytes: 100, source: 'Kindle 私有导入', library: true, fromDevice: true, createdAt: new Date().toISOString(), warnings: [], chapters: 1, progress: 0 }
    const decorate = state => ({ ...state, candidates: [local, { ...local, id: '10000000-0000-4000-8000-000000000002', title: 'Guide reading copy', sha256: 'b'.repeat(64), derivedFromHash: 'c'.repeat(64) }, { ...local, id: '10000000-0000-4000-8000-000000000003', title: 'Protected dictionary', format: 'azw', sha256: 'd'.repeat(64), warnings: ['平台 DRM'] }] })
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => send(channel, ...(channel === 'state' ? [decorate(args[0])] : args))
    ipcMain.removeHandler('state')
    ipcMain.handle('state', async event => decorate(await original(event)))
    globalThis.discoverySearches = []
    ipcMain.removeHandler('search-discovery')
    ipcMain.handle('search-discovery', async (_event, query, scope) => {
      globalThis.discoverySearches.push({ query, scope })
      if (query === 'Slow' && scope === 'catalog') await new Promise(resolve => { globalThis.releaseDiscovery = resolve })
      const result = scope === 'catalog' ? { id: 'douban:123456', title: `${query} catalog`, author: 'Catalog Author', source: 'douban', doubanUrl: 'https://book.douban.com/subject/123456/' } : { id: `${scope}:fixture`, title: `${query} ${scope}`, author: 'File Author', source: scope === 'source' ? 'zlib' : 'cloud', format: 'epub' }
      return { results: [result], warnings: [] }
    })
    return window.webContents.send('state', decorate(await original({ sender: window.webContents, senderFrame: window.webContents.mainFrame })))
  })
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  const filters = page.getByRole('group', { name: '筛选搜书结果' })
  assert.equal(await page.locator('.discovery-recent-row').count(), 3)
  assert.equal(await page.getByRole('button', { name: '仅原件备份 Protected dictionary', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '试读 Protected dictionary', exact: true }).count(), 0)
  assert.equal(await page.getByText('从 Kindle 导入', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Kindle 原件的阅读副本', { exact: true }).count(), 1)
  assert.equal(await page.getByText('已在 Kindle', { exact: true }).count(), 0)
  for (const [filter, title] of [['豆瓣书目', '搜索豆瓣书目'], ['可下载', '搜索可下载版本'], ['网盘', '搜索网盘书籍'], ['书源', '搜索书源']]) {
    await filters.getByRole('button', { name: filter, exact: true }).click()
    await page.getByText(title, { exact: true }).waitFor()
    assert.equal(await page.locator('.discovery-recent-row').count(), 0)
    assert.equal(await page.getByLabel('统一搜索书籍').evaluate(element => element === document.activeElement), true)
  }
  await filters.getByRole('button', { name: '本机', exact: true }).click()
  await page.getByRole('heading', { name: '本机书籍', exact: true }).waitFor()
  assert.equal(await page.locator('.discovery-recent-row').count(), 3)
  await page.getByLabel('统一搜索书籍').fill('Guide')
  await filters.getByRole('button', { name: '豆瓣书目', exact: true }).click()
  await page.getByRole('button', { name: 'Guide catalog', exact: true }).waitFor()
  assert.equal(await page.locator('.discovery-result').count(), 1)
  assert.deepEqual(await application.evaluate(() => globalThis.discoverySearches), [{ query: 'Guide', scope: 'catalog' }])
  await filters.getByRole('button', { name: '可下载', exact: true }).click()
  await page.getByRole('button', { name: 'Guide source', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Guide cloud', exact: true }).waitFor()
  assert.equal(await page.locator('.discovery-result').count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Guide catalog', exact: true }).count(), 0)
  const requests = await application.evaluate(() => globalThis.discoverySearches.length)
  await filters.getByRole('button', { name: '本机', exact: true }).click()
  assert.equal(await page.locator('.discovery-result').count(), 2)
  assert.equal(await application.evaluate(() => globalThis.discoverySearches.length), requests)
  await filters.getByRole('button', { name: '网盘', exact: true }).click()
  await page.getByRole('button', { name: 'Guide cloud', exact: true }).waitFor()
  assert.equal(await page.locator('.discovery-result').count(), 1)
  await filters.getByRole('button', { name: '书源', exact: true }).click()
  await page.getByRole('button', { name: 'Guide source', exact: true }).waitFor()
  assert.equal(await page.locator('.discovery-result').count(), 1)
  await page.getByLabel('统一搜索书籍').fill('Another')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: 'Another source', exact: true }).waitFor()
  assert.equal(await filters.getByRole('button', { name: '书源', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByLabel('统一搜索书籍').fill('Slow')
  await filters.getByRole('button', { name: '豆瓣书目', exact: true }).click()
  await page.getByLabel('统一搜索书籍').fill('Latest')
  await filters.getByRole('button', { name: '可下载', exact: true }).click()
  await page.getByRole('button', { name: 'Latest source', exact: true }).waitFor()
  await application.evaluate(() => globalThis.releaseDiscovery())
  assert.equal(await page.getByRole('button', { name: 'Slow catalog', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Latest cloud', exact: true }).isVisible(), true)
  console.log('Discovery filters passed: empty categories, immediate scoped search, local-only filtering, selected filter on submit, stale response isolation and truthful Kindle import labels.')
} finally {
  await application.close()
  assert.equal(path.dirname(directory), path.resolve('.test-data'))
  await rm(directory, { recursive: true, force: true })
}
