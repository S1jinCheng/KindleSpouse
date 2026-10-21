import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export async function doubanFontCss(frontend: string) {
  const styles = (await readdir(path.join(frontend, 'assets'))).filter(name => name.endsWith('.css'))
  const css = (await Promise.all(styles.map(name => readFile(path.join(frontend, 'assets', name), 'utf8')))).join('\n')
  return (css.match(/@font-face\s*\{[^}]*\}/g) ?? []).filter(rule => /Noto Sans SC Variable|Noto Serif SC/.test(rule))
    .map(rule => rule.replace(/url\(([^)]+)\)/g, (match, value: string) => {
      const filename = value.replace(/^["']|["']$/g, '')
      if (!/^(?:data:|https?:)/.test(filename)) return `url("${new URL(filename, 'kindlespouse://app/assets/index.css').href}")`
      return match
    })).join('\n')
}

export function prepareDoubanReadingDocument(enabled = true) {
  const root = document.documentElement
  delete root.dataset.ksDouban
  const url = new URL(location.href)
  const content = document.querySelector('#content .article')
  const kind = url.hostname === 'book.douban.com' && /^\/subject\/\d+\/(?:reviews|comments)?\/?$/.test(url.pathname) ? 'subject'
    : url.hostname === 'book.douban.com' && /^\/review\/\d+\/?$/.test(url.pathname) ? 'review'
    : url.hostname === 'www.douban.com' && url.pathname === '/search' ? 'search' : undefined
  const recognized = Boolean(kind && content && !document.querySelector('input[type="password"], #captcha_image, .captcha_image, #captcha, .account-form'))
  if (enabled && recognized) {
    root.dataset.ksDouban = kind
  }
  return { adapted: enabled && recognized, title: document.title.replace(/\s*[（(]豆瓣[)）]\s*$/, '').trim(), url: location.href }
}

