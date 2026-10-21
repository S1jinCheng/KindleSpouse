import { getAcceptanceBook, getAcceptancePdf } from '../scripts/acceptance-book.mjs'
import { avatarPng } from './image-fixture.mjs'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const artifacts = path.resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const filename = await getAcceptanceBook(),
  pdfFilename = await getAcceptancePdf()
const bytes = await readFile(filename),
  originalHash = createHash('sha256').update(bytes).digest('hex')
const server = createServer((request, response) =>
  request.url === '/guide.epub'
    ? response
        .writeHead(200, {
          'Content-Type': 'application/epub+zip',
          'Content-Length': bytes.length,
          'Content-Disposition': 'attachment; filename=Guide.epub',
        })
        .end(bytes)
    : response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>Login required</html>'),
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const directory = await mkdtemp(path.join(tmpdir(), 'KS-v03-e2e-'))
const exportsDirectory = await mkdtemp(path.join(tmpdir(), 'KS-original-download-'))
const legacyThumbnail = path.join(directory, 'cloud-snapshots/device/old/.notebooks/thumbnails/00000000-0000-0000-0000-000000000001.png')
await mkdir(path.dirname(legacyThumbnail), { recursive: true })
const thumbnailBytes = avatarPng(32)
await writeFile(legacyThumbnail, thumbnailBytes)
const legacyDatabase = new DatabaseSync(path.join(directory, 'kindlespouse.sqlite'))
legacyDatabase.exec('CREATE TABLE records (namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace,id))')
const insertLegacy = (namespace, value) => legacyDatabase.prepare('INSERT INTO records(namespace,id,payload) VALUES(?,?,?)').run(namespace, value.id, JSON.stringify(value))
insertLegacy('local-profile', { id: 'listener', port: 0 })
insertLegacy('candidates', { id: randomUUID(), title: '00000000-0000-0000-0000-000000000001', author: 'Unknown', path: legacyThumbnail, filename: path.basename(legacyThumbnail), format: 'png', sha256: createHash('sha256').update(thumbnailBytes).digest('hex'), bytes: thumbnailBytes.length, createdAt: new Date().toISOString(), source: 'Kindle 私有导入', fromDevice: true, library: true, chapters: 0, warnings: [], progress: 0 })
const notebookBytes = await readFile(pdfFilename), notebookHash = createHash('sha256').update(notebookBytes).digest('hex')
insertLegacy('notebooks', { id: randomUUID(), title: '课堂笔记', titleSource: 'manual', classification: 'notebook', format: 'pdf', path: pdfFilename, pdfPath: pdfFilename, sha256: notebookHash, pdfHash: notebookHash, bytes: notebookBytes.length, sourceKey: 'fixture-notebook', status: 'ready', importedAt: new Date().toISOString() })
legacyDatabase.close()
const application = await electron.launch({
  args: ['.'],
  env: { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_DATA_DIR: directory },
  timeout: 45000,
})
const page = await application.firstWindow(),
  errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error' && !/Electron Security Warning/.test(message.text())) errors.push(message.text())
})
const checks = []
const waitFor = async (predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Acceptance check timed out')
}
const state = () => page.evaluate(() => window.kindlespouse.state())
const openTransfer = async () => {
  await page.getByRole('button', { name: '书籍信息', exact: true }).click()
  if (!(await page.locator('.book-secondary-actions').getAttribute('open') !== null)) await page.locator('.book-secondary-actions summary').click()
  await page.getByRole('button', { name: '其他传书方式', exact: true }).click()
}
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  assert.equal((await state()).candidates.length, 0)
  assert.equal((await state()).notebooks[0].title, '课堂笔记')
  assert.equal(await page.locator('.shelf-book').count(), 0)
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).waitFor()
  await page.locator('.download-link summary').click()
  await page.getByLabel('书籍下载链接').fill(`http://127.0.0.1:${port}/guide.epub`)
  await page.getByRole('button', { name: '下载到试读区', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true')
  const initial = await state(),
    book = initial.candidates[0]
  assert.equal(book.sha256, originalHash)
  assert.equal(book.library, false)
  assert.equal(initial.jobs.length, 0)
  await page.getByRole('button', { name: '书籍信息', exact: true }).click()
  await page.locator('.book-secondary-actions summary').click()
  const downloadedOriginal = path.join(exportsDirectory, 'Guide.epub')
  await application.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }) })
  await page.getByRole('button', { name: '保存原文件', exact: true }).click()
  assert.equal((await state()).jobs.length, 0)
  await application.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }) }, downloadedOriginal)
  await page.getByRole('button', { name: '保存原文件', exact: true }).click()
  await waitFor(async () => { try { return (await readFile(downloadedOriginal)).length === bytes.length } catch { return false } })
  assert.deepEqual(await readFile(downloadedOriginal), bytes)
  await page.getByRole('button', { name: '书籍信息', exact: true }).click()
  await page.getByRole('button', { name: '查找完整下载版本', exact: true }).click()
  await waitFor(async () => await page.getByLabel('统一搜索书籍').inputValue() === book.title + ' ' + book.author)
  assert.equal(await page.getByLabel('统一搜索书籍').inputValue(), book.title + ' ' + book.author)
  assert.match(await page.getByRole('button', { name: '可下载', exact: true }).getAttribute('class'), /active/)
  assert.equal((await state()).jobs.length, 0)
  checks.push('preview original can be downloaded byte-for-byte; cancellation preserves state; full versions search uses title and author')
  assert.equal(await page.locator('.preview-caption,[aria-label="全屏阅读"],[aria-label="放大 PDF"]').count(), 0)
  await openTransfer()
  assert.equal(await page.getByLabel('传书方式').inputValue(), 'cloud')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: '确认传输', exact: true }).count(), 0)
  await page.getByRole('button', { name: '目录', exact: true }).click()
  await page.locator('.toc-list button').nth(1).click()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await waitFor(async () => Boolean((await state()).candidates[0].location))
  await page.getByRole('button', { name: '找书', exact: true }).click()
  await page.getByRole('group', { name: '筛选搜书结果' }).getByRole('button', { name: '全部', exact: true }).click()
  await page.getByLabel('统一搜索书籍').fill('KindleSpouse')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.discovery-result').waitFor()
  assert.equal(await page.locator('.discovery-result').count(), 1)
  await page.locator('.discovery-title').filter({ hasText: 'KindleSpouse 使用指南' }).click()
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true')
  await page.evaluate(() => { window.previewInstance = document.querySelector('.reading-shell .reader-card') })
  const beforeNavigation = (await state()).candidates.find(candidate => candidate.id === book.id).location
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.keyboard.press('ArrowRight')
  assert.equal((await state()).candidates.find(candidate => candidate.id === book.id).location, beforeNavigation)
  assert.equal(await page.locator('.sidebar-sync').count(), 0)
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  assert.ok(await page.evaluate(() => window.previewInstance === document.querySelector('.reading-shell .reader-card') && window.previewInstance.isConnected))
  assert.equal((await state()).candidates.find(candidate => candidate.id === book.id).location, beforeNavigation)
  assert.equal(await page.getByLabel('统一搜索书籍').inputValue(), 'KindleSpouse')
  assert.equal(await page.getByRole('button', { name: '下载 KindleSpouse 使用指南', exact: true }).isEnabled(), true)
  assert.equal(await page.locator('.reading-workspace > .global-toolbar').count(), 0)
  checks.push('reader instance and search survive navigation; hidden previews ignore page keys; workspace tools form one row')
  checks.push('download, real EPUB pagination and embedded local search; cloud is the default')
  await page.screenshot({ path: path.join(artifacts, 'v03-discovery.png'), fullPage: true })
  await page.evaluate(() => window.kindlespouse.enableOpds())
  await openTransfer()
  await page.getByLabel('传书方式').selectOption('opds')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await state()).jobs.length, 0)
  await openTransfer()
  await page.getByTestId('approve-transfer').click()
  await waitFor(async () => (await state()).jobs.some((job) => ['published', 'failed'].includes(job.status)), 90000)
  const published = await state()
  assert.equal(published.jobs[0].status, 'published')
  const auth = {
    Authorization: 'Basic ' + Buffer.from(`${published.opds.username}:${published.opds.password}`).toString('base64'),
  }
  assert.equal((await fetch(published.opds.address)).status, 401)
  const feed = await (await fetch(published.opds.address, { headers: auth })).text()
  const acquisition = [...feed.matchAll(/<link\b[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes('rel="http://opds-spec.org/acquisition"'))
    ?.match(/href="([^"]+)"/)?.[1]
  assert.ok(acquisition)
  const downloaded = Buffer.from(
    await (await fetch(new URL(acquisition, published.opds.address), { headers: auth })).arrayBuffer(),
  )
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), originalHash)
  await page.getByRole('button', { name: '打开传输记录' }).click()
  await page
    .getByRole('region', { name: '传输记录' })
    .waitFor()
    .catch(() => page.locator('.transfer-popover').waitFor())
  assert.equal(await page.locator('.job-row').count(), 1)
  await page.getByRole('button', { name: '关闭传输记录' }).click()
  checks.push('compact explicit approval, cancellation, transfer popover and authenticated byte-exact OPDS')
  await page.getByRole('button', { name: '我的书库', exact: false }).first().click()
  await page.locator('.shelf-book').waitFor()
  await page.getByRole('button', { name: '切换书籍列表' }).click()
  assert.equal(await page.locator('.books-list .shelf-book').count(), 1)
  await page.getByRole('button', { name: '整理 KindleSpouse 使用指南' }).click()
  await page.getByLabel('书集名称', { exact: true }).fill('测试书集')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '测试书集', exact: true }).waitFor()
  await page.getByRole('button', { name: '阅读 KindleSpouse 使用指南', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true')
  await page.getByRole('button', { name: '书库', exact: true }).click()
  checks.push('cover/list library, editable book metadata and collections, direct library reading')
  await application.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, pdfFilename)
  await page.getByRole('button', { name: '导入书籍', exact: true }).click()
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel('PDF 第 1 页').waitFor()
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel('跳转 PDF 页码').selectOption('2')
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel('PDF 第 2 页').waitFor()
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.getByLabel('按格式筛选').selectOption('pdf')
  assert.equal(await page.locator('.shelf-book').count(), 1)
  await page.getByLabel('按作者筛选').selectOption('name:kindlespouse')
  await page.getByText('没有符合条件的书籍', { exact: true }).waitFor()
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  assert.equal(await page.locator('.shelf-book').count(), 2)
  await page.getByLabel('按格式筛选').selectOption('epub')
  await page.getByRole('button', { name: '阅读 KindleSpouse 使用指南', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.reading-shell')?.dataset.readerReady === 'true')
  await page.getByRole('button', { name: '书库', exact: true }).click()
  assert.equal(await page.getByLabel('按格式筛选').inputValue(), 'epub')
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.getByLabel('按来源筛选').selectOption('本地导入')
  assert.equal(await page.locator('.shelf-book').count(), 1)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.getByRole('button', { name: '阅读 KindleSpouse Guide', exact: true }).click()
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel(/^PDF 第 [12] 页$/).waitFor()
  checks.push('combined format, author and source filters; empty intersection; clear filters and restore after reading')
  await page.getByRole('button', { name: '笔记与标注', exact: true }).click()
  await page.locator('.note-book-row').filter({ hasText: '课堂笔记' }).waitFor()
  await page.getByRole('button', { name: '导入笔记文件', exact: true }).click()
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel('PDF 第 1 页').waitFor()
  checks.push('legacy notebook thumbnail excluded from library at startup while named notebook opens in the notes page')
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel('跳转 PDF 页码').selectOption('2')
  await page.getByRole('region', { name: '仿 Kindle 阅读器' }).getByLabel('PDF 第 2 页').waitFor()
  const exported = path.join(directory, 'Notebook-Export.pdf')
  await application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
  }, exported)
  await page.getByRole('button', { name: '导出笔记 PDF' }).click()
  await waitFor(async () => {
    try {
      return (await readFile(exported)).length > 0
    } catch {
      return false
    }
  })
  assert.deepEqual(await readFile(exported), await readFile(pdfFilename))
  const noteId = createHash('sha256').update('safe fixture annotation').digest('hex')
  const annotation = {
    id: noteId,
    bookTitle: book.title,
    text: '原始格式与随附阅读资料都会保留。',
    kind: 'highlight',
    source: 'kindle',
    bookId: book.id,
    bookHash: book.sha256,
    anchor: { format: 'epub', quote: '原始格式与随附阅读资料都会保留。' },
  }
  const database = new DatabaseSync(path.join(directory, 'kindlespouse.sqlite'))
  database
    .prepare('INSERT INTO records(namespace,id,payload) VALUES (?,?,?)')
    .run('reading-notes', noteId, JSON.stringify(annotation))
  database.close()
  await page.evaluate(() => window.kindlespouse.saveSettings({ displayName: 'Guide Reader' }))
  await page.getByRole('button', { name: '书籍标注', exact: true }).click()
  await page.locator('.annotation-entry').click()
  await page.getByText('已定位标注', { exact: true }).waitFor({ timeout: 45000 })
  assert.equal(await page.getByRole('region', { name: '仿 Kindle 阅读器' }).count(), 1)
  await waitFor(async () => {
    const texts = await Promise.all(
      page
        .frames()
        .slice(1)
        .map((frame) =>
          frame
            .locator('body')
            .textContent()
            .catch(() => ''),
        ),
    )
    return texts.some((value) => value.includes('原始格式与随附阅读资料都会保留'))
  })
  await page.screenshot({ path: path.join(artifacts, 'v03-annotation.png'), fullPage: true })
  await page.getByRole('button', { name: '编辑笔记', exact: true }).click()
  await page.getByLabel('标注笔记内容').fill('A reversible desktop note')
  await page.locator('.confirm-modal').getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('A reversible desktop note', { exact: true }).waitFor()
  assert.equal((await state()).readingNotes[0].edit.status, 'local')
  await page.getByRole('button', { name: '归档标注', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.annotation-entry'))
  await page.getByLabel('显示已归档').check()
  await page.locator('.annotation-entry').waitFor()
  await page.getByRole('button', { name: '撤销整理', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.annotation-entry blockquote'))
  assert.equal((await state()).readingNotes[0].text, annotation.text)
  checks.push('annotation note editing, local-only status, reversible archiving and unchanged original quotation')
  checks.push('notebook PDF reading/export and three-column annotation navigation with real EPUB quote positioning')
  await page.getByRole('button', { name: '打开个人资料菜单' }).click()
  await page.getByRole('button', { name: '阅读时长与日历' }).click()
  assert.equal(await page.locator('.heatmap-cell').count(), 364)
  await page.getByRole('button', { name: '编辑资料', exact: true }).click()
  await page.getByLabel('个人昵称').fill('My reading space')
  await page.getByLabel('头像文字', { exact: true }).fill('读')
  await page.getByLabel('个人简介', { exact: true }).fill('在书里旅行')
  await page.getByLabel('所在地', { exact: true }).fill('上海')
  await page.getByRole('button', { name: '头像颜色：苔绿', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await waitFor(async () => (await state()).settings.displayName === 'My reading space')
  assert.equal((await state()).settings.bio, '在书里旅行')
  assert.equal((await state()).settings.location, '上海')
  assert.equal((await state()).settings.avatarTone, 'moss')
  assert.equal(await page.locator('.profile-trigger .avatar').textContent(), '读')
  assert.equal(await page.locator('.profile-heading .avatar').textContent(), '读')
  await page.getByRole('button', { name: '编辑资料', exact: true }).click()
  assert.equal(await page.getByLabel('个人简介', { exact: true }).inputValue(), '在书里旅行')
  await page.getByLabel('个人昵称').fill('Unsaved edit')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await state()).settings.displayName, 'My reading space')
  await page.getByRole('button', { name: '编辑资料', exact: true }).click()
  await page.getByLabel('上传头像文件').setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') })
  await page.getByRole('alert').filter({ hasText: '请选择 8 MB' }).waitFor()
  await page.getByLabel('上传头像文件').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: avatarPng() })
  await page.getByLabel('头像裁切预览').waitFor()
  const beforeCrop = await page.locator('.profile-avatar-editor img').getAttribute('src')
  await page.getByLabel('头像缩放').focus()
  await page.getByLabel('头像缩放').press('ArrowRight')
  await page.waitForFunction(before => document.querySelector('.profile-avatar-editor img').src !== before, beforeCrop)
  await page.locator('.profile-editor').screenshot({ path: path.join(artifacts, 'profile-avatar-editor.png') })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.ok(!(await state()).settings.avatarImage)
  await page.getByRole('button', { name: '编辑资料', exact: true }).click()
  await page.getByLabel('上传头像文件').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: avatarPng() })
  await page.locator('.profile-avatar-editor img').waitFor()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.profile-heading .avatar img').waitFor()
  assert.equal(await page.locator('.profile-trigger .avatar img').count(), 1)
  assert.ok((await state()).settings.avatarImage.startsWith('data:image/png;base64,'))
  const photoSize = await page.locator('.profile-heading .avatar img').evaluate(image => [image.naturalWidth, image.naturalHeight])
  assert.deepEqual(photoSize, [256, 256])
  await page.screenshot({ path: path.join(artifacts, 'profile-photo.png'), fullPage: true })
  await page.getByRole('button', { name: '编辑资料', exact: true }).click()
  await page.getByRole('button', { name: '移除照片', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.profile-heading .avatar img'))
  assert.equal((await state()).settings.avatarImage, '')
  assert.equal(await page.locator('.profile-heading .avatar').textContent(), '读')
  checks.push('photo upload, crop, cancellation, normalized 256px save and removal with initials fallback')
  await page.getByRole('button', { name: '打开个人资料菜单' }).click()
  await page.getByRole('button', { name: '设置与设备' }).click()
  assert.equal(await page.locator('.source-endpoint').count(), 10)
  assert.equal(await page.getByLabel('封面预览书籍').count(), 0)
  assert.equal(await page.getByRole('button', { name: '同步封面设置' }).count(), 0)
  await page.locator('.sleep-settings').screenshot({ path: path.join(artifacts, 'sleep-settings-redesign.png') })
  await page.getByRole('button', { name: '启用直连', exact: true }).click()
  await page.getByRole('button', { name: '关闭直连', exact: true }).waitFor()
  assert.equal((await state()).localProfiles.enabled, true)
  assert.equal((await state()).settings.localProfileEnabled, true)
  await page.locator('.local-profile-settings').screenshot({ path: path.join(artifacts, 'local-profile-settings.png') })
  await page.getByRole('button', { name: '关闭直连', exact: true }).click()
  await page.getByRole('button', { name: '启用直连', exact: true }).waitFor()
  assert.equal((await state()).localProfiles.enabled, false)
  checks.push('local profile connection can be enabled and stopped from settings without cloud authorization')
  checks.push('profile fields and avatar persist after save, cancel preserves stored values, 52-week Kindle calendar and settings/source health')
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  for (const size of [
    { width: 1510, height: 990 },
    { width: 1280, height: 800 },
    { width: 1040, height: 700 },
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value.width, value.height),
      size,
    )
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    assert.equal(await page.locator('.workspace-actions').getByRole('button', { name: '导入书籍', exact: true }).isVisible(), true)
  }
  for (let index = 0; index < 3; index++) {
    await page.getByRole('button', { name: '我的书库', exact: false }).first().click()
    await page.getByRole('button', { name: '阅读 KindleSpouse 使用指南' }).click()
    await page.getByRole('button', { name: '笔记与标注', exact: true }).click()
  }
  await page.waitForTimeout(300)
  assert.deepEqual(errors, [])
  checks.push('three desktop sizes and rapid navigation without renderer exceptions')
  await writeFile(
    path.join(artifacts, 'v03-acceptance.json'),
    JSON.stringify({ passed: true, checks, originalHash, errors, liveCloudVerified: false }, null, 2),
  )
  console.log(JSON.stringify({ passed: true, checks, errors }))
} finally {
  await application.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
  await rm(exportsDirectory, { recursive: true, force: true })
}
