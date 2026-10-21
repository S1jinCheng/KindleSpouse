import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Cloud, Grid2X2, List, MoreHorizontal, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { AppState, Candidate } from './shared'
import { Empty, type Run } from './ui'
import BookArtwork from './BookArtwork'
import { isKoreaderFormat } from './book-formats'
import { emptyLibraryFilters, filterLibrary, libraryAuthors, libraryGroupKey, parseLibraryFilters } from './library-filters'
const progressOf = (book: Candidate) => book.deviceProgress ?? book.progress
const progressLabel = (book: Candidate) => Math.round(progressOf(book) * 100) < 1 ? '刚开始阅读' : `已读 ${Math.round(progressOf(book) * 100)}%`
const groupOf = libraryGroupKey

export default function LibraryPanel({
  state,
  run,
  onOpen,
  onImport,
  tools,
}: {
  state: AppState
  run: Run
  onOpen: (id: string) => void
  onImport: () => void
  tools?: ReactNode
}) {
  const [filters, setFilters] = useState(() => { try { return parseLibraryFilters(localStorage.getItem('library-filters-v1')) } catch { return { ...emptyLibraryFilters } } })
  const { query, shelf: filter, format, author: authorFilter, source } = filters
  const changeFilter = (key: keyof typeof filters, value: string) => { setFilters(current => ({ ...current, [key]: value })); setSelected([]) }
  const clearFilters = () => { setFilters({ ...emptyLibraryFilters }); setSelected([]) }
  const filtering = Boolean(query || filter !== '全部' || format || authorFilter || source)
  const [list, setList] = useState(false)
  const [sort, setSort] = useState('最近添加')
  const [editing, setEditing] = useState<Candidate>()
  const [title, setTitle] = useState(''),
    [author, setAuthor] = useState(''),
    [collection, setCollection] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => { try { localStorage.setItem('library-filters-v1', JSON.stringify(filters)) } catch {} }, [filters])
  const formats = [...new Set(state.candidates.map(book => book.format))].sort()
  const authors = [...new Map(state.candidates.flatMap(book => libraryAuthors(book.author)).map(author => [author.value, author])).values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  const sources = [...new Set(state.candidates.map(book => book.source))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const matching = useMemo(() => filterLibrary(state.candidates, filters), [state.candidates, filters])
  const collections = [
    ...new Set(state.candidates.map((book) => book.collection).filter((value): value is string => Boolean(value))),
  ].filter((value) => !['全部', '正在读', '已读', '文章'].includes(value))
  const groups = useMemo(() => {
    const result = new Map<string, Candidate[]>()
    for (const book of matching) {
      const key = groupOf(book)
      result.set(key, [...(result.get(key) ?? []), book])
    }
    return [...result.values()].sort((a, b) =>
      sort === '书名'
        ? a[0].title.localeCompare(b[0].title, 'zh-CN')
        : sort === '作者'
          ? a[0].author.localeCompare(b[0].author, 'zh-CN')
          : b[0].createdAt.localeCompare(a[0].createdAt),
    )
  }, [matching, sort])
  const continuing = groups
    .map(versions => versions.find(book => progressOf(book) > 0 && isKoreaderFormat(book.format)) ?? versions.find(book => isKoreaderFormat(book.format)))
    .filter((book): book is Candidate => Boolean(book && progressOf(book) > 0 && progressOf(book) < 0.98 && !book.finished))
    .slice(0, 3)
  const editingVersions = editing ? state.candidates.filter(book => groupOf(book) === groupOf(editing)) : []
  const cloud = state.clouds.find(account => account.id === state.settings.defaultCloudId) ?? state.clouds.find(account => account.connected)
  const sync = state.libraryCloudSync
  const edit = (book: Candidate) => {
    setEditing(book)
    setTitle(book.title)
    setAuthor(book.author)
    setCollection(book.collection ?? '')
  }
  return (
    <div className="library-page">
      <header className="page-heading">
        <div>
          <h1>书库</h1>
          <p>{groups.length} 本图书{matching.length !== groups.length && ` · ${matching.length} 个文件版本`}</p>
        </div>
        <div className="library-heading-actions">
          <div className="library-search">
            <Search size={17} />
            <input aria-label="搜索本机书库" placeholder="搜索书名或作者" value={query} onChange={event => changeFilter('query', event.target.value)} />
            {query && <button className="icon-button" aria-label="清空书库搜索" onClick={() => changeFilter('query', '')}><X size={14} /></button>}
          </div>
          {tools}
          {state.settings.kindleMode !== 'native' && <button className="text-button" disabled={!cloud?.connected || sync?.working} title="将整个书库上传到 Kindle 专用网盘目录；保留原件，跳过已排队文件" onClick={() => { if (cloud) run(async () => { await window.kindlespouse.syncLibraryToCloud(cloud.id) }) }}><Cloud size={16} />{sync?.working ? `准备中 ${sync.prepared}/${sync.total}` : '同步整库到网盘'}</button>}
          <button className="button library-add" aria-label="导入书籍" onClick={onImport}><Plus size={16} />添加图书</button>
        </div>
      </header>
      {!filtering && continuing.length > 0 && <section className="continue-section" aria-label="继续阅读">
        <h2>继续阅读</h2>
        <div className="continue-books">{continuing.map(book => <button className="continue-book" key={book.id} onClick={() => onOpen(book.id)} aria-label={`继续阅读 ${book.title}`}>
          <div className="continue-artwork"><BookArtwork {...book} identity={book.sha256} /></div>
          <span className="continue-description"><strong>{book.title}</strong><span>{book.author}</span><span className="continue-progress">{progressLabel(book)}<ChevronRight size={13} /></span></span>
        </button>)}</div>
      </section>}
      <div className="shelf-toolbar">
        <div className="filter-pills" aria-label="书库分类">
          {['全部', '正在读', '已读', '文章', ...collections].map((value) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => {
                changeFilter('shelf', value)
              }}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="button-group">
          <button className="icon-button" aria-label="恢复书库索引" title="从已有备份恢复索引" disabled={state.recovery?.working} onClick={() => run(() => window.kindlespouse.recoverLibrary(), '书库已恢复')}><RefreshCw size={16} className={state.recovery?.working ? 'spin' : ''} /></button>
          <select aria-label="书库排序" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option>最近添加</option>
            <option>书名</option>
            <option>作者</option>
          </select>
          <button
            className="icon-button"
            aria-label={list ? '切换封面网格' : '切换书籍列表'}
            onClick={() => setList(!list)}
          >
            {list ? <Grid2X2 size={18} /> : <List size={18} />}
          </button>
        </div>
      </div>
      <div className="library-filters" role="group" aria-label="书库筛选">
        <label><span>格式</span><select aria-label="按格式筛选" value={format} onChange={event => changeFilter('format', event.target.value)}><option value="">全部格式</option>{format && !formats.includes(format as Candidate['format']) && <option value={format}>{format.toUpperCase()}</option>}{formats.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
        <label><span>作者</span><select aria-label="按作者筛选" value={authorFilter} onChange={event => changeFilter('author', event.target.value)}><option value="">全部作者</option>{authorFilter && !authors.some(author => author.value === authorFilter) && <option value={authorFilter}>已保存的作者</option>}{authors.map(author => <option key={author.value} value={author.value}>{author.label}</option>)}</select></label>
        <label><span>来源</span><select aria-label="按来源筛选" value={source} onChange={event => changeFilter('source', event.target.value)}><option value="">全部来源</option>{source && !sources.includes(source) && <option value={source}>{source}</option>}{sources.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        {filtering && <button className="text-button clear-library-filters" onClick={clearFilters}><X size={13} />清除筛选</button>}
      </div>
      {state.recovery?.working && <p className="status-line">正在从已有备份恢复书库…</p>}
      {state.recovery?.error && <p className="error-text">{state.recovery.error}</p>}
      {sync && <div className="library-cloud-sync" role="status">
        <p className="status-line">{sync.working ? `正在准备 ${sync.prepared}/${sync.total} · ${sync.currentTitle ?? ''}` : `${sync.error ? '书库准备未完成' : '书库准备完成'} · ${sync.queued} 个加入传输队列 · ${sync.skipped} 个已有任务`}。上传与 Kindle 收书进度见右上角传输记录。</p>
        {sync.error && <p className="error-text">{sync.error}</p>}
        {sync.failures.length > 0 && <details><summary>{sync.failures.length} 个文件未加入同步</summary>{sync.failures.map(item => <p className="status-line" key={item.candidateId}>{item.title}：{item.error}</p>)}</details>}
      </div>}
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>已选择 {selected.length} 本</span>
          <input
            aria-label="批量书集名称"
            placeholder="书集名称"
            value={collection}
            onChange={(event) => setCollection(event.target.value)}
          />
          <button
            className="button"
            onClick={() =>
              run(async () => {
                for (const id of selected) await window.kindlespouse.updateBook(id, { collection })
                setSelected([])
              }, '书集已更新')
            }
          >
            加入书集
          </button>
          <button
            className="button"
            onClick={() =>
              run(async () => {
                for (const id of selected) await window.kindlespouse.updateBook(id, { finished: true })
                setSelected([])
              })
            }
          >
            标为已读
          </button>
          <button className="icon-button" aria-label="取消选择" onClick={() => setSelected([])}>
            <X size={16} />
          </button>
        </div>
      )}
      {groups.length ? (
        <div className={list ? 'books-list' : 'books-grid'}>
          {groups.map((versions) => {
            const book =
              versions.find((value) => value.format === 'epub') ??
              versions.find((value) => value.format === 'pdf') ??
              versions[0]
            return (
              <article className="shelf-book" key={book.id}>
                <div className="cover-wrap">
                  <button className="cover-button" aria-label={`阅读 ${book.title}`} onClick={() => onOpen(book.id)}>
                    <BookArtwork {...book} identity={book.sha256} />
                  </button>
                  <input
                    type="checkbox"
                    className="book-select"
                    aria-label={`选择 ${book.title}`}
                    checked={selected.includes(book.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, ...versions.map((value) => value.id)].filter(
                              (value, index, array) => array.indexOf(value) === index,
                            )
                          : current.filter((id) => !versions.some((value) => value.id === id)),
                      )
                    }
                  />
                </div>
                <div className="shelf-book-details">
                  <button className="shelf-title" onClick={() => onOpen(book.id)}>
                    {book.title}
                  </button>
                  <p>{book.author}</p>
                  <div className="book-caption-row"><span>{book.finished || progressOf(book) >= 0.98 ? <><Check size={12} />已读完</> : progressOf(book) > 0 ? progressLabel(book) : book.isSample ? '试读版' : versions.length > 1 ? `${versions.length} 个版本` : book.format.toUpperCase()}</span>
                    <button className="book-menu icon-button" aria-label={`整理 ${book.title}`} onClick={() => edit(book)}><MoreHorizontal size={18} /></button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : (
        <Empty title={filtering ? '没有符合条件的书籍' : '书库还没有书籍'}>{filtering ? '可以调整格式、作者或来源，或清除筛选查看全部书籍。' : '可以导入本地书籍，或恢复已有设备备份。'}</Empty>
      )}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(undefined)}>
          <form
            className="confirm-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              run(async () => {
                await window.kindlespouse.updateBook(editing.id, { title, author, collection })
                setEditing(undefined)
              }, '书籍资料已保存')
            }}
          >
            <h2>整理书籍</h2>
            <div className="book-storage-summary"><span>{editing.format.toUpperCase()}</span><span>本机</span>{state.jobs.some(job => job.candidateId === editing.id && job.verifiedAt) && <span><Cloud size={13} />网盘已校验</span>}{editing.fromDevice || state.jobs.some(job => job.candidateId === editing.id && job.deviceReceivedAt) ? <span>已在 Kindle</span> : null}</div>
            {editingVersions.length > 1 && <label>打开其他版本<select aria-label={`${editing.title}的版本`} value={editing.id} onChange={event => { setEditing(undefined); onOpen(event.target.value) }}>{editingVersions.map(book => <option key={book.id} value={book.id}>{book.format.toUpperCase()} · {book.source}</option>)}</select></label>}
            <label>
              书名
              <input aria-label="修改书名" value={title} onChange={(event) => setTitle(event.target.value)} required />
            </label>
            <label>
              作者
              <input aria-label="修改作者" value={author} onChange={(event) => setAuthor(event.target.value)} />
            </label>
            <label>
              书集
              <input
                aria-label="书集名称"
                value={collection}
                onChange={(event) => setCollection(event.target.value)}
                list="collection-options"
              />
              <datalist id="collection-options">
                {['文章', ...collections].map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </label>
            <div className="modal-actions">
              <button className="button" type="button" onClick={() => setEditing(undefined)}>
                取消
              </button>
              <button className="button primary" type="submit">
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