export const doubanReadingCss = `
html[data-ks-douban] {
  --ks-paper: #faf9f6;
  --ks-ink: #2d2b26;
  --ks-secondary: #6c6961;
  --ks-tertiary: #88837a;
  --ks-accent: #9c5035;
  --ks-line: #e5e2da;
  background: var(--ks-paper) !important;
  color-scheme: light;
  scrollbar-color: #c6bfb2 var(--ks-paper);
  scrollbar-width: thin;
}
html[data-ks-douban] body {
  width: auto !important;
  max-width: 100% !important;
  min-width: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  background: var(--ks-paper) !important;
  color: var(--ks-ink) !important;
  font-family: 'Noto Sans SC Variable', 'Microsoft YaHei UI', sans-serif !important;
  font-size: 15px !important;
  line-height: 1.85 !important;
  overflow-wrap: anywhere;
}
html[data-ks-douban] #wrapper {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 760px !important;
  min-width: 0 !important;
  margin: 0 auto !important;
  padding: 8px 20px 44px 0 !important;
}
html[data-ks-douban] :is(#content, .grid-16-8, .article, .indent, .subjectwrap, .subject, .related_info, #comments-section, #reviews-wrapper, .review-list, .review-item, .review-item .main-bd, .review-detail, .review-content, .search-result, .result-list) {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  float: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  background-color: transparent !important;
}
html[data-ks-douban] :is(#db-global-nav, #db-nav-book, #db-nav-sns, #footer, .aside, #dale_book_subject_top_full, [id^="dale_"], .ad-placeholder, .advertisement, .top-nav, .nav-wrap, .nav-secondary, .rec-sec, #rec-ebook-section, #db-rec-section, #db-tags-section, .subject-others-interests-ft, .buyinfo, .gray_ad, .mobile-app-entrance, .download-app, #db-usr-profile, #interest_sect_level, .interest_btns) { display: none !important; }
html[data-ks-douban="subject"] #wrapper > :is(h1, h2.subtitle) { display: none !important; }
html[data-ks-douban] :is(h1, h2, h3) {
  color: var(--ks-ink) !important;
  font-family: 'Noto Serif SC', 'Songti SC', SimSun, serif !important;
  font-weight: 400 !important;
  line-height: 1.65 !important;
  background: none !important;
  height: auto !important;
  overflow-wrap: anywhere;
}
html[data-ks-douban] h1 { font-size: 25px !important; margin: 0 0 24px !important; padding: 0 !important; }
html[data-ks-douban] h2 { font-size: 19px !important; margin: 26px 0 16px !important; padding: 0 !important; }
html[data-ks-douban] h3 { font-size: 17px !important; }
html[data-ks-douban] .related_info > h2:has(> span) { font-size: 0 !important; }
html[data-ks-douban] .related_info > h2:has(> span) > :is(span, a) { font-size: 19px !important; }
html[data-ks-douban] #reviews-wrapper > header h2 { font-size: 0 !important; }
html[data-ks-douban] #reviews-wrapper > header h2::before { content: '书评'; font-size: 19px; }
html[data-ks-douban] #reviews-wrapper > header h2 > .pl { font-size: 12px !important; margin-left: 10px; }
html[data-ks-douban] #reviews-wrapper > header .create-review { font-size: 12px !important; }
html[data-ks-douban] :is(a, a:visited) { color: var(--ks-accent) !important; background: none !important; text-decoration: none !important; }
html[data-ks-douban] a:hover { color: var(--ks-ink) !important; text-decoration: underline !important; }
html[data-ks-douban] a:focus-visible { outline: 2px solid var(--ks-accent) !important; outline-offset: 3px; }
html[data-ks-douban] :is(h1, h2, h3) a { color: var(--ks-ink) !important; }
html[data-ks-douban] .review-item h2 :is(a, a:visited) { color: var(--ks-ink) !important; }
html[data-ks-douban] :is(.intro, .short-content, .review-content, .full-content, .comment-content) {
  color: var(--ks-ink) !important;
  font-family: 'Noto Sans SC Variable', 'Microsoft YaHei UI', sans-serif !important;
  font-size: 15px !important;
  line-height: 1.9 !important;
  overflow-wrap: anywhere !important;
  white-space: normal;
}
html[data-ks-douban] :is(p, pre, blockquote, table, td) { max-width: 100% !important; box-sizing: border-box; }
html[data-ks-douban] pre { white-space: pre-wrap !important; overflow-wrap: anywhere; }
html[data-ks-douban] img { max-width: 100% !important; height: auto; }
html[data-ks-douban] :is(.intro p, .review-content p, .full-content p) { margin: 0 0 1em !important; }
html[data-ks-douban] :is(.indent, .review-list) { margin-left: 0 !important; margin-bottom: 26px !important; }
html[data-ks-douban] :is(.pl, .pl2, .main-meta, .comment-time, .pubtime, .review-meta, .rating_sum) { color: var(--ks-tertiary) !important; font-size: 12px !important; }
html[data-ks-douban] #mainpic { width: 96px !important; margin: 0 20px 20px 0 !important; float: left !important; }
html[data-ks-douban] #mainpic img { max-height: 148px !important; width: auto !important; }
html[data-ks-douban] #info { float: none !important; width: auto !important; min-width: 0 !important; margin-left: 116px !important; font-size: 13px !important; line-height: 1.9 !important; word-break: normal !important; }
html[data-ks-douban] #interest_sectl { clear: both !important; float: none !important; width: 100% !important; margin: 22px 0 !important; padding: 18px 0 !important; border: 0 !important; border-top: 1px solid var(--ks-line) !important; border-bottom: 1px solid var(--ks-line) !important; }
html[data-ks-douban] .rating_num { color: var(--ks-ink) !important; font-family: 'Noto Serif SC', serif !important; font-weight: 400 !important; }
html[data-ks-douban] .power { background: #bd8c68 !important; }
html[data-ks-douban] :is(.rating_logo, .rating_per, .starstop) { color: var(--ks-secondary) !important; }
html[data-ks-douban] .review-item { padding: 25px 0 !important; border: 0 !important; border-bottom: 1px solid var(--ks-line) !important; }
html[data-ks-douban] .review-item .main-hd { display: flex !important; align-items: center !important; flex-wrap: wrap !important; gap: 6px 9px !important; height: auto !important; line-height: 1.6 !important; margin-bottom: 12px !important; }
html[data-ks-douban] .review-item .main-hd :is(a, span) { margin: 0 !important; float: none !important; }
html[data-ks-douban] .review-item .main-hd .name { color: var(--ks-secondary) !important; font-size: 12px !important; }
html[data-ks-douban] .review-item .avator img { width: 24px !important; height: 24px !important; border-radius: 50% !important; }
html[data-ks-douban] .review-item h2 { margin: 0 0 12px !important; font-size: 18px !important; }
html[data-ks-douban] .review-item .action { display: flex !important; width: 100% !important; max-width: 100% !important; flex-wrap: wrap !important; align-items: center !important; gap: 14px !important; margin-top: 14px !important; color: var(--ks-tertiary) !important; font-size: 12px !important; }
html[data-ks-douban] .review-item .action a { background: transparent !important; border: 0 !important; color: var(--ks-tertiary) !important; font-size: 12px !important; padding: 0 !important; }
html[data-ks-douban] :is(.main-title-rating, [class^="allstar"], [class^="bigstar"]) { filter: saturate(.45); flex-shrink: 0; }
html[data-ks-douban] :is(.comment-item, .result) { border-color: var(--ks-line) !important; padding: 22px 0 !important; }
html[data-ks-douban] .comment-item .comment { min-width: 0 !important; }
html[data-ks-douban] .result .content { width: auto !important; min-width: 0 !important; }
html[data-ks-douban="search"] :is(.search-cate, .mod-search, .back-to-top, #content > h1) { display: none !important; }
html[data-ks-douban="search"] :is(.article, .result-list) { padding: 0 !important; }
html[data-ks-douban="search"] :is(.search-result, .result-list) { display: block !important; clear: both !important; }
html[data-ks-douban="search"] .result-list { margin: 0 !important; }
html[data-ks-douban="search"] .result {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) 64px !important;
  align-items: start !important;
  gap: 20px !important;
  box-sizing: border-box !important;
  width: 100% !important;
  margin: 0 !important;
  border: 0 !important;
  border-bottom: 1px solid var(--ks-line) !important;
  position: static !important;
}
html[data-ks-douban="search"] .result > .pic { grid-column: 2; grid-row: 1; width: 64px !important; max-width: 100% !important; float: none !important; position: static !important; margin: 0 !important; }
html[data-ks-douban="search"] .result > .content { grid-column: 1; grid-row: 1; max-width: 100% !important; float: none !important; margin: 0 !important; padding: 0 !important; }
html[data-ks-douban="search"] .result h3 { margin: 0 0 8px !important; }
html[data-ks-douban] .col2-list { display: grid !important; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 10px 20px; width: 100% !important; max-width: 100% !important; box-sizing: border-box; padding: 0 !important; }
html[data-ks-douban] .col2-list > li { float: none !important; width: auto !important; min-width: 0 !important; margin: 0 !important; }
html[data-ks-douban] :is(.paginator, .review-filter, .review_filter) { width: auto !important; display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 6px; font-size: 13px !important; }
html[data-ks-douban] .paginator { justify-content: center; margin-top: 26px !important; }
html[data-ks-douban] :is(.review-filter, .review_filter) { margin-bottom: 16px !important; }
html[data-ks-douban] :is(.hidden, .hide, [hidden]) { display: none !important; }
html[data-ks-douban] ::selection { background: #e8d9c7; color: var(--ks-ink); }
`
