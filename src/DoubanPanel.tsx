import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, LoaderCircle } from 'lucide-react'
import type { DoubanPageState } from './shared'

export default function DoubanPanel({ query, subject, onClose, onDownload }: { query?: string; subject?: string; onClose: () => void; onDownload?: (title: string) => void }) {
  const [page, setPage] = useState<DoubanPageState>({ loading: true, readingMode: true, adapted: false, title: query || '豆瓣图书' })
  const [error, setError] = useState('')
  const subjectPage = /^https:\/\/book\.douban\.com\/subject\/\d+\//.test(page.url ?? '')
  const downloadTitle = subjectPage ? page.title?.replace(/\s*[（(]豆瓣[)）]\s*$/, '').trim() : query
  const space = useRef<HTMLDivElement>(null)
  const retry = () => {
    setError('')
    setPage(value => ({ ...value, loading: true, error: undefined }))
    void window.kindlespouse.openDouban(query, subject).catch(() => setPage(value => ({ ...value, loading: false, error: '豆瓣页面暂时无法打开，请重试。' })))
  }
  useEffect(() => {
    let current = true
    const unsubscribe = window.kindlespouse.subscribeDouban(next => { if (current) setPage(next) })
    void window.kindlespouse.openDouban(query, subject).catch(() => {
      if (current) setPage(value => ({ ...value, loading: false, error: '豆瓣页面暂时无法打开，请重试。' }))
    })
    return () => { current = false; unsubscribe(); void window.kindlespouse.closeDouban().catch(() => {}) }
  }, [query, subject])
  useEffect(() => {
    const element = space.current
    if (!element) return
    const position = () => {
      const bounds = element.getBoundingClientRect()
      void window.kindlespouse.positionDouban({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) }).catch(() => {})
    }
    const observer = new ResizeObserver(position)
    observer.observe(element)
    position()
    window.addEventListener('scroll', position, true)
    return () => { observer.disconnect(); window.removeEventListener('scroll', position, true) }
  }, [])
  const action = (task: () => Promise<void>) => {
    setError('')
    void task().catch(() => setError('操作暂时未完成，请重试。'))
  }
  return <section className="douban-panel" aria-label="豆瓣阅读区">
    <header className="douban-panel-header">
      <div className="douban-navigation">
        <button className="text-button douban-back" onClick={onClose}><ArrowLeft size={15} />返回搜索</button>
        <div className="douban-page-tools">
          {onDownload && <button className="text-button" disabled={!downloadTitle} onClick={() => { if (downloadTitle) onDownload(downloadTitle) }}><Download size={13} /><span>查找下载</span></button>}
          <button className="text-button" disabled={page.loading || Boolean(page.error)} onClick={() => action(() => window.kindlespouse.setDoubanReading(!page.readingMode))}>{page.readingMode ? '原网页' : '阅读模式'}</button>
          <button className="text-button" disabled={page.loading || Boolean(page.error)} onClick={() => action(() => window.kindlespouse.openDoubanExternal())}><ExternalLink size={13} /><span>浏览器打开</span></button>
        </div>
      </div>
      <div className="douban-page-heading"><h2 title={page.title}>{page.title}</h2><span>豆瓣 · {page.adapted ? '阅读模式' : page.loading ? '正在载入' : '原网页'}</span></div>
      {error && <p className="douban-action-error" role="status">{error}</p>}
    </header>
    <div ref={space} className="douban-browser-space" aria-label="应用内豆瓣阅读区" aria-busy={page.loading}>
      {page.loading && <div className="douban-loading"><LoaderCircle className="spin" size={19} /><span>正在打开豆瓣</span></div>}
      {page.error && <div className="empty-state"><p>{page.error}</p><button className="button" onClick={retry}>重新打开豆瓣</button></div>}
    </div>
  </section>
}
