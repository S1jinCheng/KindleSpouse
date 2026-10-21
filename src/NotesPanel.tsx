import { useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Cloud,
  Download,
  FileText,
  Highlighter,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Plus,
  Search,
  Usb,
  X,
} from 'lucide-react'
import Reader, { type ReaderHandle } from './Reader'
import type { AppState, Candidate } from './shared'
import { Empty, type Run } from './ui'

export default function NotesPanel({ state, run }: { state: AppState; run: Run }) {
  const [tab, setTab] = useState<'notebook' | 'annotation'>('notebook')
  const [classification, setClassification] = useState('notebook')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(localStorage.getItem('notebook-reading') ?? '')
  const [bookTitle, setBookTitle] = useState('')
  const [noteId, setNoteId] = useState('')
  const [ready, setReady] = useState(false),
    [locating, setLocating] = useState(false),
    [message, setMessage] = useState('')
  const [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState('')
  const [refreshingTitles, setRefreshingTitles] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState(false), [comment, setComment] = useState('')
  const reader = useRef<ReaderHandle>(null)
  const request = useRef(0)
  const lastLocated = useRef('')
  const groupKey = (note: AppState['readingNotes'][number]) => note.bookId ?? `${note.bookTitle}\u0000${note.author ?? ''}`
  const visibleNotes = state.readingNotes.filter(note => showArchived || !note.edit?.deleted && !note.origin?.deleted)
  const books = [...new Map(visibleNotes.map(note => [groupKey(note), note])).entries()]
  const notebooks = state.notebooks.filter(
    (book) =>
      (book.classification ?? 'unknown') === classification && book.title.toLowerCase().includes(query.toLowerCase()),
  )
  const notes = visibleNotes.filter(
    (note) =>
      (!bookTitle || groupKey(note) === bookTitle) &&
      `${note.bookTitle} ${note.text} ${note.edit?.note ?? note.note ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  )
  const selectedNotebook = state.notebooks.find((book) => book.id === selectedId)
  const selectedNote = state.readingNotes.find((note) => note.id === noteId)
  const selectedBook = selectedNote?.bookId
    ? state.candidates.find((book) => book.id === selectedNote.bookId)
    : undefined
  const candidate: Candidate | undefined =
    tab === 'notebook' && selectedNotebook && selectedNotebook.classification !== 'auxiliary'
      ? {
          id: selectedNotebook.id,
          title: selectedNotebook.title,
          author: '',
          format: 'pdf',
          filename: selectedNotebook.title + '.pdf',
          bytes: selectedNotebook.bytes,
          sha256: selectedNotebook.sha256,
          createdAt: selectedNotebook.importedAt,
          source: '笔记',
          chapters: selectedNotebook.pages ?? 0,
          warnings: [],
          library: true,
          progress: 0,
          location: selectedNotebook.location,
        }
      : selectedBook
  useEffect(() => {
    if (!notebooks.some((book) => book.id === selectedId))
      setSelectedId(notebooks.find((book) => book.status === 'ready')?.id ?? notebooks[0]?.id ?? '')
  }, [classification, state.notebooks, selectedId])
  useEffect(() => {
    if (selectedId) localStorage.setItem('notebook-reading', selectedId)
  }, [selectedId])
  useEffect(() => {
    setReady(false)
    setMessage('')
    lastLocated.current = ''
    request.current++
  }, [candidate?.id, tab])
  useEffect(() => {
    if (tab !== 'annotation' || !selectedNote || !selectedBook || !ready) return
    const key = `${selectedNote.id}:${selectedBook.id}`
    if (lastLocated.current === key) return
    lastLocated.current = key
    const current = ++request.current
    setLocating(true)
    setMessage('正在定位标注…')
    void reader.current
      ?.locate({
        ...selectedNote.anchor,
        format: selectedBook.format === 'pdf' ? 'pdf' : 'epub',
        quote: selectedNote.text || selectedNote.anchor?.quote,
        fileHash: selectedNote.bookHash,
      })
      .then((result) => {
        if (current === request.current) {
          setMessage(result.found ? '已定位标注' : (result.message ?? '未找到正文位置'))
          setLocating(false)
        }
      })
      .catch(() => {
        if (current === request.current) {
          setMessage('定位未完成，可检查书籍版本后重试。')
          setLocating(false)
        }
      })
  }, [tab, noteId, selectedBook?.id, ready])
  const cloud = state.settings.defaultCloudId ?? state.clouds[0]?.id
  const count = (value: string) => state.notebooks.filter((book) => (book.classification ?? 'unknown') === value).length
  return (
    <div className="notes-page">
      <header className="page-heading">
        <div>
          <h1>笔记与标注</h1>
          <p>
            {count('notebook')} 本笔记 · {state.readingNotes.length} 条标注
            {Boolean(state.notebookTitles?.total) && ` · 标题已识别 ${state.notebookTitles!.matched}/${state.notebookTitles!.total}`}
          </p>
        </div>
        <div className="button-group">
          <button hidden={state.settings.kindleMode === 'native'} className="button" disabled={refreshingTitles || state.sync.working}
            onClick={() => run(async () => {
              setRefreshingTitles(true)
              try { await window.kindlespouse.refreshNotebookTitles() }
              finally { setRefreshingTitles(false) }
            }, '标题索引已刷新')}>
            {refreshingTitles ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新标题
          </button>
          <button
            className="button"
            hidden={state.settings.kindleMode === 'native'}
            disabled={!cloud || state.sync.working}
            onClick={() => cloud && run(() => window.kindlespouse.syncCloud(cloud), '已从网盘更新笔记与标注')}
          >
            {state.sync.working ? <LoaderCircle className="spin" size={16} /> : <Cloud size={16} />}从网盘更新笔记
          </button>
          <button
            className="icon-button"
            aria-label="导入笔记文件"
            onClick={() => run(() => window.kindlespouse.importNotebookFiles())}
          >
            <Plus size={19} />
          </button>
          <details className="notes-more">
            <summary>更多</summary>
            <div>
              <button onClick={() => run(() => window.kindlespouse.importNotes())}>
                <Usb size={15} />
                USB 读取备份
              </button>
              <button onClick={() => run(() => window.kindlespouse.exportNotes('markdown'))}>导出 Markdown</button>
              <button onClick={() => run(() => window.kindlespouse.exportNotes('json'))}>导出 JSON</button>
            </div>
          </details>
        </div>
      </header>
      {state.notesImport?.working && (
        <p className="status-line">
          <LoaderCircle className="spin" size={15} />
          {state.notesImport.message}
        </p>
      )}
      {state.notesImport?.error && <p className="error-text">{state.notesImport.error}</p>}
      {state.sync.working && <p className="status-line"><LoaderCircle className="spin" size={15} />
        {state.sync.progress?.phase ?? '正在读取网盘更新'}
        {Boolean(state.sync.progress?.total) && ` · ${state.sync.progress!.done}/${state.sync.progress!.total}`}
        {Boolean(state.sync.progress?.totalBytes) && ` · ${((state.sync.progress!.bytes ?? 0) / 1048576).toFixed(1)}/${(state.sync.progress!.totalBytes! / 1048576).toFixed(1)} MiB`}
      </p>}
      {state.sync.error && <p className="error-text">{state.sync.error}</p>}
      <div className="notes-navigation">
        <div className="tabs">
          <button className={tab === 'notebook' ? 'active' : ''} onClick={() => setTab('notebook')}>
            手写笔记
          </button>
          <button className={tab === 'annotation' ? 'active' : ''} onClick={() => setTab('annotation')}>
            书籍标注
          </button>
        </div>
        {tab === 'annotation' && <label><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示已归档</label>}
        <div className="library-search">
          <Search size={16} />
          <input
            aria-label="搜索笔记"
            placeholder="搜索笔记与标注"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <div className={`notes-reader-layout ${tab === 'annotation' ? 'annotations-layout' : ''}`}>
        <aside className="notes-books-column">
          {tab === 'notebook' ? (
            <>
              <select
                aria-label="笔记分类"
                value={classification}
                onChange={(event) => {
                  setClassification(event.target.value)
                  setQuery('')
                }}
              >
                <option value="notebook">笔记本 ({count('notebook')})</option>
                <option value="attachment">书籍附属手写 ({count('attachment')})</option>
                <option value="unknown">待识别 ({count('unknown')})</option>
                <option value="auxiliary">其他资料 ({count('auxiliary')})</option>
              </select>
              {notebooks.map((book) => (
                <button
                  className={`note-book-row ${book.id === selectedId ? 'active' : ''}`}
                  key={book.id}
                  onClick={() => setSelectedId(book.id)}
                >
                  <span className="notebook-thumb">
                    {book.thumbnail ? <img src={book.thumbnail} alt="笔记缩略图" /> : <BookOpen size={20} />}
                  </span>
                  <span>
                    <strong>{book.title}</strong>
                    <small>
                      {book.status === 'ready'
                        ? '可阅读'
                        : book.status === 'failed'
                          ? '格式暂不支持'
                          : book.classification === 'auxiliary'
                            ? '不含可阅读笔记页面'
                            : book.titleSource === 'unresolved'
                              ? '等待设备目录关联标题'
                              : '点击打开'}
                      {book.pages ? ` · ${book.pages} 页` : ''}
                    </small>
                  </span>
                </button>
              ))}
              {!notebooks.length && <Empty title="暂无匹配笔记" />}
            </>
          ) : (
            <>
              <button
                className={`note-book-row ${!bookTitle ? 'active' : ''}`}
                onClick={() => {
                  setBookTitle('')
                  setNoteId('')
                }}
              >
                <Highlighter size={19} />
                <span>全部标注</span>
              </button>
              {books
                .filter(([key]) => !query || visibleNotes.some(note => groupKey(note) === key && `${note.bookTitle} ${note.text} ${note.edit?.note ?? note.note ?? ''}`.toLowerCase().includes(query.toLowerCase())))
                .map(([value, bookNote]) => (
                  <button
                    className={`note-book-row ${bookTitle === value ? 'active' : ''}`}
                    key={value}
                    onClick={() => {
                      setBookTitle(value)
                      setNoteId(bookNote.id)
                    }}
                  >
                    <BookOpen size={19} />
                    <span>
                      <strong>{bookNote.bookTitle}</strong>
                      <small>{bookNote.author} · {state.readingNotes.filter((note) => groupKey(note) === value).length} 条标注</small>
                    </span>
                  </button>
                ))}
            </>
          )}
        </aside>
        {tab === 'annotation' && (
          <section className="annotation-list">
            {notes.map((note) => (
              <button
                className={`annotation-entry ${note.id === noteId ? 'active' : ''}`}
                key={note.id}
                onClick={() => setNoteId(note.id)}
              >
                <div className="annotation-meta">
                  <strong>{note.bookTitle}</strong>
                  <small>{note.kind === 'bookmark' ? '书签' : note.kind === 'note' ? '笔记' : '标注'}</small>
                </div>
                <p>{note.text || '此处添加了书签'}</p>
                {(note.edit?.note ?? note.note) && <blockquote>{note.edit?.note ?? note.note}</blockquote>}
                <footer>
                  {note.location} · {note.source === 'koreader' ? 'KOReader' : 'Kindle'}
                  {note.edit && ` · ${{ local: '本机整理', queued: '待上传', uploaded: '等待设备应用', applied: '设备已应用', conflict: '版本冲突' }[note.edit.status]}`}
                  {(note.edit?.deleted || note.origin?.deleted) && ' · 已归档'}
                </footer>
              </button>
            ))}
            {!notes.length && <Empty title="暂无标注">同步设备后显示书籍标注。</Empty>}
          </section>
        )}
        <section className="notes-kindle">
          <div className="reader-context-heading">
            <strong>{candidate?.title ?? (tab === 'notebook' ? '选择笔记本' : '选择一条标注')}</strong>
            {tab === 'notebook' && selectedNotebook && (
              <div className="button-group">
                <button
                  className="icon-button"
                  aria-label="修改笔记标题"
                  onClick={() => {
                    setTitle(selectedNotebook.titleSource === 'unresolved' ? '' : selectedNotebook.title)
                    setRenaming(true)
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="导出笔记 PDF"
                  disabled={selectedNotebook.classification === 'auxiliary'}
                  onClick={() => run(() => window.kindlespouse.exportNotebook(selectedNotebook.id))}
                >
                  <Download size={16} />
                </button>
              </div>
            )}
          </div>
          {tab === 'annotation' && selectedNote && (
            <div className="annotation-actions">
              <button className="button" disabled={['queued', 'uploaded'].includes(selectedNote.edit?.status ?? '') || selectedNote.origin?.deleted} onClick={() => { setComment(selectedNote.edit?.note ?? selectedNote.note ?? ''); setEditing(true) }}><Pencil size={14} />编辑笔记</button>
              <button className="button" disabled={['queued', 'uploaded'].includes(selectedNote.edit?.status ?? '') || Boolean(selectedNote.edit?.deleted)} onClick={() => run(() => window.kindlespouse.editNote(selectedNote.id, selectedNote.edit?.note ?? selectedNote.note ?? '', true), '已归档；原始资料和历史版本保留')}>归档标注</button>
              {selectedNote.edit && !['queued', 'uploaded', 'applied'].includes(selectedNote.edit.status) && <button className="button" onClick={() => run(() => window.kindlespouse.restoreNote(selectedNote.id))}>撤销整理</button>}
              <small>{selectedNote.edit?.error ?? (selectedNote.source === 'kindle' ? 'Kindle 原生标注仅在本机整理，原始标注保留。' : selectedNote.origin?.deviceId ? '保存后从网盘更新；设备回执后显示已应用。' : '等待网盘同步确认设备来源后可写回。')}</small>
            </div>
          )}
          {tab === 'annotation' && selectedNote && (
            <div className="anchor-status">
              <span>{selectedBook ? message || '加载书籍后定位' : '尚未关联原书，请选择书库中的版本'}</span>
              {locating && <LoaderCircle size={14} className="spin" />}
              <select
                aria-label="关联标注原书"
                value={selectedBook?.id ?? ''}
                onChange={(event) => run(() => window.kindlespouse.linkNote(selectedNote.id, event.target.value))}
              >
                <option value="" disabled>
                  关联书籍
                </option>
                {state.candidates.map((book) => (
                  <option value={book.id} key={book.id}>
                    {book.title} · {book.format.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Reader
            browserOnly={state.settings.kindleMode === 'native'}
            ref={reader}
            engine={tab === 'annotation' ? state.settings.readerEngine ?? 'koreader' : 'browser'}
            book={candidate}
            profile={state.settings.profile}
            pageTurn={state.settings.readerPageTurn}
            loadBytes={tab === 'notebook' ? window.kindlespouse.previewNotebook : undefined}
            onReady={setReady}
            onChapters={() => {}}
            onLocation={(location, progress) => {
              if (tab === 'notebook' && selectedId)
                void window.kindlespouse.saveNotebookReading(selectedId, location).catch(() => {})
              else if (selectedBook)
                void window.kindlespouse.saveReading(selectedBook.id, location, progress).catch(() => {})
            }}
            onImport={() =>
              run(() =>
                tab === 'notebook' ? window.kindlespouse.importNotebookFiles() : window.kindlespouse.importFiles(),
              )
            }
          />
        </section>
      </div>
      {renaming && selectedNotebook && (
        <div className="modal-backdrop" onClick={() => setRenaming(false)}>
          <form
            className="confirm-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault()
              run(async () => {
                await window.kindlespouse.updateNotebook(selectedNotebook.id, title)
                setRenaming(false)
              })
            }}
          >
            <div className="section-heading">
              <h2>笔记标题</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭标题编辑"
                onClick={() => setRenaming(false)}
              >
                <X size={17} />
              </button>
            </div>
            <input
              aria-label="笔记标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={300}
            />
            <div className="modal-actions">
              <button className="button primary">保存</button>
            </div>
          </form>
        </div>
      )}
      {editing && selectedNote && <div className="modal-backdrop" onClick={() => setEditing(false)}><form className="confirm-modal" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); run(async () => { await window.kindlespouse.editNote(selectedNote.id, comment, false); setEditing(false) }) }}>
        <div className="section-heading"><h2>编辑标注笔记</h2><button type="button" className="icon-button" aria-label="关闭标注编辑" onClick={() => setEditing(false)}><X size={17} /></button></div>
        <blockquote>{selectedNote.text || '书签'}</blockquote><textarea aria-label="标注笔记内容" maxLength={20000} value={comment} onChange={event => setComment(event.target.value)} rows={7} />
        <p className="field-hint">{selectedNote.source === 'kindle' ? '原生标注在本机整理；不会修改 Kindle 原生阅读器。' : '修改通过网盘交给 KOReader。请退出当前书籍后应用，冲突时保留双方版本。'}</p>
        <div className="modal-actions"><button className="button primary">保存</button></div>
      </form></div>}
    </div>
  )
}
