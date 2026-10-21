import { parseDocument, DomUtils } from 'htmlparser2'
import type { DiscoveryResult } from '../src/shared'

const limit = 2 * 1024 * 1024
export function doubanSubject(value: string) {
  try {
    let url = new URL(value, 'https://www.douban.com')
    if (url.hostname === 'www.douban.com' && url.pathname === '/link2/') url = new URL(url.searchParams.get('url') ?? '')
    return url.protocol === 'https:' && url.hostname === 'book.douban.com' && /^\/subject\/\d+\/$/.test(url.pathname) ? url.origin + url.pathname : undefined
  } catch { return undefined }
}

export function doubanTarget(query?: string, subject?: string) {
  if (subject) {
    const target = doubanSubject(subject)
    if (!target) throw new Error('豆瓣书籍地址无效。')
    return target
  }
  return query?.trim() ? `https://www.douban.com/search?cat=1001&q=${encodeURIComponent(query.trim())}` : 'https://book.douban.com/'
}

export function parseDoubanSearch(html: string): DiscoveryResult[] {
  if (Buffer.byteLength(html) > limit) throw new Error('豆瓣搜索页面超过读取上限。')
  const document = parseDocument(html)
  const elements = DomUtils.getElementsByTagName('*', document.children)
  const blocks = elements.filter((element) => element.attribs.class?.split(/\s+/).includes('result'))
  const books = new Map<string, DiscoveryResult>()
  for (const block of blocks) {
    const children = DomUtils.getElementsByTagName('*', block.children)
    const heading = children.find((element) => element.name === 'h3')
    const anchor = heading && DomUtils.getElementsByTagName('a', heading.children).find((element) => doubanSubject(element.attribs.href ?? ''))
    if (!anchor) continue
    const url = doubanSubject(anchor.attribs.href)!, title = DomUtils.textContent(anchor).replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!title) continue
    const cast = children.find((element) => element.attribs.class?.split(/\s+/).includes('subject-cast'))
    const edition = cast ? DomUtils.textContent(cast).replace(/\s+/g, ' ').trim().slice(0, 500) : ''
    const ratingElement = children.find((element) => element.attribs.class?.split(/\s+/).includes('rating_nums'))
    const rating = ratingElement ? Number(DomUtils.textContent(ratingElement)) : undefined
    const image = children.find((element) => element.name === 'img')?.attribs.src
    let cover: string | undefined
    try { const value = new URL(image ?? ''); if (value.protocol === 'https:' && /(^|\.)doubanio\.com$/.test(value.hostname)) cover = value.href } catch {}
    const id = url.match(/\/subject\/(\d+)\//)![1]
    books.set(id, { id: `douban:${id}`, title, author: edition.split('/')[0].trim(), source: 'douban', doubanUrl: url, edition, rating: rating !== undefined && Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : undefined, cover })
    if (books.size >= 20) break
  }
  const pageTitle = DomUtils.getElementsByTagName('title', document.children).map((element) => DomUtils.textContent(element)).join(' ')
  if (!books.size && (/检测到有异常请求|访问豆瓣的方式有点像机器人|访问过于频繁/.test(DomUtils.textContent(document)) || /登录|验证/.test(pageTitle))) throw new Error('豆瓣需要登录或验证，请在应用内打开豆瓣完成后重试。')
  return [...books.values()]
}

export class DoubanCatalog {
  private cache = new Map<string, { at: number; books: DiscoveryResult[] }>()
  constructor(private fetchPage: typeof fetch = fetch) {}
  async search(query: string) {
    const value = query.trim()
    if (!value || value.length > 300) throw new Error('请输入书名、作者或 ISBN。')
    const key = value.normalize('NFKC').toLocaleLowerCase(), cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.books
    let target = doubanTarget(value)
    const signal = AbortSignal.timeout(12000)
    for (let redirect = 0; redirect < 5; redirect++) {
      const response = await this.fetchPage(target, { signal, redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error('豆瓣搜索返回无效跳转。')
        const url = new URL(location, target)
        if (url.protocol !== 'https:' || !/(^|\.)douban\.com$/.test(url.hostname)) throw new Error('豆瓣搜索跳转到了不支持的网站。')
        target = url.href
        continue
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('豆瓣搜索暂不可用，请在应用内打开豆瓣检查登录或验证。') }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('豆瓣搜索页面超过读取上限。') }
      if (!response.body) throw new Error('豆瓣搜索返回空页面。')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > limit) throw new Error('豆瓣搜索页面超过读取上限。')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      const books = parseDoubanSearch(Buffer.concat(chunks).toString('utf8'))
      if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: Date.now(), books })
      return books
    }
    throw new Error('豆瓣搜索跳转次数过多。')
  }
}
