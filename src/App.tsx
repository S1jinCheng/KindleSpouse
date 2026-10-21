import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Download,
  FileText,
  History,
  Library,
  LoaderCircle,
  Plus,
  Search,
  Settings2,
  Upload,
  UserRound,
  X,
} from 'lucide-react'
import Reader, { type Chapter, type ReaderHandle } from './Reader'
import LibraryPanel from './LibraryPanel'
import NotesPanel from './NotesPanel'
import DiscoveryPanel from './DiscoveryPanel'
import DoubanPanel from './DoubanPanel'
import { isKoreaderFormat, usesKoreader } from './book-formats'
import CloudPanel from './CloudPanel'
import ProfilePanel from './ProfilePanel'
import SettingsPanel, { ProfileControls } from './SettingsPanel'
import DeviceSetup, { SetupNotice } from './DeviceSetup'
import { kindleMode, kindleMailFormat, nativeCloudAvailable, nativeDelivery } from './kindle-devices'
import { Avatar, bytesLabel, JobRow, minutesLabel } from './ui'
import type { AppState, Candidate, PreviewProfile, TransferMethod, ViewName, KoreaderFrame } from './shared'

const api = window.kindlespouse
export default function App() {
  const [state, setState] = useState<AppState>()
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupDismissed, setSetupDismissed] = useState(false)
  const [nativeFrame, setNativeFrame] = useState<Omit<KoreaderFrame, 'image'>>()
  const [view, setView] = useState<ViewName>('library')
  const [libraryReading, setLibraryReading] = useState(false)
  const [workspaceMounted, setWorkspaceMounted] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [ready, setReady] = useState(false),
    [chapters, setChapters] = useState<Chapter[]>([])
  const [reviewed, setReviewed] = useState<string[]>([])
  const receiptCheck = useRef(false)
  const [tab, setTab] = useState<'search' | 'info' | 'toc' | 'profile'>('search')
  const [popover, setPopover] = useState<'profile' | 'transfers' | 'send' | undefined>()
  const [method, setMethod] = useState<TransferMethod>('cloud'),
    [cloudId, setCloudId] = useState('')
  const [busy, setBusy] = useState(0),
    [douban, setDouban] = useState(false)
  const [doubanPage, setDoubanPage] = useState<{ query?: string; subject?: string; author?: string }>({})
  const [downloadSearch, setDownloadSearch] = useState<{ id: number; title: string; author?: string }>()
  const [toast, setToast] = useState<{ message: string; error?: boolean }>()
  const reader = useRef<ReaderHandle>(null)
  const initialized = useRef(false),
    known = useRef(new Set<string>())
  const run = async (task: () => Promise<unknown>, success?: string) => {
    setBusy((value) => value + 1)
    try {
      await task()
      if (success) setToast({ message: success })
    } catch (error) {
      setToast({
        message: String(error instanceof Error ? error.message : error).replace(
          /^Error invoking remote method '[^']+': Error: /,
          '',
        ),
        error: true,
      })
    } finally {
      setBusy((value) => value - 1)
    }
  }
  const closeBrowser = () => {
    setDouban(false)
    void api?.closeDouban().catch(() => {})
  }
  const navigate = (next: ViewName) => {
    closeBrowser()
    setView(next)
    setPopover(undefined)
    setLibraryReading(false)
    if (next === 'workspace') { setWorkspaceMounted(true); setTab('search') }
  }
  const open = (id: string, library = false) => {
    closeBrowser()
    setSelectedId(id)
    setWorkspaceMounted(true)
    setView(library ? 'library' : 'workspace')
    setLibraryReading(library)
    setTab(library ? 'info' : 'search')
  }
  useEffect(() => {
    if (!api) return
    const update = (next: AppState) => {
      setState(next)
      if (!initialized.current) {
        setSelectedId(
          next.candidates.find((book) => book.id === localStorage.getItem('reading-book'))?.id ??
            next.candidates.find(book => isKoreaderFormat(book.format))?.id ??
            '',
        )
        setCloudId(next.settings.defaultCloudId ?? next.clouds[0]?.id ?? '')
        initialized.current = true
      } else {
        const added = next.candidates.find(
          (book) => !known.current.has(book.id) && !book.fromDevice && book.source !== '本机恢复',
        )
        if (added) {
          setWorkspaceMounted(true)
          setSelectedId(added.id)
          setView('workspace')
          setLibraryReading(false)
          setTab('search')
        }
      }
      known.current = new Set(next.candidates.map((book) => book.id))
    }
    void api
      .state()
      .then(update)
      .catch((error) => setToast({ message: String(error), error: true }))
    return api.subscribe(update)
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), toast.error ? 14000 : 5000)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => { if (state) setMethod(state.settings.kindleMode === 'native' ? nativeDelivery(state.settings) : 'cloud') }, [state?.settings.kindleMode, state?.settings.deviceModel, state?.settings.nativeDelivery])
  useEffect(() => {
    if (!popover) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPopover(undefined) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [popover])
  useEffect(() => {
    setReady(false)
    setChapters([])
    if (selectedId) localStorage.setItem('reading-book', selectedId)
  }, [selectedId])
  useEffect(
    () => () => {
      void api?.closeDouban().catch(() => {})
    },
    [],
  )
  useEffect(() => {
    if (state?.candidates.some(book => book.id === selectedId && isKoreaderFormat(book.format))) setWorkspaceMounted(true)
  }, [selectedId, state?.settings.readerEngine, state?.candidates])
  const awaitingBooks = state?.settings.kindleMode !== 'native' ? state?.jobs.filter(job => job.method === 'cloud' && job.status === 'cloud_ready' && !job.deviceReceivedAt).map(job => job.id).join(',') : ''
  useEffect(() => {
    if (!awaitingBooks) return
    const check = async () => {
      if (receiptCheck.current) return
      receiptCheck.current = true
      try { await api.refreshBookReceipts() } catch {} finally { receiptCheck.current = false }
    }
    void check()
    const timer = setInterval(() => void check(), 15000)
    return () => clearInterval(timer)
  }, [awaitingBooks])
  if (!api)
    return (
      <div className="startup-error">
        <BookOpen size={36} />
        <h1>请从 KindleSpouse 桌面应用打开</h1>
      </div>
    )
  if (!state)
    return (
      <div className="startup-error">
        <LoaderCircle className="spin" size={30} />
        <p>正在打开书库</p>
      </div>
    )
  const selected = state.candidates.find((book) => book.id === selectedId)
  const nativeMode = kindleMode(state.settings) === 'native'
  const showSetup = setupOpen || !state.settings.onboardingComplete && !setupDismissed
  const nativeReading = !nativeMode && usesKoreader(selected?.format, state.settings.readerEngine ?? 'koreader')
  const reading = view === 'workspace' || (view === 'library' && libraryReading)
  const targetCloud =
    state.clouds.find((cloud) => cloud.id === cloudId) ??
    state.clouds.find((cloud) => cloud.id === state.settings.defaultCloudId) ??
    state.clouds[0]
  const importFiles = () =>
    run(async () => {
      const ids = await api.importFiles()
      if (ids[0]) open(ids[0])
    })
  const changeProfile = (profile: PreviewProfile) => {
    setState((current) => (current ? { ...current, settings: { ...current.settings, profile } } : current))
    void api.saveSettings({ profile }).catch((error) => setToast({ message: String(error), error: true }))
  }
  const activeJobs = state.jobs.filter((job) =>
    ['queued', 'waiting_device', 'importing', 'transferring', 'verifying'].includes(job.status),
  ).length + state.downloads.filter(task => ['downloading', 'checking'].includes(task.status)).length
  const name = state.settings.displayName ?? '我的阅读空间'
  const transferControl = <button className={`text-button transfer-trigger ${activeJobs ? 'has-activity' : ''}`} aria-label="打开传输记录" aria-expanded={popover === 'transfers'} onClick={() => { closeBrowser(); setPopover(popover === 'transfers' ? undefined : 'transfers') }}><History size={17} /><span>传输记录</span>{activeJobs > 0 && <span className="transfer-count">{activeJobs}</span>}</button>
  const openDouban = (query?: string, subject?: string, author?: string) => {
    setDouban(true)
    setDoubanPage({ query, subject, author })
  }
  const findDownloads = (title: string, author?: string) => {
    closeBrowser()
    setTab('search')
    setDownloadSearch({ id: Date.now(), title, author })
  }
  const downloadToKindle = async (book: Candidate) => {
    if (!state.settings.onboardingComplete) { closeBrowser(); setSetupOpen(true); throw new Error('请先完成设备设置，再开始传书。') }
    if (nativeMode) {
      if (nativeDelivery(state.settings) === 'native-cloud') {
        const account = state.clouds.find(account => account.id === state.settings.defaultCloudId && account.connected)
        if (!account) { navigate('sources'); throw new Error('请先连接并选择默认网盘。') }
        await api.approve({ candidateId: book.id, sha256: book.sha256, method: 'native-cloud', cloudAccountId: account.id })
        return
      }
      if (!state.kindleMail?.configured) { closeBrowser(); setSetupOpen(true); throw new Error('请先完成 Kindle 邮箱设置，再发送这本书。') }
      await api.approve({ candidateId: book.id, sha256: book.sha256, method: 'kindle-email' })
      return
    }
    const account = state.clouds.find(account => account.id === state.settings.defaultCloudId) ?? state.clouds.find(account => account.connected)
    if (!account?.connected) { navigate('sources'); throw new Error('请先连接默认网盘，再点击下载。') }
    await api.approve({ candidateId: book.id, sha256: book.sha256, method: 'cloud', cloudAccountId: account.id })
  }
  return (
    <div
      className="app-shell books-design"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const files = [...event.dataTransfer.files]
        if (files.length)
          run(async () => {
            const ids = await api.importDropped(files)
            if (ids[0]) open(ids[0])
          })
      }}
    >
      <aside className="sidebar" inert={showSetup}>
        <div className="sidebar-brand">
          <span className="brand-mark">
            <img src="/brand/icon.png" alt="" width={32} height={32} draggable={false} />
          </span>
          <span>KindleSpouse</span>
        </div>
        <nav className="main-nav">
          <span className="nav-section-label">阅读</span>
          <button className={view === 'library' ? 'active' : ''} onClick={() => navigate('library')}>
            <Library size={19} />
            <span>我的书库</span>
          </button>
          <button className={view === 'workspace' ? 'active' : ''} onClick={() => navigate('workspace')}>
            <Search size={19} />
            <span>找书与试读</span>
          </button>
          <span className="nav-section-label">资料</span>
          <button className={view === 'notes' ? 'active' : ''} onClick={() => navigate('notes')}>
            <FileText size={19} />
            <span>笔记与标注</span>
          </button>
          <button className={view === 'sources' ? 'active' : ''} onClick={() => navigate('sources')}>
            <Cloud size={19} />
            <span>我的网盘</span>
          </button>
        </nav>
        <div className="sidebar-space" />
        <button
          className="profile-trigger"
          aria-label="打开个人资料菜单"
          aria-expanded={popover === 'profile'}
          onClick={() => {
            closeBrowser()
            setPopover(popover === 'profile' ? undefined : 'profile')
          }}
        >
          <Avatar settings={state.settings} />
          <span>
            <strong>{name}</strong>
            <small>{nativeMode ? 'Kindle 原生模式' : `Kindle 今日 ${minutesLabel(state.stats.todaySeconds)}`}</small>
          </span>
          <ChevronDown size={15} />
        </button>
      </aside>
      <main inert={showSetup} className={`main-content ${reading ? 'reading-workspace' : view === 'library' ? 'library-content' : ''}`}>
        <SetupNotice state={state} run={run} onSetup={() => { closeBrowser(); setSetupOpen(true) }} />
        {!reading && view !== 'library' && <div className="global-toolbar">
          <div className="toolbar-location">
              <span>
                {view === 'notes'
                    ? '笔记与标注'
                    : view === 'sources'
                      ? '网盘'
                      : view === 'settings'
                        ? '设置'
                        : view === 'profile'
                          ? '阅读空间'
                          : '找书与试读'}
              </span>
          </div>
          <div className="topbar-actions">
            {busy > 0 && <LoaderCircle size={15} className="spin" aria-label="正在处理" />}
            {transferControl}
          </div>
        </div>}
        {workspaceMounted && (
          <div className="reading-shell" hidden={!reading} data-reader-ready={ready}>
            <div className="reading-heading">
              <div className="reading-title">
                {view === 'library' && <button className="text-button" onClick={() => setLibraryReading(false)}><ArrowLeft size={16} />书库</button>}
                <h1>{view === 'workspace' ? '找书与试读' : '正在阅读'}</h1>
              </div>
              <div className="workspace-actions">
                {transferControl}
                <button className="button workspace-import" aria-label="导入书籍" onClick={importFiles}><Plus size={16} />导入</button>
              </div>
            </div>
            <div className="workspace-grid">
              <section className="reader-column">
                {selected && <div className="preview-book-heading"><h2 title={selected.title}>{selected.title}</h2><p>{selected.author}</p></div>}
                <Reader
                  browserOnly={nativeMode}
                  ref={reader}
                  book={selected}
                  active={reading && !showSetup}
                  profile={state.settings.profile}
                  engine={nativeReading ? 'koreader' : 'browser'}
                  pageTurn={state.settings.readerPageTurn}
                  onKoreader={setNativeFrame}
                  onReady={value => { setReady(value); if (value && selected) setReviewed(previous => previous.includes(`${selected.id}:${selected.sha256}`) ? previous : [...previous, `${selected.id}:${selected.sha256}`]) }}
                  onChapters={setChapters}
                  onLocation={(location, progress) => {
                    if (selected) void api.saveReading(selected.id, location, progress).catch(() => {})
                  }}
                  onImport={importFiles}
                />
              </section>
              <section className="workspace-right">
                <div className="workspace-tabs" hidden={douban}>
                  <div className="tabs">
                    {[
                      ['search', '找书'],
                      ['info', '书籍信息'],
                      ['toc', '目录'],
                      ['profile', 'Aa'],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={tab === value ? 'active' : ''}
                        onClick={() => {
                          closeBrowser()
                          setTab(value as typeof tab)
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div hidden={douban || tab !== 'search'}><DiscoveryPanel state={state} run={run} onOpen={open} onDouban={openDouban} downloadSearch={downloadSearch} reviewed={reviewed} onDownload={downloadToKindle} /></div>
                {douban ? (
                  <DoubanPanel query={doubanPage.query} subject={doubanPage.subject} onDownload={title => findDownloads(title, title === doubanPage.query ? doubanPage.author : undefined)} onClose={() => { closeBrowser(); setTab('search') }} />
                ) : tab === 'profile' ? (
                  nativeReading ? <div className="profile-controls"><h2>KOReader 阅读设置</h2><label>翻页效果<select aria-label="翻页效果" value={state.settings.readerPageTurn ?? 'paper'} onChange={event => run(() => api.saveSettings({ readerPageTurn: event.target.value as 'paper' | 'soft' | 'none' }))}><option value="paper">纸张翻页</option><option value="soft">轻柔切换</option><option value="none">即时切换</option></select></label><p>{nativeFrame ? `${nativeFrame.version} · ${nativeFrame.font ?? ''} ${nativeFrame.fontSize ?? ''}` : '正在读取阅读配置'}</p><p>{nativeFrame?.exactBook ? '已使用这本书从 Kindle 同步的排版设置。' : nativeFrame?.syncedAt ? '沿用最近同步的设备排版；这本书尚未与设备单独核对。' : '当前为 KOReader 默认配置，尚未取得设备阅读设置。'}</p><p>在 Kindle 调整字体、字号或页边距后，保存退出书籍并同步网盘，再点击下方按钮更新预览。</p><button className="button" disabled={!selected} onClick={() => reader.current?.configure?.()}>重新加载设备排版</button></div> : <ProfileControls profile={state.settings.profile} onChange={changeProfile} />
                ) : tab === 'toc' ? (
                  <div className="toc-list">
                    {chapters.map((chapter, index) => (
                      <button key={`${chapter.href}:${index}`} onClick={() => reader.current?.go(chapter.href)}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        {chapter.label}
                      </button>
                    ))}
                    {!chapters.length && <p className="status-line">打开书籍后显示目录。</p>}
                  </div>
                ) : tab === 'info' && selected ? (
                  <div className="book-info-panel">
                    <div className="book-summary">
                      {selected.cover ? (
                        <img className="book-cover" src={selected.cover} alt="" />
                      ) : (
                        <div className="book-cover cover-fallback">
                          <BookOpen size={26} />
                        </div>
                      )}
                      <div>
                        <span className="format-badge">
                          {selected.format.toUpperCase()}
                          {selected.isSample ? ' · 样章' : ''}
                        </span>
                        <h2>{selected.title}</h2>
                        <p>{selected.author}</p>
                      </div>
                    </div>
                    <dl className="book-info-fields">
                      <div>
                        <dt>来源</dt>
                        <dd>{selected.source}</dd>
                      </div>
                      <div>
                        <dt>大小</dt>
                        <dd>{bytesLabel(selected.bytes)}</dd>
                      </div>
                      <div>
                        <dt>书库</dt>
                        <dd>{selected.library ? '已收藏' : '待试读'}</dd>
                      </div>
                      <div>
                        <dt>语言</dt>
                        <dd>{selected.language ?? '未提供'}</dd>
                      </div>
                    </dl>
                    {selected.description && <p className="book-description">{selected.description}</p>}
                    {selected.warnings.map((warning) => (
                      <p className="status-line" key={warning}>
                        {warning}
                      </p>
                    ))}
                    <div className="button-group">
                      {nativeMode && <button className="button primary" disabled={!ready || !kindleMailFormat(selected.format)} onClick={() => run(() => downloadToKindle(selected), '发送任务已创建，可在传输记录查看')}><Upload size={15} />{nativeDelivery(state.settings) === 'native-cloud' ? '上传到网盘' : '发送到 Kindle'}</button>}
                      <button className="button" onClick={() => findDownloads(selected.title, selected.author)}><Search size={15} />查找完整下载版本</button>
                      <button
                        className="button"
                        disabled={selected.library}
                        onClick={() => run(() => api.collect(selected.id), '已加入书库')}
                      >
                        {selected.library ? <Check size={15} /> : <Plus size={15} />}
                        {selected.library ? '已收藏' : '加入书库'}
                      </button>
                      <button className="button" onClick={() => openDouban(selected.title, undefined, selected.author)}>
                        豆瓣书评
                      </button>
                    </div>
                    <details className="book-secondary-actions"><summary>更多操作</summary><div><button className="text-button" aria-label="保存原文件" onClick={() => run(async () => { if (await api.exportBook(selected.id)) setToast({ message: '原文件已保存到所选位置' }) })}>保存{selected.isSample ? '样章' : '原文件'}到电脑</button><button className="text-button" disabled={!ready || !isKoreaderFormat(selected.format)} onClick={() => { closeBrowser(); setPopover('send') }}>其他传书方式</button></div></details>
                  </div>
                ) : tab === 'info' ? (
                  <p className="status-line">选择书籍后显示详情。</p>
                ) : null}
              </section>
            </div>
          </div>
        )}
        {!reading && (view === 'library' ? (
          <LibraryPanel state={state} run={run} onOpen={(id) => open(id, true)} onImport={importFiles} tools={transferControl} />
        ) : view === 'notes' ? (
          <NotesPanel state={state} run={run} />
        ) : view === 'sources' ? (
          <CloudPanel state={state} run={run} onOpen={open} />
        ) : view === 'profile' ? (
          <ProfilePanel state={state} run={run} />
        ) : (
          <SettingsPanel state={state} run={run} readingBookId={selected?.id} onSetup={() => { closeBrowser(); setSetupOpen(true) }} />
        ))}
      </main>
      {popover && <div className="popover-dismiss" onClick={() => setPopover(undefined)} />}
      {popover === 'profile' && (
        <section className="profile-popover popover" aria-label="个人资料菜单">
          <div className="popover-user">
            <Avatar settings={state.settings} />
            <div>
              <strong>{name}</strong>
              <small>{nativeMode ? '原生阅读记录暂未接入' : `Kindle 今日阅读 ${minutesLabel(state.stats.todaySeconds)}`}</small>
            </div>
          </div>
          <button onClick={() => navigate('profile')}>
            <UserRound size={17} />
            阅读时长与日历
          </button>
          <button onClick={() => navigate('settings')}>
            <Settings2 size={17} />
            设置与设备
          </button>
          <button onClick={() => navigate('sources')}>
            <Cloud size={17} />
            网盘与同步
          </button>
        </section>
      )}
      {popover === 'transfers' && (
        <section className="transfer-popover popover" aria-label="传输记录">
          <div className="section-heading">
            <h2>传输与下载</h2>
            <button className="icon-button" aria-label="关闭传输记录" onClick={() => setPopover(undefined)}>
              <X size={17} />
            </button>
          </div>
          {state.libraryCloudSync?.working && <p className="status-line">正在准备书库 {state.libraryCloudSync.prepared}/{state.libraryCloudSync.total} · {state.libraryCloudSync.currentTitle}</p>}
          {state.jobs.map((job) => (
            <JobRow job={job} run={run} />
          ))}
          {state.downloads.map((task) => (
            <div className="download-row" key={task.id}>
              <Download size={17} />
              <div>
                <strong>{task.label}</strong>
                <p>
                  {task.error ??
                    (task.status === 'complete'
                      ? '下载完成'
                      : task.status === 'checking'
                        ? '正在检查文件'
                        : task.bytes === 0
                          ? '正在连接下载'
                        : `${bytesLabel(task.bytes)}${task.total ? ' / ' + bytesLabel(task.total) : ''}`)}
                </p>
              </div>
            </div>
          ))}
          {!state.jobs.length && !state.downloads.length && <p className="status-line">暂无传输记录</p>}
        </section>
      )}
      {popover === 'send' && selected && (
        <section className="send-popover popover" role="dialog" aria-label="确认传输">
          <h2>{method === 'cloud' ? '上传书籍到网盘' : '发送到 Kindle'}</h2>
          <strong>{selected.title}</strong>
          <label className="transfer-method-label">传书方式<select aria-label="传书方式" value={method} onChange={event => setMethod(event.target.value as TransferMethod)}>{nativeMode ? <><option value="kindle-email">Send to Kindle 邮件</option>{nativeCloudAvailable(state.settings) && <option value="native-cloud">官方网盘 · 手动导入</option>}</> : <><option value="cloud">网盘自动收书</option><option value="usb">USB</option><option value="opds">无线书目</option></>}</select></label>
          {method === 'cloud' || method === 'native-cloud' ? (
            <>
              {state.clouds.length ? (
                <select
                  aria-label="发送网盘账号"
                  value={targetCloud?.id ?? ''}
                  onChange={(event) => setCloudId(event.target.value)}
                >
                  {state.clouds.map((cloud) => (
                    <option key={cloud.id} value={cloud.id}>
                      {cloud.name}
                    </option>
                  ))}
                </select>
              ) : (
                <button className="button" onClick={() => navigate('sources')}>
                  连接网盘
                </button>
              )}
              <p>电脑将书籍上传至 {state.settings.cloudFolder}。{method === 'native-cloud' ? '请在 Kindle Connections 中连接同一网盘并手动导入，不会自动收书。' : 'Kindle 联网且 KOReader 运行时自动收书。'}</p>
            </>
          ) : (
            <p>
              {method === 'kindle-email' ? `发送至 ${state.kindleMail?.recipient ?? '尚未配置的 Kindle 邮箱'}；邮件服务接受后由 Amazon 处理，不代表设备已收到。` : method === 'usb'
                ? '保存并退出 KOReader 后，通过 USB 写入并校验。'
                : '通过已开启的 OPDS 书目在 Kindle 下载。'}
            </p>
          )}
          <div className="modal-actions">
            <button className="button" onClick={() => setPopover(undefined)}>
              取消
            </button>
            <button
              className="button primary"
              data-testid="approve-transfer"
              disabled={(method === 'cloud' || method === 'native-cloud') && !targetCloud || method === 'kindle-email' && !state.kindleMail?.configured}
              onClick={() =>
                run(async () => {
                  if (!state.settings.onboardingComplete) { setPopover(undefined); setSetupOpen(true); throw new Error('请先完成设备设置，再开始传书。') }
                  await api.approve({
                    candidateId: selected.id,
                    sha256: selected.sha256,
                    method,
                    cloudAccountId: targetCloud?.id,
                    deviceId: state.devices[0]?.id,
                  })
                  setPopover(undefined)
                }, method === 'cloud' ? '网盘上传任务已创建' : '传输任务已创建')
              }
            >
              {method === 'cloud' ? '确认上传' : '确认发送'}
            </button>
          </div>
        </section>
      )}
      {showSetup && <DeviceSetup state={state} run={run} onClose={() => { setSetupOpen(false); setSetupDismissed(true) }} />}
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">
          {toast.error ? <X size={17} /> : <CheckCircle2 size={17} />}
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(undefined)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
