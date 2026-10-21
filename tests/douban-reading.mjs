import { _electron as electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'

const directory = await mkdtemp(path.join(tmpdir(), 'KS-douban-reading-'))
const application = await electron.launch({ args: ['.'], env: { ...process.env, KINDLESPOUSE_TEST_MODE: '1', KINDLESPOUSE_DATA_DIR: directory }, timeout: 45000 })
const page = await application.firstWindow()
const document = (title, content) => `<html><head><meta charset="utf-8"><title>${title} (豆瓣)</title><style>body{width:1024px;background:#fff}#wrapper{width:1024px}.article{width:715px}.aside{width:300px}.hidden{display:none}.review-content{width:900px}</style></head><body><nav id="db-nav-book">网站导航</nav><div id="wrapper"><h1>${title}</h1><div id="content"><div class="article">${content}</div><aside class="aside">无关侧栏</aside></div></div></body></html>`
const search = document('搜索图书', `<style>.article{float:left;padding-right:25px}.mod-search{width:565px;margin-bottom:30px}.search-cate{float:left;width:65px;margin-right:35px}.search-cate ul{position:fixed;top:5px;width:65px;padding:0;list-style:none}.search-cate li{margin-bottom:12px}.search-result{float:left;width:565px}.result-list{margin-top:-8px;padding-right:3px}.result{position:relative;border-top:1px solid #ddd;margin-top:-1px}.result .pic{float:right;width:62px}.result .content{width:490px;margin-right:72px}</style><div class="mod-search"><form><input aria-label="原站搜索" value="排版验证书籍"></form></div><div class="search-cate" style="height:500px"><ul style="position:fixed;top:5px;width:65px">${['全部', '电影', '书籍', '音乐', '小组', '人物', '日记', '同城活动', '游戏'].map(category => `<li><a href="/search?cat=1001&q=test">${category}</a></li>`).join('')}</ul></div><div class="search-result"><div class="result-list">${[1, 2, 3].map((_, index) => `<div class="result"><div class="pic"><a href="https://book.douban.com/subject/123456/"><img width="62" height="93" alt="验证封面" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='62' height='93'%3E%3Crect width='62' height='93' fill='%239c5035'/%3E%3C/svg%3E"></a></div><div class="content"><div class="title"><h3><span>[书籍]</span><a href="https://book.douban.com/subject/123456/">${index === 0 ? '排版验证书籍' : `排版验证书籍版本${index + 1}`}</a></h3><div class="rating-info"><span class="rating_nums">8.0</span><span class="subject-cast">测试作者 / 测试出版社 / 2026</span></div></div><p>${'用于验证书库进入豆瓣搜索后的文字与封面布局。'.repeat(4)}</p></div></div>`).join('')}</div><div class="paginator"><a href="/search?cat=1001&q=test&start=15">下一页</a></div></div>`)
const subject = document('排版验证书籍', `<div id="info">原始版本资料</div><ul class="col2-list" style="width:590px"><li>原站固定宽度的试读链接</li></ul><div class="review-list"><div class="review-item" id="review-fixture"><header class="main-hd"><a class="name">原作者</a><span class="main-meta">2026-10-18</span></header><div class="main-bd"><h2><a href="https://book.douban.com/review/654321/">完整书评</a></h2><div class="review-short">原始摘要 <a class="unfold" href="javascript:;" onclick="document.querySelector('.full-content').classList.remove('hidden');document.querySelector('.review-short').classList.add('hidden')">展开全文</a></div><div class="full-content hidden">完整正文与原文引用保留。${'连续长词'.repeat(100)}</div><div class="action" style="width:562px"><a class="fold" href="javascript:;" onclick="document.querySelector('.full-content').classList.add('hidden');document.querySelector('.review-short').classList.remove('hidden')">收起</a><a href="https://book.douban.com/review/654321/#comments">回复</a></div></div></div></div>`)
const review = document('完整书评', '<div class="review-content"><p>独立书评正文</p><a href="https://accounts.douban.com/passport/login">登录页</a><a href="https://book.douban.com/unrecognized">其他页面</a></div>')
try {
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  await application.evaluate(({ session, shell }, pages) => {
    globalThis.doubanOpenedUrls = []
    shell.openExternal = async url => { globalThis.doubanOpenedUrls.push(url) }
    session.fromPartition('persist:kindlespouse-douban').protocol.handle('https', request => {
      const url = new URL(request.url)
      const html = url.hostname === 'accounts.douban.com' ? '<title>登录豆瓣</title><form class="account-form"><input type="password"><button>登录</button></form>'
        : url.pathname === '/search' ? pages.search : url.pathname === '/subject/123456/' ? pages.subject : url.pathname === '/review/654321/' ? pages.review : '<title>其他页面</title><p>保持原样</p>'
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    })
  }, { search, subject, review })
  await page.getByRole('button', { name: '找书与试读', exact: true }).click()
  await page.getByLabel('统一搜索书籍').fill('保留的搜索')
  await page.locator('.douban-link').click()
  await page.getByText('豆瓣 · 阅读模式', { exact: true }).waitFor()
  const remote = application.context().pages().find(remote => remote.url().startsWith('https://www.douban.com/search'))
  assert.ok(remote)
  const resize = async (remote, size) => {
    await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size)
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, size)
    const bounds = await page.locator('.douban-browser-space').boundingBox()
    await remote.waitForFunction(width => Math.abs(innerWidth - width) <= 1, Math.round(bounds.width))
  }
  const assertSearchLayout = async remote => {
    assert.equal(await remote.locator('.search-cate').isVisible(), false)
    assert.equal(await remote.locator('.mod-search').isVisible(), false)
    const layout = await remote.evaluate(() => {
      const entries = [...document.querySelectorAll('.result')].map(element => {
        const row = element.getBoundingClientRect(), content = element.querySelector('.content').getBoundingClientRect(), cover = element.querySelector('.pic').getBoundingClientRect()
        return { top: row.top + scrollY, bottom: row.bottom + scrollY, separated: content.right <= cover.left, contained: content.left >= row.left && cover.right <= row.right + 1, coverContained: cover.bottom <= row.bottom + 1 }
      })
      return { entries, fits: document.documentElement.scrollWidth <= innerWidth }
    })
    assert.equal(layout.fits, true)
    assert.equal(layout.entries.length, 3)
    assert.ok(layout.entries[0].top < 80)
    assert.ok(layout.entries.every((entry, index) => entry.separated && entry.contained && entry.coverContained && (index === 0 || entry.top + 1 >= layout.entries[index - 1].bottom)), JSON.stringify(layout))
  }
  for (const [width, height] of [[1040, 700], [1280, 800], [1510, 990]]) {
    await resize(remote, [width, height])
    await assertSearchLayout(remote)
  }
  await remote.evaluate(() => { window.originalResult = document.querySelector('.result'); scrollTo(0, 250) })
  await assertSearchLayout(remote)
  await page.getByRole('button', { name: '原网页', exact: true }).click()
  await remote.waitForFunction(() => !document.documentElement.dataset.ksDouban)
  assert.equal(await remote.locator('.search-cate').isVisible(), true)
  assert.equal(await remote.locator('.mod-search').isVisible(), true)
  await page.getByRole('button', { name: '阅读模式', exact: true }).click()
  await remote.waitForFunction(() => document.documentElement.dataset.ksDouban === 'search')
  assert.ok(await remote.evaluate(() => window.originalResult === document.querySelector('.result')))
  await assertSearchLayout(remote)
  await remote.getByRole('link', { name: '下一页', exact: true }).click()
  await remote.waitForURL('**start=15')
  await remote.waitForFunction(() => document.documentElement.dataset.ksDouban === 'search')
  await assertSearchLayout(remote)
  await remote.getByRole('link', { name: '排版验证书籍', exact: true }).click()
  await page.locator('.douban-page-heading h2').filter({ hasText: '排版验证书籍' }).waitFor()
  await remote.waitForFunction(() => document.documentElement.dataset.ksDouban === 'subject')
  assert.equal(await page.locator('.workspace-tabs').isVisible(), false)
  assert.deepEqual(await remote.evaluate(() => [typeof window.kindlespouse, typeof require]), ['undefined', 'undefined'])
  assert.equal(await remote.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(250, 249, 246)')
  assert.equal(await remote.locator('#db-nav-book').isVisible(), false)
  await remote.evaluate(() => document.fonts.ready)
  assert.ok(await remote.evaluate(() => [...document.fonts].some(font => font.family === 'Noto Serif SC' && font.status === 'loaded')))
  await remote.evaluate(() => { window.originalReview = document.querySelector('#review-fixture') })
  await remote.getByRole('link', { name: '展开全文', exact: true }).click()
  assert.equal(await remote.locator('.full-content').isVisible(), true)
  for (const [width, height] of [[1040, 700], [1280, 800], [1510, 990]]) {
    await resize(remote, [width, height])
    await remote.waitForFunction(() => innerWidth > 0 && document.documentElement.scrollWidth <= innerWidth)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.getByRole('button', { name: '原网页', exact: true }).click()
  await remote.waitForFunction(() => !document.documentElement.dataset.ksDouban)
  assert.equal(await remote.locator('#db-nav-book').isVisible(), true)
  await page.getByRole('button', { name: '阅读模式', exact: true }).click()
  await remote.waitForFunction(() => document.documentElement.dataset.ksDouban === 'subject')
  assert.ok(await remote.evaluate(() => window.originalReview === document.querySelector('#review-fixture')))
  assert.equal(await remote.locator('.full-content').isVisible(), true)
  await remote.getByRole('link', { name: '收起', exact: true }).click()
  assert.equal(await remote.locator('.full-content').isVisible(), false)
  await remote.getByRole('link', { name: '完整书评', exact: true }).click()
  await page.locator('.douban-page-heading h2').filter({ hasText: '完整书评' }).waitFor()
  await remote.waitForFunction(() => document.documentElement.dataset.ksDouban === 'review')
  await page.getByRole('button', { name: '浏览器打开', exact: true }).click()
  assert.deepEqual(await application.evaluate(() => globalThis.doubanOpenedUrls), ['https://book.douban.com/review/654321/'])
  assert.equal(await remote.evaluate(async () => (await fetch('kindlespouse://app/index.html')).status), 404)
  await remote.getByRole('link', { name: '登录页', exact: true }).click()
  await remote.getByRole('button', { name: '登录', exact: true }).waitFor()
  assert.equal(await remote.evaluate(() => document.documentElement.dataset.ksDouban), undefined)
  await page.getByText('豆瓣 · 原网页', { exact: true }).waitFor()
  await remote.goto('https://book.douban.com/unrecognized')
  await remote.getByText('保持原样', { exact: true }).waitFor()
  assert.equal(await remote.evaluate(() => document.documentElement.dataset.ksDouban), undefined)
  await page.getByRole('button', { name: '返回搜索', exact: true }).click()
  assert.equal(await page.getByLabel('统一搜索书籍').inputValue(), '保留的搜索')
  await page.locator('.douban-link').click()
  await page.getByText('豆瓣 · 阅读模式', { exact: true }).waitFor()
  const downloadPage = application.context().pages().find(remote => remote.url().startsWith('https://www.douban.com/search'))
  assert.ok(downloadPage)
  await downloadPage.getByRole('link', { name: '排版验证书籍', exact: true }).click()
  await page.locator('.douban-page-heading h2').filter({ hasText: '排版验证书籍' }).waitFor()
  await page.getByRole('button', { name: '查找下载', exact: true }).click()
  assert.equal(await page.getByLabel('统一搜索书籍').inputValue(), '排版验证书籍')
  assert.match(await page.getByRole('button', { name: '可下载', exact: true }).getAttribute('class'), /active/)
  await page.locator('.douban-link').click()
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.getByRole('heading', { name: '书库', exact: true }).waitFor()
  const filename = await getAcceptanceBook()
  await application.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, filename)
  await page.getByRole('button', { name: '导入书籍', exact: true }).click()
  await page.getByRole('button', { name: '书籍信息', exact: true }).click()
  await page.getByRole('button', { name: '加入书库', exact: true }).click()
  await page.getByRole('button', { name: '我的书库', exact: true }).click()
  await page.getByRole('button', { name: '阅读 KindleSpouse 使用指南', exact: true }).click()
  await page.getByRole('button', { name: '书籍信息', exact: true }).click()
  await page.getByRole('button', { name: '豆瓣书评', exact: true }).click()
  await page.getByText('豆瓣 · 阅读模式', { exact: true }).waitFor()
  const libraryRemote = application.context().pages().find(remote => remote.url().startsWith('https://www.douban.com/search'))
  assert.ok(libraryRemote)
  assert.equal(new URL(libraryRemote.url()).searchParams.get('q'), 'KindleSpouse 使用指南')
  for (const size of [[1040, 700], [1280, 800], [1510, 990]]) {
    await resize(libraryRemote, size)
    await assertSearchLayout(libraryRemote)
  }
  await libraryRemote.getByRole('link', { name: '排版验证书籍', exact: true }).click()
  await libraryRemote.waitForFunction(() => document.documentElement.dataset.ksDouban === 'subject')
  await libraryRemote.getByRole('link', { name: '展开全文', exact: true }).click()
  assert.equal(await libraryRemote.locator('.full-content').isVisible(), true)
  console.log('Douban reading checks passed: library entry, fixed category sidebar, search cover/text layout at three widths and after scrolling, pagination, responsive reviews, original DOM interactions, mode restoration, navigation, verification fallback, external links, isolation and quick close.')
} finally {
  await application.close()
  await rm(directory, { recursive: true, force: true })
}
