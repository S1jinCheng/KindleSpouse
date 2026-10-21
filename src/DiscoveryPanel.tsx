import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, BookOpen, ChevronDown, ChevronRight, LoaderCircle, Search } from 'lucide-react'
import type { AppState, Candidate, DiscoveryResult } from './shared'
import { Empty, type Run } from './ui'
import { SourceAccountStatus } from './SourceStatus'
import BookArtwork from './BookArtwork'
import DiscoveryAction, { discoveryFile } from './DiscoveryAction'

export default function DiscoveryPanel({
  state,
  run,
  onOpen,
  onDouban,
  downloadSearch,
  reviewed,
  onDownload,
}: {
  state: AppState
  run: Run
  onOpen: (id: string) => void
  onDouban: (query?: string, subject?: string, author?: string) => void
  downloadSearch?: { id: number; title: string; author?: string }
  reviewed: string[]
  onDownload: (book: Candidate) => Promise<void>
}) {
  const [query, setQuery] = useState(''),
    [url, setUrl] = useState('')
  const [results, setResults] = useState<DiscoveryResult[]>([]),
    [warnings, setWarnings] = useState<string[]>([])
  const [pending, setPending] = useState<string[]>([])
  const [searched, setSearched] = useState(false)
  const [working, setWorking] = useState<Record<string, 'preview' | 'download'>>({})
  const locks = useRef(new Set<string>())
  const request = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const searching = pending.length > 0
  const [filter, setFilter] = useState('全部')
  const wasConnected = useRef(state.sourceConnected)
  const local = state.candidates.filter((book) => `${book.title} ${book.author} ${book.isbn ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const recent = filter === 'local' ? local : local.slice(0, 8)
  const shown: DiscoveryResult[] = [...(filter === '全部' || filter === 'local' ? local.map(book => ({ id: `local:${book.id}`, source: 'local' as const, bookId: book.id, title: book.title, author: book.author, format: book.format, cover: book.cover })) : []), ...results.filter(result => result.source !== 'local' && (filter === '全部' || filter === 'files' && ['cloud', 'zlib'].includes(result.source) || result.source === filter))]
  const emptyFilter = filter === 'douban' ? ['搜索豆瓣书目', '输入书名、作者或 ISBN，查看豆瓣的版本信息、评分与书评。'] : filter === 'files' ? ['搜索可下载版本', '输入书名或作者，查找书源和网盘里的书籍文件。'] : filter === 'cloud' ? ['搜索网盘书籍', '输入书名，查找 Kindle 专用网盘目录里的书籍。'] : ['搜索书源', '输入书名或作者，查找已登录书源中的下载版本。']
  const search = (value = query, targetFilter = filter, selected?: DiscoveryResult) => {
    const ticket = ++request.current
    const scopes: ('catalog' | 'source' | 'cloud')[] = targetFilter === 'local' ? [] : targetFilter === 'douban' ? ['catalog'] : targetFilter === 'files' ? ['source', 'cloud'] : targetFilter === 'zlib' ? ['source'] : targetFilter === 'cloud' ? ['cloud'] : ['catalog', 'source', 'cloud']
    setQuery(value)
    setWarnings([])
    setResults(selected ? [selected] : [])
    setSearched(true)
    setPending(scopes)
    run(async () => {
      await Promise.allSettled(scopes.map(async (scope) => {
        try {
          const result = await window.kindlespouse.searchDiscovery(value, scope)
          if (ticket !== request.current) return
          setResults((previous) => [...new Map([...previous, ...result.results].map((book) => [book.id, book])).values()])
          setWarnings((previous) => [...new Set([...previous, ...result.warnings])])
        } catch {
          if (ticket === request.current) setWarnings((previous) => [...previous, scope === 'catalog' ? '书目搜索暂不可用，可以在应用内打开豆瓣重试。' : '书籍文件搜索暂不可用，请检查书源登录或网盘连接。'])
        } finally {
          if (ticket === request.current) setPending((previous) => previous.filter((item) => item !== scope))
        }
      }))
    })
  }
  const selectFilter = (value: string) => {
    setFilter(value)
    if (query.trim()) search(query, value)
    else { request.current++; setPending([]); setResults([]); setWarnings([]); setSearched(false); input.current?.focus() }
  }
  const operate = (id: string, kind: 'preview' | 'download', operation: () => Promise<void>) => {
    if (locks.current.has(id)) return
    locks.current.add(id)
    setWorking(previous => ({ ...previous, [id]: kind }))
    run(async () => {
      try { await operation() }
      finally { locks.current.delete(id); setWorking(previous => { const next = { ...previous }; delete next[id]; return next }) }
    })
  }
  const action = (book: DiscoveryResult) => <DiscoveryAction result={book} state={state} reviewed={reviewed} working={working[book.id]} onPreview={() => operate(book.id, 'preview', async () => {
    const cached = discoveryFile(book, state)
    if (cached) { onOpen(cached.id); return }
    if (book.sourceBook) onOpen(await window.kindlespouse.downloadSource(book.sourceBook.id, book.sourceBook.hash))
    else if (book.cloudId && book.remotePath) onOpen(await window.kindlespouse.downloadCloud(book.cloudId, book.remotePath))
  })} onDownload={candidate => operate(book.id, 'download', () => onDownload(candidate))} onRetry={id => operate(book.id, 'download', () => window.kindlespouse.retry(id))} />
  useEffect(() => {
    if (!downloadSearch) return
    const author = downloadSearch.author?.trim()
    const query = [downloadSearch.title, author && !/^(?:unknown|未知|作者信息未提供|佚名)$/i.test(author) ? author : ''].filter(Boolean).join(' ')
    setFilter('files')
    search(query, 'files')
  }, [downloadSearch?.id])
  useEffect(() => {
    const connected = state.sourceConnected && !wasConnected.current
    wasConnected.current = state.sourceConnected
    if (connected && searched && query.trim()) search(query)
  }, [state.sourceConnected])
  return (
    <div className="discovery-panel">
      <form
        className="unified-search"
        onSubmit={(event) => {
          event.preventDefault()
          search()
        }}
      >
        <Search size={19} />
        <input
          ref={input}
          aria-label="统一搜索书籍"
          placeholder="书名、作者或 ISBN"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            request.current++
            setPending([])
            setResults([])
            setWarnings([])
            setSearched(false)
          }}
        />
        <button className="button primary" disabled={!query.trim()}>
          {searching ? <LoaderCircle size={17} className="spin" /> : '搜索'}
        </button>
      </form>
      <div className="discovery-services">
        <button className="douban-link" onClick={() => onDouban(query || undefined)}>
          <BookOpen size={15} />豆瓣书评<ChevronRight size={13} />
        </button>
        <details className="source-account-menu"><summary><i className={state.sourceConnected ? 'online-dot' : 'offline-dot'} />{state.sourceConnected ? '书源已登录' : '登录书源'}<ChevronDown size={13} /></summary><div className="source-account-popover">
          <SourceAccountStatus account={state.sourceAccount} onCheck={() => run(() => window.kindlespouse.checkSourceSession())} />
          <button className="button" onClick={() => run(() => window.kindlespouse.openSource())}>{state.sourceConnected ? '打开书源账号' : '在应用内登录'}</button>
          <p>豆瓣提供书目和书评，可下载版本来自书源与网盘。</p>
        </div></details>
      </div>
      <div className="filter-pills search-filters" role="group" aria-label="筛选搜书结果">
        {[
          ['全部', '全部'],
          ['douban', '豆瓣书目'],
          ['files', '可下载'],
          ['local', '本机'],
          ['cloud', '网盘'],
          ['zlib', '书源'],
        ].map(([value, label]) => (
          <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => selectFilter(value)}>
            {label}
          </button>
        ))}
      </div>
      {searching && searched && <p className="status-line"><LoaderCircle className="spin" size={14} />{pending.includes('catalog') ? '正在查找书目' : '正在查找可下载文件'}</p>}
      {warnings.map((warning) => (
        <p className="status-line" key={warning}>
          {warning}
        </p>
      ))}
      {!searched && !searching && !['全部', 'local'].includes(filter) && <Empty title={emptyFilter[0]}>{emptyFilter[1]}</Empty>}
      {!searched && !searching && ['全部', 'local'].includes(filter) && (
        <>
          <div className="section-heading">
            <h2>{query ? '本机匹配' : filter === 'local' ? '本机书籍' : '最近添加'}</h2>
            <small>{recent.length} 本</small>
          </div>
          <div className="discovery-results discovery-recents">{recent.length ? (
            recent.map((book) => (
              <article className="discovery-recent-row" key={book.id}><button className="discovery-local" onClick={() => onOpen(book.id)}>
                {book.cover ? <img src={book.cover} alt="" /> : <BookOpen size={24} />}
                <span>
                  <strong>{book.title}</strong>
                  <small>
                    {book.author} · {book.format.toUpperCase()}
                  </small>
                </span>
              </button>{action({ id: `local:${book.id}`, source: 'local', bookId: book.id, title: book.title, author: book.author, format: book.format })}</article>
            ))
          ) : (
            <Empty title="搜索下一本想读的书">本机、网盘和书源结果会显示在这里。</Empty>
          )}</div>
        </>
      )}
      {searched && (
        <><div className="search-results-heading"><h2>搜索结果</h2><span>{shown.length} 个结果{searching ? ' · 更新中' : ''}</span></div><div className="discovery-results">
          {shown.map((book) => (
            <article className="discovery-result" key={book.id}>
              <div className="result-artwork"><BookArtwork title={book.title} author={book.author} cover={book.cover} identity={book.id} format={book.format} /></div>
              <div>
                <button className="discovery-title" onClick={() => { const cached = discoveryFile(book, state); if (cached) onOpen(cached.id); else if (book.source === 'douban') onDouban(book.title, book.doubanUrl, book.author) }}><strong>{book.title}</strong></button>
                <p>{book.author}</p>
                <small>
                  {book.source === 'douban' ? `豆瓣 · ${book.rating !== undefined ? book.rating.toFixed(1) + ' 分' : '暂无评分'}` : `${book.source === 'local' ? '本机' : book.source === 'cloud' ? '网盘' : '书源'} · ${book.format?.toUpperCase() ?? ''}`}
                  {book.sourceBook?.language ? ` · ${book.sourceBook.language}` : ''}
                  {book.sourceBook?.size ? ` · ${book.sourceBook.size}` : ''}
                </small>
                {book.edition && <p className="discovery-edition">{book.edition}</p>}
              </div>
              {book.source === 'douban' ? <div className="discovery-book-actions">
                <button className="text-button" onClick={() => onDouban(book.title, book.doubanUrl, book.author)}>豆瓣详情</button>
                <button className="button" onClick={() => { setFilter('files'); search(book.title, 'files', book) }}>查找下载</button>
              </div> : action(book)}
            </article>
          ))}
          {!shown.length && !searching && <Empty title={filter === 'files' ? '未找到可下载文件' : '没有匹配结果'}>{filter === 'files' ? '请登录书源，或把 KOReader 支持的书籍放入网盘传书目录。豆瓣书目可以在应用内浏览。' : '可以更换关键词，或在应用内打开豆瓣查看。'}</Empty>}
        </div></>
      )}
      <details className="download-link">
        <summary>使用下载链接</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            run(async () => {
              await window.kindlespouse.download(url)
              setUrl('')
            })
          }}
        >
          <input
            aria-label="书籍下载链接"
            placeholder="MOBI、EPUB、PDF 等书籍下载地址"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button className="icon-button" aria-label="下载到试读区" disabled={!url.trim()}>
            <ArrowDownToLine size={19} />
          </button>
        </form>
      </details>
    </div>
  )
}
