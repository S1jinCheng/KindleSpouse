import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, stat, readdir, rename, realpath } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { lookup } from 'node:dns/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { Store } from './store'
import { contentHash, inspectBook, MAX_BOOK_BYTES, safeFilename, safePreview, transferFilename } from './books'
import { CloudBridge, type SecretStore, safeRemotePath } from './cloud'
import { ZlibSource } from './source'
import { CatalogServer } from './catalog'
import { DeviceBridge } from './device'
import { runProcess } from './process'
import { NotebookLibrary } from './notes'
import type {
  AppState,
  Approval,
  BookFormat,
  CloudAccount,
  DeviceInfo,
  DiscoveryResult,
  DiscoveryScope,
  DownloadTask,
  NotesImport,
  KindleMailInput,
  ReadingSession,
  Settings,
  StoredCandidate,
  SyncDevice,
  TransferJob,
} from '../src/shared'
import { ReadingHistory } from './history'
import { CloudSync } from './sync'
import { AutomaticCloudSync } from './auto-sync'
import { DoubanCatalog } from './douban'
import { KoreaderPreview, linuxPath } from './koreader'
import { editNote, restoreNote } from './annotation-edits'
import { readingStreak, sleepProfile } from '../src/sleep-cover'
import { avatarAsset } from './avatar'
import { SleepPreviewCache } from './sleep-preview'
import { LocalProfileServer } from './local-profile'
import { KindleMail, KindleMailError } from './kindle-mail'
import { KINDLE_MODELS, kindleMode, nativeCloudAvailable, nativeDelivery, kindleMailFormat, KINDLE_MAIL_MAX_BYTES } from '../src/kindle-devices'
import JSZip from 'jszip'
import { deviceContentRole, isLibraryBook } from './device-content'
import { KOREADER_EXTENSIONS, bookFormatFromFilename, formatFromMimeType, isBrowserFormat, isKoreaderFilename, isKoreaderFormat, stripBookExtension } from '../src/book-formats'

interface CoreOptions {
  directory: string
  nativeDirectory: string
  calibreDirectory?: string
  secrets: SecretStore
  openBrowser: (url: string) => Promise<void>
  allowLocalDownloads?: boolean
  douban?: { search(query: string): Promise<DiscoveryResult[]> }
  kindleMail?: KindleMail
  readerAutostart?: boolean
  transport?: {
    list(): Promise<DeviceInfo[]>
    upload(id: string, source: string, filename: string, sha256: string): Promise<void>
    export?(id: string, destination: string): Promise<{ files: number; directory: string }>
    exportNotes?(id: string, destination: string): Promise<{ files: number; directory: string }>
    exportTitles?(id: string, destination: string): Promise<{ files: number; directory: string }>
  }
}

export class AppCore extends EventEmitter {
  readonly store: Store
  readonly source: ZlibSource
  readonly koreader: KoreaderPreview
  readonly cloud: CloudBridge
  readonly catalog: CatalogServer
  readonly directory: string
  readonly notebookLibrary: NotebookLibrary
  readonly history: ReadingHistory
  readonly sync: CloudSync
  readonly localProfiles: LocalProfileServer
  readonly kindleMail: KindleMail
  private douban = new DoubanCatalog()
  private recovery?: AppState['recovery']
  private notesImport?: NotesImport
  private transport: NonNullable<CoreOptions['transport']>
  private devices: DeviceInfo[] = []
  private downloads: DownloadTask[] = []
  private settings: Settings
  private cloudConnecting?: string
  private working = false
  private processing?: Promise<void>
  private processAgain = false
  private importQueue: Promise<unknown> = Promise.resolve()
  private previewed = new Map<string, string>()
  private deviceImport?: AppState['deviceImport']
  private readableTasks = new Map<string, Promise<StoredCandidate>>()
  private preferencesTimer?: ReturnType<typeof setTimeout>
  private coverReader?: KoreaderPreview
  private coverCache: SleepPreviewCache
  private automaticSync: AutomaticCloudSync
  private libraryPreparation?: Promise<void>
  private libraryCloudSync?: AppState['libraryCloudSync']
  private closing = false
  private initialImport?: AppState['initialImport']
  private initialImportTask?: Promise<void>
  private initialImportTimer?: ReturnType<typeof setTimeout>
  private initialImportStarted = false
  private initialImportAgain = false

  constructor(private options: CoreOptions) {
    super()
    this.directory = options.directory
    this.coverCache = new SleepPreviewCache(path.join(options.directory, 'sleep-previews'))
    this.store = new Store(options.directory)
    this.initialImport = this.store.get('initial-import', 'main')
    if (this.initialImport?.status === 'reading') this.initialImport = { ...this.initialImport, status: 'waiting_device', message: '上次导入中断，正在等待 Kindle 重新连接；已有资料仍保留。' }
    const previous = this.store.get<NonNullable<AppState['libraryCloudSync']>>('library-cloud-sync', 'main')
    if (previous) this.libraryCloudSync = { ...previous, working: false, currentTitle: undefined, ...(previous.working ? { error: '上次书库准备已中断，可以重新同步以继续。' } : {}) }
    this.notebookLibrary = new NotebookLibrary(this.store, options.directory, options.nativeDirectory, () =>
      this.notify(),
    )
    this.history = new ReadingHistory(this.store)
    const storedSettings = this.store.get<Settings>('settings', 'main')
    const legacyInstall = !storedSettings && ['candidates', 'clouds', 'sync-devices'].some(namespace => this.store.list(namespace).length > 0)
    this.settings = storedSettings ?? {
      kindleMode: 'native',
      readerEngine: 'browser',
      onboardingComplete: false,
      sourceUrl: 'https://zh.z-lib.help/',
      calibreDirectory: options.calibreDirectory ?? '',
      cloudFolder: 'KindleSpouse/Inbox',
      profile: { font: 'song', fontSize: 19, lineHeight: 1.85, margin: 24, paper: 'warm' },
    }
    if (storedSettings && !storedSettings.kindleMode) this.settings = { ...storedSettings, kindleMode: 'koreader', onboardingComplete: true }
    if (legacyInstall) this.settings = { ...this.settings, kindleMode: 'koreader', readerEngine: 'koreader', onboardingComplete: true }
    if (!storedSettings?.kindleMode) this.store.put('settings', 'main', this.settings)
    this.kindleMail = options.kindleMail ?? new KindleMail(options.secrets)
    const toolDirectory = path.join(options.nativeDirectory, 'tools')
    this.koreader = new KoreaderPreview(options.directory, options.nativeDirectory)
    this.source = new ZlibSource(
      path.join(toolDirectory, 'zlib.exe'),
      path.join(options.directory, 'scratch'),
      options.secrets,
      () => this.notify(),
    )
    this.cloud = new CloudBridge(
      path.join(toolDirectory, 'rclone.exe'),
      path.join(options.directory, 'scratch'),
      options.secrets,
      options.openBrowser,
    )
    this.sync = new CloudSync(
      this.store,
      this.cloud,
      this.notebookLibrary,
      this.history,
      options.directory,
      options.nativeDirectory,
      () => this.settings,
      () => this.notify(),
    )
    this.transport = options.transport ?? new DeviceBridge(options.nativeDirectory)
    this.localProfiles = new LocalProfileServer(options.directory, options.nativeDirectory, this.store, options.secrets, () => this.settings, receipt => this.sync.applyProfileReceipt(receipt, 'lan'), () => this.notify(), () => this.history.stats())
    this.catalog = new CatalogServer(
      () =>
        this.store
          .list<TransferJob>('jobs')
          .filter((job) => ['published', 'cloud_ready'].includes(job.status) && isLibraryBook(this.store.get<StoredCandidate>('candidates', job.candidateId)))
          .map((job) => ({ job, book: this.book(job.candidateId) })),
      async (job, book) => {
        if (job.method !== 'cloud') return { path: book.path }
        if (!job.cloudAccountId || !job.remotePath) throw new Error('缺少网盘文件信息。')
        await mkdir(path.join(this.directory, 'scratch'), { recursive: true })
        const directory = await mkdtemp(path.join(this.directory, 'scratch', 'acquire-'))
        const filename = path.join(directory, book.filename)
        try {
          await this.cloud.download(job.cloudAccountId, job.remotePath, filename)
          if (contentHash(await readFile(filename)) !== job.sha256) throw new Error('网盘文件已改变，停止下载。')
          return { path: filename, cleanup: () => rm(directory, { recursive: true, force: true }) }
        } catch (error) {
          await rm(directory, { recursive: true, force: true })
          throw error
        }
      },
    )
    for (const job of this.store.list<TransferJob>('jobs')) {
      let updated = job
      if (['importing', 'transferring', 'verifying'].includes(job.status)) updated = { ...job, status: job.method === 'kindle-email' && job.status === 'transferring' ? 'delivery_unknown' : 'failed', error: job.method === 'kindle-email' && job.status === 'transferring' ? '上次发送中断，邮件可能已经提交。请先检查 Kindle，再决定是否重新发送。' : '上次运行中断，请重试。已确认文件仍保留。' }
      if (updated.batchId && updated.remotePath && ['queued', 'failed'].includes(updated.status) && !updated.deviceReceivedAt) {
        const book = this.store.get<StoredCandidate>('candidates', updated.candidateId)
        if (book?.sha256 === updated.sha256) updated = { ...updated, remotePath: `${path.posix.dirname(updated.remotePath)}/${transferFilename(book.title, book.sha256, book.format)}` }
      }
      if (updated !== job) this.store.put('jobs', job.id, updated)
    }
    this.automaticSync = new AutomaticCloudSync(
      () => {
        const accounts = new Set(this.store.list<CloudAccount>('clouds').map(account => account.id))
        return this.store.list<SyncDevice>('sync-devices').filter(device => device.status !== 'revoked' && accounts.has(device.accountId)).map(device => device.accountId)
      },
      () => kindleMode(this.settings) === 'koreader' && this.settings.autoCloudSync !== false && !this.initialImportTask && !this.working && !this.awaitingNewBookReceipt() && !this.sync.snapshot().working && !this.sync.snapshot().pairing,
      async account => { await this.sync.ensureBookFolder(account); await this.sync.sync(account, true) },
    )
    this.automaticSync.start()
  }

  private awaitingNewBookReceipt() {
    return this.store.list<TransferJob>('jobs').some(job => {
      if (job.method !== 'cloud' || job.status !== 'cloud_ready' || job.deviceReceivedAt) return false
      const age = Date.now() - Date.parse(job.verifiedAt || job.createdAt)
      return age >= 0 && age < 180000
    })
  }

  snapshot(): AppState {
    return {
      initialImport: this.initialImport,
      kindleMail: this.kindleMail.state(),
      libraryCloudSync: this.libraryCloudSync,
      discoveryFiles: this.store.list<{ id: string; candidateId: string; sha256: string }>('discovery-files').filter(item => {
        const book = this.store.get<StoredCandidate>('candidates', item.candidateId)
        return book && isLibraryBook(book) && book.sha256 === item.sha256
      }),
      candidates: this.store
        .list<StoredCandidate>('candidates')
        .filter(isLibraryBook)
        .map(({ path: privatePath, previewPath: privatePreview, ...book }) => book)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      jobs: this.store.list<TransferJob>('jobs').sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      downloads: [...this.downloads],
      devices: this.devices,
      stats: this.history.stats(),
      sync: this.sync.snapshot(),
      recovery: this.recovery,
      clouds: this.store.list<CloudAccount>('clouds'),
      settings: this.settings,
      tools: {
        calibre: existsSync(path.join(this.settings.calibreDirectory, 'calibredb.exe')),
        zlib: existsSync(path.join(this.options.nativeDirectory, 'tools', 'zlib.exe')),
        rclone: existsSync(path.join(this.options.nativeDirectory, 'tools', 'rclone.exe')),
      },
      sourceConnected: this.source.connected(this.settings.sourceUrl),
      sourceAccount: this.source.account(this.settings.sourceUrl),
      sourceHealth: { ...this.source.pool.snapshot(), activeOrigin: this.source.activeOrigin },
      notebooks: this.notebookLibrary.notebooks(),
      notebookTitles: this.notebookLibrary.titleStatus(),
      readingNotes: this.notebookLibrary.notes(),
      notesImport: this.notesImport,
      cloudConnecting: this.cloudConnecting,
      deviceImport: this.deviceImport,
      opds: this.catalog.info,
      localProfiles: this.localProfiles.snapshot(),
    }
  }

  notify() {
    this.emit('state', this.snapshot())
  }

  book(id: string) {
    const book = this.store.get<StoredCandidate>('candidates', id)
    if (!book) throw new Error('这本书已被移除，请重新选择。')
    if (!isLibraryBook(book)) throw new Error('这是笔记或设备附属文件，请在“笔记与标注”打开对应笔记。')
    return book
  }

  private async calibre(executable: string, args: string[], timeout = 120000) {
    const configuration = await mkdtemp(path.join(tmpdir(), 'KS-calibre-'))
    try {
      return await runProcess(path.join(this.settings.calibreDirectory, executable), args, {
        timeout,
        env: {
          ...process.env,
          CALIBRE_CONFIG_DIRECTORY: configuration,
          CALIBRE_OVERRIDE_LANG: 'en',
          PYTHONIOENCODING: 'utf-8',
        },
      })
    } finally {
      await rm(configuration, { recursive: true, force: true })
    }
  }

  async importFile(filename: string, source = '本地导入', original?: StoredCandidate) {
    const metadata = await inspectBook(filename)
    const duplicate = this.store.list<StoredCandidate>('candidates').find((book) => isLibraryBook(book) && book.sha256 === metadata.sha256)
    if (duplicate) return duplicate.id
    const id = randomUUID()
    const directory = path.join(this.directory, 'candidates', id)
    await mkdir(directory, { recursive: true })
    const safeName = safeFilename(path.basename(filename), metadata.format)
    const destination = path.join(directory, safeName)
    await writeFile(destination, metadata.bytes)
    const { bytes: originalBytes, ...fields } = metadata
    const isSample = /sample|\.pre\.epub$/i.test(filename)
    if (isSample) fields.warnings.push('这是官方样章或试读文件，不是完整原著。')
    const book: StoredCandidate = {
      ...fields,
      id,
      filename: safeName,
      bytes: originalBytes.length,
      path: destination,
      createdAt: new Date().toISOString(),
      source,
      library: false,
      progress: 0,
      isSample,
      ...(original ? { title: original.title, author: original.author, library: original.library, fromDevice: original.fromDevice, derivedFromId: original.id, derivedFromHash: original.sha256, cover: original.cover ?? fields.cover } : {}),
    }
    this.store.put('candidates', id, book)
    this.notebookLibrary.linkBooks()
    this.notify()
    return id
  }

  async readableBook(id: string): Promise<StoredCandidate> {
    const book = this.book(id)
    if (isKoreaderFormat(book.format)) return book
    if (book.format !== 'kfx') throw new Error('这种原始格式还没有可用的阅读副本。')
    const existing = this.store.list<StoredCandidate>('candidates').find(candidate => candidate.derivedFromHash === book.sha256 && isKoreaderFormat(candidate.format))
    if (existing && existsSync(existing.path) && contentHash(await readFile(existing.path)) === existing.sha256) return existing
    const running = this.readableTasks.get(book.sha256)
    if (running) return running
    const task = (async () => {
      if (!this.snapshot().tools.calibre || !existsSync(path.join(this.options.nativeDirectory, 'tools/kfx-input/kfxlib/__init__.py'))) throw new Error('请先准备 Calibre 和 KFX 个人文档阅读组件。')
      if (book.bytes > MAX_BOOK_BYTES || contentHash(await readFile(book.path)) !== book.sha256) throw new Error('原始文件已变化或超过阅读上限。')
      const directory = await mkdtemp(path.join(await this.scratch(), 'readable-'))
      try {
        const output = await this.calibre('calibre-debug.exe', ['--exec-file', path.join(this.options.nativeDirectory, 'PrepareReadable.py'), '--', path.join(this.options.nativeDirectory, 'tools/kfx-input'), book.path, directory], 300000)
        const match = output.match(/KINDLESPOUSE_READABLE (\{[^\n]+\})/)
        const format = match ? JSON.parse(match[1]).format : undefined
        if (!['epub', 'pdf'].includes(format)) throw new Error('Invalid conversion result')
        const candidate = this.book(await this.importFile(path.join(directory, 'readable.' + format), 'KFX 个人文档阅读副本', book))
        this.store.put('candidates', candidate.id, { ...candidate, warnings: [...candidate.warnings.filter(warning => !warning.includes('电脑模拟')), '这是 KFX 个人文档的阅读副本；原始 KFX 保留。请在 Kindle 的 KOReader 打开同一副本核对排版。'] })
        return this.book(candidate.id)
      } catch { throw new Error('无法生成这份 KFX 的阅读副本。原件已保留；仅支持完整、无加密的个人文档。') }
      finally { await rm(directory, { recursive: true, force: true }) }
    })()
    this.readableTasks.set(book.sha256, task)
    try { return await task } finally { this.readableTasks.delete(book.sha256) }
  }

  async exportBook(id: string, destination: string) {
    const book = this.book(id)
    const parent = await realpath(path.dirname(path.resolve(destination)))
    const output = path.join(parent, path.basename(destination))
    const privateRoot = await realpath(this.directory)
    const relative = path.relative(privateRoot, output)
    if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('请选择应用资料目录之外的保存位置。')
    if ((await stat(book.path)).size !== book.bytes || book.bytes > MAX_BOOK_BYTES) throw new Error('原文件已改变或超过 200 MB 下载上限。')
    const bytes = await readFile(book.path)
    if (contentHash(bytes) !== book.sha256) throw new Error('原文件校验失败，已停止下载。')
    const temporary = await mkdtemp(path.join(parent, '.kindlespouse-export-'))
    try {
      const filename = path.join(temporary, 'original')
      await writeFile(filename, bytes)
      if (contentHash(await readFile(filename)) !== book.sha256) throw new Error('保存校验失败，请重试。')
      await rename(filename, output)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }

  async preview(id: string) {
    const book = this.book(id)
    if (book.bytes > MAX_BOOK_BYTES) throw new Error('原始文件已归档；这份文件超过 200 MB 预览上限。')
    let filename = book.path
    let hash = book.sha256
    if (!isBrowserFormat(book.format)) {
      if (contentHash(await readFile(book.path)) !== book.sha256)
        throw new Error('原始档案已变化，请重新读取设备书库。')
      if (!this.snapshot().tools.calibre) throw new Error('原始文件已归档。请配置 Calibre，为这种格式生成试读副本。')
      const directory = path.join(this.directory, 'previews')
      await mkdir(directory, { recursive: true })
      filename = path.join(directory, `${book.sha256}.epub`)
      if (!existsSync(filename)) {
        try {
          await this.calibre('ebook-convert.exe', [book.path, filename], 180000)
        } catch (error) {
          await rm(filename, { force: true })
          throw new Error(
            /DRM|encrypt/i.test(String(error))
              ? '原始文件已归档；这份书带有平台 DRM，无法在当前阅读器中预览。'
              : `原始 ${book.format.toUpperCase()} 文件已归档，当前转换器无法生成预览。`,
          )
        }
      }
      hash = contentHash(await readFile(filename))
    }
    const bytes = await safePreview(filename, hash)
    this.previewed.set(id, book.sha256)
    return bytes
  }

  async saveReading(id: string, location: string, progress: number) {
    const book = this.book(id)
    this.store.put('candidates', id, {
      ...book,
      location: location.slice(0, 2000),
      progress: Math.max(0, Math.min(1, progress)),
    })
  }

  async openKoreader(id: string, force = false) {
    const book = await this.checkNativeReadability(this.book(id))
    if (book.bytes > MAX_BOOK_BYTES) throw new Error('文件超过 200 MB 试读上限。')
    if (book.warnings.some(warning => /平台 DRM/.test(warning))) throw new Error('这份文件带有平台 DRM，无法用于 KOReader 试读。')
    const readable = await this.readableBook(id)
    const frame = await this.koreader.open(readable.id === book.id ? book : { ...readable, location: book.location }, force)
    this.previewed.set(id, book.sha256)
    this.previewed.set(readable.id, readable.sha256)
    return frame
  }

  private async checkNativeReadability(book: StoredCandidate) {
    if (!book.fromDevice || !isKoreaderFormat(book.format) || book.warnings.some(warning => /平台 DRM/.test(warning))) return book
    const checked = await inspectBook(book.path)
    if (checked.sha256 !== book.sha256) throw new Error('原始文件已改变，请重新导入。')
    const current = this.book(book.id)
    if (current.sha256 !== checked.sha256) throw new Error('文件索引已改变，请重新选择。')
    const warnings = [...new Set([...current.warnings, ...checked.warnings])]
    if (warnings.length === current.warnings.length) return current
    const updated = { ...current, warnings }
    this.store.put('candidates', current.id, updated)
    this.notify()
    return updated
  }

  async refreshLibraryReadability() {
    for (const book of this.store.list<StoredCandidate>('candidates').filter(book => isLibraryBook(book) && ['azw', 'mobi', 'prc', 'pdb'].includes(book.format))) {
      try { await this.checkNativeReadability(book) } catch {}
    }
  }

  async previewSleepCover(id: string) {
    const readable = await this.readableBook(id)
    const book = { ...readable, location: this.book(id).location }
    if (contentHash(await readFile(book.path)) !== book.sha256) throw new Error('原件已改变，请重新导入。')
    const stats = this.history.stats()
    const asset = avatarAsset(this.settings.avatarImage)
    const person = sleepProfile(this.settings, asset?.hash)
    const sleepStats = { duration: stats.todaySeconds, streak: readingStreak(stats.days) }
    const preset = await readFile(path.join(this.options.nativeDirectory, 'sleep-cover/preset.lua'))
    const layout = await readFile(path.join(this.directory, 'koreader-reading-layout.json')).catch(() => Buffer.alloc(0))
    const key = contentHash(Buffer.from(JSON.stringify({ sha256: book.sha256, title: book.title, author: book.author, location: book.location, person, sleepStats, preset: contentHash(preset), layout: contentHash(layout), sync: this.sync.snapshot().lastSuccess })))
    return this.coverCache.get(key, async () => {
      let avatarPath: string | undefined
      if (asset) {
        const directory = path.join(this.directory, 'profile', 'avatars')
        await mkdir(directory, { recursive: true })
        const filename = path.join(directory, asset.hash + '.png')
        await writeFile(filename, asset.bytes)
        avatarPath = linuxPath(filename)
      }
      this.coverReader ??= new KoreaderPreview(this.directory, this.options.nativeDirectory)
      const frame = await this.coverReader.open(book)
      try {
        return (await this.coverReader.command(frame.sessionId, { action: 'sleep-cover', sleepProfile: { ...person, avatarPath }, sleepStats })).image
      } finally { await this.coverReader.close() }
    })
  }

  async discard(id: string) {
    const book = this.book(id)
    if (
      book.library ||
      this.store.list<TransferJob>('jobs').some((job) => job.candidateId === id && job.status !== 'cancelled')
    )
      throw new Error('这本书已入库或存在发送任务，请保留文件供任务使用。')
    this.store.remove('candidates', id)
    await rm(path.dirname(book.path), { recursive: true, force: true })
    this.notify()
  }

  async collect(id: string) {
    const task = this.importQueue.then(() => this.collectInternal(id))
    this.importQueue = task.catch(() => {})
    return task
  }

  private async collectInternal(id: string) {
    const book = this.book(id)
    if (book.library) return
    if (contentHash(await readFile(book.path)) !== book.sha256) throw new Error('文件已经改变，请重新导入。')
    const destinationDirectory = path.join(this.directory, 'library', book.sha256)
    await mkdir(destinationDirectory, { recursive: true })
    const destination = path.join(destinationDirectory, book.filename)
    await copyFile(book.path, destination)
    let calibreId: number | undefined
    if (this.snapshot().tools.calibre) {
      const library = path.join(this.directory, 'calibre-library')
      const output = await this.calibre('calibre-debug.exe', [
        '--exec-file',
        path.join(this.options.nativeDirectory, 'CalibreImport.py'),
        '--',
        library,
        destination,
        book.sha256,
      ])
      const result = output.match(/KINDLESPOUSE_RESULT\s+(\{[^\n]+\})/)
      if (!result) throw new Error('Calibre 未返回入库结果，请检查程序目录。')
      calibreId = JSON.parse(result[1]).id
    }
    this.store.put('candidates', id, { ...this.book(id), path: destination, library: true, calibreId })
    this.notify()
  }

  private async checkUrl(value: string) {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('请输入 HTTP/HTTPS 下载链接。')
    if (this.options.allowLocalDownloads) return url
    const addresses = await lookup(url.hostname, { all: true })
    if (
      !addresses.length ||
      addresses.some(({ address }) =>
        /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80|::ffff:)/i.test(address),
      )
    )
      throw new Error('下载链接不能指向本机或内网地址。')
    return url
  }

  async download(value: string) {
    let url = await this.checkUrl(value)
    const task: DownloadTask = { id: randomUUID(), label: url.hostname, bytes: 0, total: 0, status: 'downloading' }
    this.downloads.unshift(task)
    this.downloads = this.downloads.slice(0, 20)
    this.notify()
    const root = path.join(this.directory, 'scratch')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(path.join(root, 'download-'))
    try {
      let response: Response | undefined
      for (let redirect = 0; redirect < 8; redirect++) {
        response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(120000),
          headers: { 'User-Agent': 'KindleSpouse/0.1' },
        })
        if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
          await response.body?.cancel()
          url = await this.checkUrl(new URL(response.headers.get('location')!, url).href)
          continue
        }
        break
      }
      if (!response?.ok || !response.body)
        throw new Error(`下载失败（HTTP ${response?.status ?? 0}），可改从书源网页下载。`)
      task.total = Number(response.headers.get('content-length') ?? 0)
      if (task.total > MAX_BOOK_BYTES) throw new Error('文件超过 200 MB 上限。')
      const disposition = response.headers.get('content-disposition') ?? ''
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
      const filename = encodedName
        ? decodeURIComponent(encodedName)
        : (plainName ?? decodeURIComponent(path.posix.basename(url.pathname)))
      const extension = bookFormatFromFilename(filename) ?? formatFromMimeType(response.headers.get('content-type') ?? '')
      if (/text\/html/i.test(response.headers.get('content-type') ?? '') && !['html', 'htm', 'xhtml'].includes(extension ?? '')) throw new Error('这个链接返回的是网页，请打开书源后点击实际下载按钮。')
      if (!isKoreaderFormat(extension)) throw new Error('这个下载没有返回可识别的书籍文件，请使用实际文件链接。')
      const destination = path.join(directory, safeFilename(filename, extension))
      let lastUpdate = 0
      const limiter = new Transform({
        transform: (chunk, encoding, callback) => {
          task.bytes += chunk.length
          if (task.bytes > MAX_BOOK_BYTES) {
            callback(new Error('下载超过 200 MB，已停止。'))
            return
          }
          if (Date.now() - lastUpdate > 250) {
            lastUpdate = Date.now()
            this.notify()
          }
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination))
      task.status = 'checking'
      this.notify()
      await this.importFile(destination, url.hostname)
      task.status = 'complete'
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      await rm(directory, { recursive: true, force: true })
      this.notify()
    }
  }

  async connectCloud(provider: 'drive' | 'onedrive') {
    if (this.sync.snapshot().pairing) throw new Error('请先完成设备配对授权。')
    if (this.cloudConnecting) throw new Error('另一个网盘正在授权，请先完成。')
    this.cloudConnecting = provider
    this.notify()
    try {
      const account = await this.cloud.connect(provider)
      this.store.put('clouds', account.id, account)
      if (kindleMode(this.settings) === 'koreader') {
        this.sync.markPreferencesPending()
        void this.publishPreferences().catch(() => {})
      }
    } finally {
      this.cloudConnecting = undefined
      this.notify()
    }
  }

  async downloadCloud(accountId: string, remotePath: string) {
    const directory = await mkdtemp(path.join(await this.scratch(), 'cloud-download-'))
    try {
      const destination = path.join(directory, path.posix.basename(safeRemotePath(remotePath)))
      await this.cloud.download(accountId, remotePath, destination)
      const id = await this.importFile(destination, this.store.get<CloudAccount>('clouds', accountId)?.name ?? '网盘')
      this.store.put('discovery-files', `cloud:${accountId}:${safeRemotePath(remotePath)}`, { id: `cloud:${accountId}:${safeRemotePath(remotePath)}`, candidateId: id, sha256: this.book(id).sha256 })
      this.notify()
      return id
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async downloadSource(id: string, hash?: string) {
    const directory = await mkdtemp(path.join(await this.scratch(), 'source-download-'))
    const task: DownloadTask = { id: randomUUID(), label: 'Z-Library 下载', bytes: 0, total: 0, status: 'downloading' }
    this.downloads.unshift(task)
    this.downloads = this.downloads.slice(0, 20)
    this.notify()
    try {
      const filename = await this.source.download(id, hash, this.settings.sourceUrl, directory, bytes => {
        task.bytes = bytes
        this.notify()
      })
      task.bytes = (await stat(filename)).size
      task.total = task.bytes
      task.status = 'checking'
      this.notify()
      const bookId = await this.importFile(filename, 'Z-Library')
      this.store.put('discovery-files', `zlib:${id}:${hash ?? ''}`, { id: `zlib:${id}:${hash ?? ''}`, candidateId: bookId, sha256: this.book(bookId).sha256 })
      task.label = this.book(bookId).title
      task.status = 'complete'
      return bookId
    } catch (error) {
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : '书源下载未完成。'
      throw error
    } finally {
      await rm(directory, { recursive: true, force: true })
      this.notify()
    }
  }

  updateBook(id: string, fields: { collection?: string; finished?: boolean; title?: string; author?: string }) {
    this.store.put('candidates', id, { ...this.book(id), ...fields })
    this.notebookLibrary.linkBooks()
    this.notify()
  }

  recordReading(session: ReadingSession) {
    this.history.record(session)
    this.notify()
  }

  editNote(id: string, note: string, deleted: boolean) { editNote(this.store, id, note, deleted); this.notify() }
  restoreNote(id: string) { restoreNote(this.store, id); this.notify() }

  async checkCloud(id: string) {
    const account = this.store.get<CloudAccount>('clouds', id)
    if (!account) throw new Error('找不到网盘账号。')
    try {
      await this.cloud.list(id, '')
      this.store.put('clouds', id, {
        ...account,
        connected: true,
        checkedAt: new Date().toISOString(),
        error: undefined,
      })
    } catch {
      this.store.put('clouds', id, {
        ...account,
        connected: false,
        checkedAt: new Date().toISOString(),
        error: '网盘授权或连接不可用，请重新连接。',
      })
      throw new Error('网盘授权或连接不可用，请重新连接。')
    } finally {
      this.notify()
    }
  }

  async searchDiscovery(query: string, scope?: DiscoveryScope) {
    const catalog = scope === undefined || scope === 'catalog'
    const source = scope === undefined || scope === 'files' || scope === 'source'
    const cloud = scope === undefined || scope === 'files' || scope === 'cloud'
    const normalized = query.trim().toLocaleLowerCase()
    const results: DiscoveryResult[] = this.snapshot()
      .candidates.filter((book) => catalog &&
        `${book.title} ${book.author} ${book.isbn ?? ''}`.toLocaleLowerCase().includes(normalized),
      )
      .map((book) => ({
        id: `local:${book.id}`,
        title: book.title,
        author: book.author,
        source: 'local',
        bookId: book.id,
        format: book.format,
        cover: book.cover,
        size: book.bytes,
      }))
    const warnings: string[] = []
    const operations: Promise<unknown>[] = []
    if (catalog) operations.push((this.options.douban ?? this.douban).search(query).then((books) => { results.push(...books) }).catch((error) => warnings.push(error instanceof Error ? error.message : '豆瓣暂时无法搜索。')))
    if (source && this.source.hasSession(this.settings.sourceUrl))
      operations.push(
        this.source
          .search(query, this.settings.sourceUrl)
          .then((books) => {
            results.push(
              ...books.map((book) => ({
                id: `zlib:${book.id}:${book.hash ?? ''}`,
                title: book.name,
                author: book.authors?.join('、') ?? '',
                source: 'zlib' as const,
                sourceBook: book,
                format: book.extension,
                edition: [book.publisher, book.year].filter(Boolean).join(' · '),
              })),
            )
          })
          .catch((error) => warnings.push(error instanceof Error ? error.message : '书源暂时无法搜索，请检查登录或连接。')),
      )
    else if (source) warnings.push('登录书源后可搜索下载版本；豆瓣提供书目和书评。')
    for (const account of this.store.list<CloudAccount>('clouds').filter((account) => cloud && account.connected)) {
      operations.push(
        this.cloud
          .search(account.id, query, this.settings.cloudFolder)
          .then((items) => {
            results.push(
              ...items.map((item) => ({
                id: `cloud:${account.id}:${item.path}`,
                title: stripBookExtension(item.name),
                author: account.name,
                source: 'cloud' as const,
                cloudId: account.id,
                remotePath: item.path,
                format: bookFormatFromFilename(item.path),
                size: item.size,
              })),
            )
          })
          .catch(() => warnings.push(`${account.name} 搜索暂不可用。`)),
      )
    }
    await Promise.allSettled(operations)
    return { results, warnings }
  }

  async recoverLibrary() {
    if (this.recovery?.working) return
    this.recovery = { working: true, books: 0, message: '正在检查私有备份' }
    this.notify()
    try {
      const root = path.join(this.directory, 'device-backups')
      const snapshots = (await readdir(root, { withFileTypes: true }).catch(() => []))
        .filter((item) => item.isDirectory() && existsSync(path.join(root, item.name, 'snapshot-manifest.json')))
        .sort((a, b) => b.name.localeCompare(a.name))
      for (const item of snapshots) await this.indexSnapshot(path.join(root, item.name))
      const cloudRoot = path.join(this.directory, 'cloud-snapshots')
      for (const device of await readdir(cloudRoot, { withFileTypes: true }).catch(() => [])) {
        if (!device.isDirectory()) continue
        const base = path.join(cloudRoot, device.name)
        for (const item of await readdir(base, { withFileTypes: true }))
          if (item.isDirectory() && existsSync(path.join(base, item.name, 'snapshot-manifest.json')))
            await this.indexSnapshot(path.join(base, item.name))
      }
      for (const base of ['candidates', 'library']) {
        const directory = path.join(this.directory, base)
        for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          if (!item.isDirectory()) continue
          const folder = path.join(directory, item.name)
          for (const filename of (await readdir(folder)).filter(isKoreaderFilename)) {
            try {
              const id = await this.importFile(path.join(folder, filename), '本机恢复')
              if (base === 'library') this.store.put('candidates', id, { ...this.book(id), library: true })
            } catch {}
          }
        }
      }
      this.notebookLibrary.linkBooks()
      this.recovery = { working: false, books: this.snapshot().candidates.length, message: '书库索引已恢复' }
    } catch (error) {
      this.recovery = {
        working: false,
        books: this.snapshot().candidates.length,
        error: error instanceof Error ? error.message : String(error),
      }
      throw error
    } finally {
      this.notify()
    }
  }

  private async scratch() {
    const directory = path.join(this.directory, 'scratch')
    await mkdir(directory, { recursive: true })
    return directory
  }

  async approve(approval: Approval) {
    const book = this.book(approval.candidateId)
    if (!isKoreaderFormat(book.format)) throw new Error('当前 KOReader 不支持这份原始档案，请先选择可阅读的版本。')
    if (this.previewed.get(book.id) !== book.sha256) throw new Error('请先打开这份文件试读，再确认发送。')
    return this.enqueueTransfer(approval)
  }

  private async enqueueTransfer(approval: Approval, batchId?: string, cloudFolder = this.settings.cloudFolder) {
    const book = this.book(approval.candidateId)
    if (!isKoreaderFormat(book.format)) throw new Error('当前 KOReader 不支持这份原始档案，请先选择可阅读的版本。')
    if (approval.sha256 !== book.sha256 || contentHash(await readFile(book.path)) !== approval.sha256)
      throw new Error('确认的文件与当前文件不一致，请重新试读。')
    if (approval.method === 'kindle-email') {
      if (kindleMode(this.settings) !== 'native') throw new Error('请先在设备设置中选择原生模式。')
      if (!this.kindleMail.state()?.configured) throw new Error('请先完成 Send to Kindle 发件设置和连接测试。')
      if (!kindleMailFormat(book.format)) throw new Error('Send to Kindle 不支持此格式，请选择 EPUB、PDF 或其他支持的版本。')
      if (book.bytes > KINDLE_MAIL_MAX_BYTES) throw new Error('文件超过 25 MiB 邮件上限，请使用官方网页上传。')
    }
    if (approval.method === 'native-cloud' && !nativeCloudAvailable(this.settings)) throw new Error('当前型号未确认支持官方网盘导入，请使用邮件发送。')
    if (approval.method === 'native-cloud' && !kindleMailFormat(book.format)) throw new Error('请先选择 EPUB、PDF 或其他官方网盘支持的文件格式。')
    if (approval.method === 'native-cloud' && !this.store.get<CloudAccount>('clouds', approval.cloudAccountId ?? '')?.connected) throw new Error('请先连接并选择 Google Drive 或 OneDrive。')
    if (approval.method === 'cloud' && !this.store.get<CloudAccount>('clouds', approval.cloudAccountId ?? ''))
      throw new Error('请先连接并选择 Google Drive 或 OneDrive。')
    if (approval.method === 'cloud' && !['epub', 'pdf'].includes(book.format) && this.store.list<SyncDevice>('sync-devices').some(device => device.accountId === approval.cloudAccountId && device.status !== 'revoked' && (device.bookFormatsVersion ?? 1) < 2)) throw new Error('Kindle 同步组件尚未确认支持此格式。请更新设备组件并从网盘读取一次回执，再确认上传。电脑试读可正常使用。')
    if (approval.method === 'opds' && !this.catalog.info) throw new Error('请先在连接设置中启用无线书目。')
    const target =
      approval.method === 'kindle-email'
        ? this.kindleMail.state()!.recipient
        : approval.method === 'cloud' || approval.method === 'native-cloud'
        ? approval.cloudAccountId!
        : approval.method === 'usb'
          ? (approval.deviceId ?? 'first-connected')
          : 'opds'
    const duplicate = this.store
      .list<TransferJob>('jobs')
      .find(
        (job) =>
          job.candidateId === book.id &&
          job.sha256 === book.sha256 &&
          job.method === approval.method &&
          job.target === target &&
          (approval.method !== 'kindle-email' || job.mailRevision === this.kindleMail.revision()) &&
          (!['cloud', 'native-cloud'].includes(approval.method) || job.remotePath === safeRemotePath(`${cloudFolder}/${transferFilename(book.title, book.sha256, book.format)}`) || job.status === 'cloud_ready' && path.posix.dirname(job.remotePath ?? '') === safeRemotePath(cloudFolder)) &&
          job.status !== 'cancelled',
      )
    if (duplicate) return duplicate.id
    const remotePath =
      approval.method === 'cloud' || approval.method === 'native-cloud'
        ? safeRemotePath(
            `${cloudFolder}/${transferFilename(book.title, book.sha256, book.format)}`,
          )
        : undefined
    const job: TransferJob = {
      id: randomUUID(),
      ...(batchId ? { batchId } : {}),
      candidateId: book.id,
      title: book.title,
      sha256: book.sha256,
      method: approval.method,
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      target,
      cloudAccountId: approval.cloudAccountId,
      remotePath,
      ...(approval.method === 'kindle-email' ? { mailRevision: this.kindleMail.revision() } : {}),
    }
    this.store.put('jobs', job.id, job)
    this.notify()
    if (!batchId) void this.processJobs()
    return job.id
  }

  syncLibraryToCloud(accountId: string) {
    if (!this.store.get<CloudAccount>('clouds', accountId)?.connected) throw new Error('请先连接要同步的网盘。')
    if (this.libraryPreparation) {
      if (this.libraryCloudSync?.accountId !== accountId) throw new Error('请先等待当前书库准备完成。')
      return this.libraryCloudSync!.id
    }
    const books = this.store.list<StoredCandidate>('candidates').filter(book => book.library && isLibraryBook(book))
    const originals = new Set(books.filter(book => !book.derivedFromHash).map(book => book.sha256))
    const targets = books.filter(book => !book.derivedFromHash || !originals.has(book.derivedFromHash))
    const cloudFolder = this.settings.cloudFolder
    const status = { id: randomUUID(), accountId, working: true, total: targets.length, prepared: 0, queued: 0, skipped: 0, failures: [] as NonNullable<AppState['libraryCloudSync']>['failures'], currentTitle: undefined as string | undefined, error: undefined as string | undefined }
    this.libraryCloudSync = status
    const update = () => { this.store.put('library-cloud-sync', 'main', status); this.notify() }
    update()
    this.libraryPreparation = (async () => {
      try {
        await this.sync.ensureBookFolder(accountId)
        const hashes = new Set<string>()
        for (const original of targets) {
          if (this.closing) { status.error = '书库准备已暂停，重新同步会跳过已完成文件。'; break }
          status.currentTitle = original.title
          update()
          try {
            const checked = await this.checkNativeReadability(original)
            if (original.isSample) throw new Error('这是试读样章，未作为完整图书同步。')
            if (checked.warnings.some(warning => /平台 DRM/.test(warning))) throw new Error('此文件受平台保护，原件已保留。')
            const book = await this.readableBook(original.id)
            if (hashes.has(book.sha256)) { status.skipped++; continue }
            hashes.add(book.sha256)
            const existing = new Set(this.store.list<TransferJob>('jobs').map(job => job.id))
            const id = await this.enqueueTransfer({ candidateId: book.id, sha256: book.sha256, method: 'cloud', cloudAccountId: accountId }, status.id, cloudFolder)
            const job = this.store.get<TransferJob>('jobs', id)!
            if (existing.has(id) && job.status !== 'failed') status.skipped++
            else {
              if (job.status === 'failed') this.updateJob(id, { status: 'queued', progress: 0, error: undefined, batchId: status.id })
              status.queued++
            }
            if (status.queued > 0 && status.queued % 8 === 0) void this.processJobs()
          } catch (error) { status.failures.push({ candidateId: original.id, title: original.title, error: error instanceof Error ? error.message : String(error) }) }
          finally { status.prepared++; update() }
        }
      } catch (error) { status.error = error instanceof Error ? error.message : String(error) }
      finally { status.working = false; status.currentTitle = undefined; update(); void this.processJobs() }
    })().finally(() => { this.libraryPreparation = undefined })
    return status.id
  }

  async refreshBookReceipts() {
    const accounts = [...new Set(this.store.list<TransferJob>('jobs').filter(job => job.method === 'cloud' && job.status === 'cloud_ready' && !job.deviceReceivedAt && job.cloudAccountId).map(job => job.cloudAccountId!))]
    for (const id of accounts) await this.sync.refreshBookReceipts(id)
  }

  private updateJob(id: string, fields: Partial<TransferJob>) {
    const job = this.store.get<TransferJob>('jobs', id)
    if (!job) return
    this.store.put('jobs', id, { ...job, ...fields })
    this.notify()
  }

  processJobs() {
    this.processAgain = true
    if (this.processing) return this.processing
    this.processing = this.drainJobs().finally(() => {
      this.processing = undefined
      if (this.processAgain) void this.processJobs()
    })
    return this.processing
  }

  private async drainJobs() {
    do {
      this.processAgain = false
      await this.processQueuedJobs()
    } while (this.processAgain)
  }

  private async processQueuedJobs() {
    if (this.working) return
    this.working = true
    try {
      for (const job of this.store
        .list<TransferJob>('jobs')
        .filter((entry) => ['queued', 'waiting_device'].includes(entry.status))) {
        if (this.closing) break
        try {
          if (!['queued', 'waiting_device'].includes(this.store.get<TransferJob>('jobs', job.id)?.status ?? '')) continue
          if (job.method === 'cloud' && job.batchId) {
            await this.processCloudBatch(this.store.list<TransferJob>('jobs').filter(entry => entry.batchId === job.batchId && entry.cloudAccountId === job.cloudAccountId && entry.method === 'cloud' && entry.status === 'queued').slice(0, 8))
            continue
          }
          if (job.method === 'usb') {
            this.devices = await this.transport.list()
            if (this.store.get<TransferJob>('jobs', job.id)?.status === 'cancelled') continue
            const device =
              job.target === 'first-connected' ? this.devices[0] : this.devices.find((item) => item.id === job.target)
            if (!device) {
              this.updateJob(job.id, {
                status: 'waiting_device',
                message: '请保存并退出 KOReader，连接 USB 后点击重试。',
              })
              continue
            }
            if (job.target === 'first-connected') {
              job.target = device.id
              this.updateJob(job.id, { target: device.id })
            }
          }
          this.updateJob(job.id, { status: 'importing', progress: 0.1, error: undefined, message: '正在加入正式书库' })
          await this.collect(job.candidateId)
          const book = this.book(job.candidateId)
          if (contentHash(await readFile(book.path)) !== job.sha256)
            throw new Error('发送前校验发现文件变化，请重新导入。')
          if (job.method === 'usb') {
            this.updateJob(job.id, { status: 'transferring', progress: 0.35, message: '正在传输，完成后回读校验' })
            await this.transport.upload(
              job.target,
              book.path,
              transferFilename(book.title, book.sha256, book.format),
              job.sha256,
            )
            this.updateJob(job.id, {
              status: 'sent',
              progress: 1,
              verifiedAt: new Date().toISOString(),
              message: '已回读校验，位于 Books/Inbox',
            })
          } else if (job.method === 'kindle-email') {
            const bytes = await readFile(book.path)
            if (contentHash(bytes) !== job.sha256) throw new Error('邮件附件已变化，停止发送。请重新导入并试读。')
            this.updateJob(job.id, { status: 'transferring', progress: 0.4, message: '正在通过加密邮件发送原文件' })
            await this.kindleMail.send({ title: book.title, format: book.format, bytes }, job.mailRevision!, job.target, job.id)
            this.updateJob(job.id, { status: 'email_submitted', progress: 1, message: '邮件服务已接受；等待 Amazon 处理，不代表设备已收到' })
          } else if (job.method === 'cloud' || job.method === 'native-cloud') {
            const remotePath =
              job.remotePath ??
              safeRemotePath(
                `${this.settings.cloudFolder}/${transferFilename(book.title, book.sha256, book.format)}`,
              )
            this.updateJob(job.id, { status: 'transferring', progress: 0.35, remotePath, message: '正在上传到网盘' })
            await this.cloud.uploadAndVerify(job.cloudAccountId!, book.path, remotePath, job.sha256, () =>
              this.updateJob(job.id, { status: 'verifying', progress: 0.8, message: '已上传，正在从网盘重新下载校验' }),
            )
            if (job.method === 'cloud') await this.sync.publishBook(job, book, remotePath)
            this.updateJob(job.id, {
              status: job.method === 'native-cloud' ? 'native_cloud_ready' : 'cloud_ready',
              progress: 1,
              verifiedAt: new Date().toISOString(),
              message: job.method === 'native-cloud' ? '网盘文件已校验；请在 Kindle 的 Connections 中手动导入，不会自动收书' : '已上传到网盘并校验；Kindle 联网且 KOReader 运行时自动收书',
            })
          } else
            this.updateJob(job.id, {
              status: 'published',
              progress: 1,
              message: '已确认，可在 Kindle 的 OPDS 中下载；尚无设备落盘回执',
            })
        } catch (error) {
          this.updateJob(job.id, {
            status: error instanceof KindleMailError && error.uncertain ? 'delivery_unknown' : 'failed',
            error: error instanceof Error ? error.message : String(error),
            message: undefined,
          })
        }
      }
    } finally {
      this.working = false
    }
  }

  private async processCloudBatch(jobs: TransferJob[]) {
    const valid: { job: TransferJob; book: StoredCandidate; remotePath: string }[] = []
    for (const job of jobs) {
      try {
        this.updateJob(job.id, { status: 'importing', progress: 0.1, error: undefined, message: '正在准备书库同步' })
        const book = this.book(job.candidateId)
        if (book.bytes > MAX_BOOK_BYTES || contentHash(await readFile(book.path)) !== job.sha256) throw new Error('发送前发现文件变化或超出大小上限，已保留原文件。')
        await this.collect(book.id)
        valid.push({ job, book, remotePath: job.remotePath! })
        this.updateJob(job.id, { status: 'transferring', progress: 0.35, message: '正在批量上传到网盘' })
      } catch (error) { this.updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }) }
    }
    if (!valid.length) return
    try {
      const folder = path.posix.dirname(valid[0].remotePath)
      if (valid.some(item => path.posix.dirname(item.remotePath) !== folder)) throw new Error('批量任务的网盘目录不一致。')
      await this.cloud.uploadManyAndVerify(valid[0].job.cloudAccountId!, folder, valid.map(({ book, remotePath }) => ({ source: book.path, name: path.posix.basename(remotePath), sha256: book.sha256 })), () => {
        for (const { job } of valid) this.updateJob(job.id, { status: 'verifying', progress: 0.8, message: '正在批量回读网盘并校验' })
      })
      await this.sync.publishBooks(valid)
      for (const { job } of valid) this.updateJob(job.id, { status: 'cloud_ready', progress: 1, verifiedAt: new Date().toISOString(), message: '已上传网盘并校验，等待 Kindle 联网自动收书' })
    } catch (error) {
      for (const { job } of valid) this.updateJob(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error), message: undefined })
    }
  }

  async retry(id: string) {
    const job = this.store.get<TransferJob>('jobs', id)
    if (!job || !(['failed', 'waiting_device', 'delivery_unknown'].includes(job.status) || job.method === 'kindle-email' && job.status === 'email_submitted')) throw new Error('这个任务当前不需要重试。')
    this.updateJob(id, { status: 'queued', error: undefined, progress: 0 })
    void this.processJobs()
  }

  async cancel(id: string) {
    const job = this.store.get<TransferJob>('jobs', id)
    if (!job || !['queued', 'waiting_device', 'failed', 'delivery_unknown'].includes(job.status))
      throw new Error('正在传输时请等待校验完成。')
    this.updateJob(id, { status: 'cancelled', message: '已取消，书籍仍保留在本机', error: undefined })
  }

  async refreshDevices() {
    this.devices = await this.transport.list()
    this.notify()
    void this.processJobs()
    if (this.initialImport?.status === 'failed') this.updateInitialImport({ status: 'waiting_device', error: undefined, message: '正在重新检查 Kindle 连接' })
    this.scheduleInitialImport()
  }

  private updateInitialImport(fields: Partial<NonNullable<AppState['initialImport']>>) {
    if (!this.initialImport) return
    this.initialImport = { ...this.initialImport, ...fields }
    this.store.put('initial-import', 'main', this.initialImport)
    this.notify()
  }

  startInitialImport() {
    this.initialImportStarted = true
    this.scheduleInitialImport()
  }

  private scheduleInitialImport() {
    if (!this.initialImportStarted || this.closing || !this.settings.onboardingComplete || this.initialImport?.status !== 'waiting_device') return
    if (this.initialImportTask) { this.initialImportAgain = true; return }
    clearTimeout(this.initialImportTimer)
    this.initialImportTask = this.readInitialLibrary().finally(() => {
      this.initialImportTask = undefined
      if (!this.closing && this.initialImport?.status === 'waiting_device') {
        if (this.initialImportAgain) { this.initialImportAgain = false; this.scheduleInitialImport(); return }
        this.initialImportTimer = setTimeout(() => this.scheduleInitialImport(), 15000)
        this.initialImportTimer.unref()
      }
    })
  }

  private async readInitialLibrary() {
    const model = this.initialImport?.model
    try {
      if (this.deviceImport && !this.deviceImport.finished || this.notesImport?.working || this.recovery?.working || this.sync.snapshot().working) return
      const devices = await this.transport.list()
      if (this.closing || this.initialImport?.model !== model) return
      this.devices = devices
      if (!devices[0]) {
        this.updateInitialImport({ message: kindleMode(this.settings) === 'native' ? '等待连接 Kindle：用 USB 接线后会自动导入书籍和笔记。邮件传书无法读取设备文件。' : '等待连接 Kindle：首次整库导入请退出 KOReader 并接上 USB；之后笔记与阅读记录仍通过网盘同步。' })
        return
      }
      if (devices.length > 1) throw new Error('检测到多台 Kindle，请只连接需要导入的那一台后重试。')
      this.updateInitialImport({ status: 'reading', error: undefined, message: '正在自动导入 Kindle 书籍、笔记与标注，请保持 USB 连接。' })
      await this.importDevice(true, devices[0].id)
      this.updateInitialImport({ status: 'complete', books: (this.initialImport?.books ?? 0) + (this.deviceImport?.imported ?? 0), notebooks: this.notesImport?.notebooks ?? 0, annotations: this.notesImport?.annotations ?? 0, unreadable: this.notesImport?.unreadable ?? 0, message: 'Kindle 可访问的文件已复制到本机；书籍与笔记分别归档，设备原件保持不变。' })
    } catch (error) {
      this.updateInitialImport({ status: 'failed', books: (this.initialImport?.books ?? 0) + (this.initialImport?.status === 'reading' ? this.deviceImport?.imported ?? 0 : 0), error: error instanceof Error ? error.message : String(error), message: '自动导入未完成，已导入的资料仍保留。请检查连接后重试。' })
    }
  }

  async importDevice(includeNotes = false, deviceId?: string) {
    if (this.deviceImport && !this.deviceImport.finished) throw new Error('正在读取 Kindle 书库，请等待当前操作完成。')
    if (this.notesImport?.working) throw new Error('正在读取 Kindle 笔记，请等待当前操作完成。')
    this.deviceImport = { stage: '正在准备私有书库快照', files: 0, imported: 0, archived: 0 }
    this.notify()
    let snapshot: string | undefined
    try {
      const root = path.join(this.directory, 'device-backups')
      await mkdir(root, { recursive: true })
      const connected = includeNotes ? await this.transport.list() : undefined
      const selected = connected?.find(device => device.id === deviceId) ?? (!deviceId ? connected?.[0] : undefined)
      if (includeNotes && !selected) throw new Error('Kindle 连接已断开，请重新接线后重试。')
      const prefix = includeNotes ? `snapshot-full-${contentHash(Buffer.from(selected!.id)).slice(0, 16)}-` : 'snapshot-'
      const pending = (await readdir(root, { withFileTypes: true }))
        .filter(
          (item) =>
            item.isDirectory() &&
            item.name.startsWith(prefix) &&
            existsSync(path.join(root, item.name, 'snapshot-manifest.json')) &&
            !this.store.get('device-snapshots', item.name),
        )
        .sort((a, b) => b.name.localeCompare(a.name))[0]
      if (pending) snapshot = path.join(root, pending.name)
      else {
        const device = selected ?? (await this.transport.list())[0]
        if (!device || !(includeNotes ? this.transport.exportNotes : this.transport.export)) throw new Error('请连接 Kindle USB 后重试；使用 KOReader 时请先保存并退出。')
        snapshot = path.join(root, `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}`)
        this.deviceImport.stage = '正在复制文章、原始书籍和阅读资料'
        this.notify()
        if (includeNotes) await this.transport.exportNotes!(device.id, snapshot)
        else await this.transport.export!(device.id, snapshot)
      }
      await this.indexSnapshot(snapshot, !includeNotes)
      if (includeNotes) {
        this.deviceImport.finished = false
        this.deviceImport.stage = '正在整理笔记与书籍标注'
        this.notify()
        const result = await this.notebookLibrary.importSnapshot(snapshot)
        this.notesImport = { ...result, working: false, message: '笔记与标注已自动导入本机' }
      }
      this.deviceImport.stage = includeNotes ? this.notesImport?.unreadable ? `书籍已导入，${this.notesImport.unreadable} 份笔记资料暂时无法解析，原件已保留` : '书籍、笔记与标注已分别导入本机' : 'Kindle 书库已导入，原始资料已保存在本机'
      this.deviceImport.finished = true
      this.notify()
    } catch (error) {
      if (includeNotes && snapshot) this.store.remove('device-snapshots', path.basename(snapshot))
      this.deviceImport.stage = error instanceof Error ? error.message : String(error)
      this.deviceImport.finished = true
      this.deviceImport.failed = true
      this.notify()
      throw error
    }
  }

  private async indexSnapshot(snapshot: string, finished = true) {
    const manifest = JSON.parse(await readFile(path.join(snapshot, 'snapshot-manifest.json'), 'utf8')) as {
      createdAt: string
      files: { relative: string; bytes: number; sha256: string }[]
    }
    this.deviceImport ??= { stage: '恢复书库索引', files: 0, imported: 0, archived: 0 }
    this.deviceImport.files = manifest.files.length
    this.deviceImport.stage = '正在读取书名、作者与封面'
    this.notify()
    let entries: {
      relative: string
      bytes: number
      sha256: string
      title: string
      author: string
      format: BookFormat
      language?: string
      cover?: string
      metadataLimited?: boolean
    }[]
    if (this.snapshot().tools.calibre) {
      const output = await this.calibre(
        'calibre-debug.exe',
        ['--exec-file', path.join(this.options.nativeDirectory, 'ReadDeviceLibrary.py'), '--', snapshot, JSON.stringify([...KOREADER_EXTENSIONS, 'azw3', 'azw6', 'kfx', 'kpf'])],
        600000,
      )
      const match = output.match(/KINDLESPOUSE_LIBRARY\s+(\[[^\n]*\])/)
      if (!match) throw new Error('读取书库元数据失败，原始快照已保留。')
      entries = JSON.parse(match[1])
    } else {
      entries = manifest.files
        .filter(
          (file) =>
            Boolean(bookFormatFromFilename(file.relative)) &&
            deviceContentRole(file.relative) === 'book',
        )
        .map((file) => ({
          ...file,
          title: stripBookExtension(path.basename(file.relative)),
          author: '作者信息未提供',
          format: bookFormatFromFilename(file.relative)!,
          metadataLimited: true,
        }))
    }
    const existing = new Map(this.store.list<StoredCandidate>('candidates').map((book) => [book.sha256, book]))
    for (const entry of entries) {
      if (deviceContentRole(entry.relative) !== 'book') continue
      const filename = path.resolve(snapshot, entry.relative)
      if (!filename.startsWith(snapshot + path.sep)) throw new Error('快照目录包含无效路径。')
      if ((await stat(filename)).size !== entry.bytes || contentHash(await readFile(filename)) !== entry.sha256)
        throw new Error('快照文件校验不一致，原件已保留，请重新读取。')
      if (existing.has(entry.sha256)) {
        const book = existing.get(entry.sha256)!
        if (!book.library) this.store.put('candidates', book.id, { ...book, library: true })
        continue
      }
      const id = randomUUID()
      const warnings = ['已保存 Kindle 原始文件；相关阅读资料保留在本机私有快照中。']
      if (!isKoreaderFormat(entry.format))
        warnings.push('这是 Kindle 原始格式。预览需要受支持的格式转换，平台加密内容只能保留原件。')
      if (entry.metadataLimited) warnings.push('此文件的部分元数据暂时无法读取。')
      const book: StoredCandidate = {
        id,
        title: entry.title,
        author: entry.author,
        format: entry.format,
        filename: path.basename(filename),
        path: filename,
        sha256: entry.sha256,
        bytes: entry.bytes,
        createdAt: manifest.createdAt,
        source: 'Kindle 私有导入',
        chapters: 0,
        warnings,
        library: true,
        fromDevice: true,
        language: entry.language,
        cover: entry.cover,
        progress: 0,
      }
      this.store.put('candidates', id, book)
      existing.set(book.sha256, book)
      this.deviceImport.imported++
      if (!isKoreaderFormat(book.format)) this.deviceImport.archived++
    }
    this.store.put('device-snapshots', path.basename(snapshot), {
      directory: snapshot,
      files: manifest.files.length,
      importedAt: new Date().toISOString(),
    })
    this.deviceImport.stage = 'Kindle 书库已导入，原始资料已保存在本机'
    this.deviceImport.finished = finished
    this.notify()
    this.notebookLibrary.linkBooks()
  }

  async saveSettings(settings: Partial<Settings>) {
    if (settings.deviceModel !== undefined && !KINDLE_MODELS.some(model => model.id === settings.deviceModel)) throw new Error('请选择列表中的设备型号。')
    const next = { ...this.settings, ...settings }
    if (this.initialImport?.status === 'reading' && next.deviceModel !== this.initialImport.model) throw new Error('正在导入 Kindle 文件，请等待导入完成后再更换设备型号。')
    if (settings.kindleMode !== undefined && settings.kindleMode !== this.settings.kindleMode) next.readerEngine = settings.kindleMode === 'native' ? 'browser' : settings.readerEngine ?? 'koreader'
    if (kindleMode(next) === 'native') next.readerEngine = 'browser'
    if (kindleMode(next) === 'native' && !nativeCloudAvailable(next)) next.nativeDelivery = 'kindle-email'
    if (settings.onboardingComplete && !next.deviceModel) throw new Error('请先选择设备型号。')
    if (settings.onboardingComplete && kindleMode(next) === 'native') {
      if (nativeDelivery(next) === 'kindle-email' && !this.kindleMail.state()?.configured) throw new Error('请先完成发件邮箱设置和连接测试；也可以稍后继续向导。')
      if (nativeDelivery(next) === 'native-cloud' && !this.store.get<CloudAccount>('clouds', next.defaultCloudId ?? '')?.connected) throw new Error('请先连接并选择默认网盘。')
    }
    if (settings.avatarImage) avatarAsset(settings.avatarImage)
    if (settings.sourceUrl && new URL(settings.sourceUrl).protocol !== 'https:')
      throw new Error('书源地址需要使用 HTTPS。')
    if (settings.cloudFolder !== undefined) safeRemotePath(settings.cloudFolder)
    if (
      settings.cloudFolder !== undefined &&
      (!safeRemotePath(settings.cloudFolder) ||
        safeRemotePath(settings.cloudFolder) === this.sync.root() ||
        safeRemotePath(settings.cloudFolder).startsWith(this.sync.root() + '/') ||
        this.sync.root().startsWith(safeRemotePath(settings.cloudFolder) + '/'))
    )
      throw new Error('传书目录需要独立于专用同步目录。')
    if (settings.defaultCloudId && !this.store.get('clouds', settings.defaultCloudId))
      throw new Error('请选择已连接的网盘账号。')
    const modeChanged = kindleMode(this.settings) !== kindleMode(next)
    if (settings.onboardingComplete && (!this.initialImport || this.initialImport.model !== next.deviceModel)) {
      this.initialImport = { status: 'waiting_device', model: next.deviceModel!, books: 0, notebooks: 0, annotations: 0, message: '设置已完成，正在检查 Kindle，准备自动导入现有书籍和笔记。' }
      this.store.put('initial-import', 'main', this.initialImport)
    }
    this.settings = next
    this.store.put('settings', 'main', this.settings)
    this.notify()
    this.scheduleInitialImport()
    if (modeChanged) {
      if (kindleMode(next) === 'native') { await this.koreader.close(); await this.localProfiles.close() }
      else { if (this.options.readerAutostart !== false) void this.koreader.start().catch(() => {}); await this.startLocalProfiles() }
    }
    if (kindleMode(next) === 'koreader' && ['displayName', 'avatar', 'avatarImage', 'sleepCoverEnabled', 'defaultCloudId'].some(key => Object.hasOwn(settings, key))) {
      this.sync.markPreferencesPending()
      clearTimeout(this.preferencesTimer)
      this.preferencesTimer = setTimeout(() => { this.preferencesTimer = undefined; void this.publishPreferences().catch(() => {}) }, 600)
      this.preferencesTimer.unref()
    }
  }

  async saveKindleMail(input: KindleMailInput) { this.kindleMail.save(input); this.notify() }
  async verifyKindleMail() { try { await this.kindleMail.verify() } finally { this.notify() } }
  async sendKindleTest() { try { await this.kindleMail.sendTest() } finally { this.notify() } }
  async clearKindleMail() { this.kindleMail.clear(); this.notify() }

  async publishPreferences() {
    const account = this.settings.defaultCloudId ?? this.store.list<CloudAccount>('clouds')[0]?.id
    if (account) await this.sync.publishPreferences(account)
  }

  async setLocalProfiles(enabled: boolean) {
    if (enabled) await this.localProfiles.start()
    else await this.localProfiles.close()
    await this.saveSettings({ localProfileEnabled: enabled })
  }

  async startLocalProfiles() {
    if (kindleMode(this.settings) === 'koreader' && this.settings.localProfileEnabled) await this.localProfiles.start()
  }

  async exportLocalProfilePairing(deviceId: string, destination: string) {
    await this.setLocalProfiles(true)
    const zip = new JSZip()
    zip.file('kindlespouse/lan.json', this.localProfiles.config(deviceId), { unixPermissions: 0o600 })
    zip.file('kindlespouse/kindlespouse-sync-next', await readFile(path.join(this.options.nativeDirectory, 'tools/companion/kindlespouse-sync')), { unixPermissions: 0o700 })
    zip.file('kindlespouse/sync.sh', await readFile(path.join(this.options.nativeDirectory, 'companion/sync.sh')), { unixPermissions: 0o700 })
    zip.file('koreader/plugins/kindlespouse.koplugin/main.lua', await readFile(path.join(this.options.nativeDirectory, 'companion/plugin/main.lua')))
    zip.file('koreader/plugins/kindlespouse.koplugin/home.lua', await readFile(path.join(this.options.nativeDirectory, 'companion/plugin/home.lua')))
    zip.file('koreader/plugins/kindlespouse.koplugin/library.lua', await readFile(path.join(this.options.nativeDirectory, 'companion/plugin/library.lua')))
    zip.file('koreader/plugins/kindlespouse.koplugin/shelf.lua', await readFile(path.join(this.options.nativeDirectory, 'companion/plugin/shelf.lua')))
    zip.file('koreader/plugins/kindlespouse.koplugin/profile.lua', await readFile(path.join(this.options.nativeDirectory, 'companion/plugin/profile.lua')))
    zip.file('INSTALL.txt', 'Save and exit KOReader. Copy the kindlespouse and koreader folders to the Kindle USB root, preserving config.json, rclone.conf and pause files. The staged companion activates after confirming no sync is running. Unplug USB, enable Wi-Fi and choose KindleSpouse > Sync profile now. This private package contains a device access token; keep it off GitHub.\n')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    await writeFile(destination, bytes, { mode: 0o600 })
    await writeFile(destination + '.sha256', contentHash(bytes) + '\n', { mode: 0o600 })
  }

  async refreshNotebookTitles() {
    const accountId = this.settings.defaultCloudId ?? this.store.list<CloudAccount>('clouds')[0]?.id
    if (!accountId) throw new Error('请先连接网盘，再通过 Wi-Fi 同步 Kindle 标题。')
    await this.sync.syncTitles(accountId)
    this.notify()
  }

  async importNotes() {
    if (this.notesImport?.working) throw new Error('正在导入笔记，请等待当前读取完成。')
    if (this.deviceImport && !this.deviceImport.finished) throw new Error('正在导入 Kindle 书库与资料，请等待当前读取完成。')
    this.notesImport = { working: true, notebooks: 0, annotations: 0, files: 0, message: '正在读取设备笔记和书籍标注' }
    this.notify()
    try {
      const devices = await this.transport.list()
      const root = path.join(this.directory, 'notes-backups')
      await mkdir(root, { recursive: true })
      let snapshot: string | undefined
      let fromBackup = false
      if (devices[0] && this.transport.exportNotes) {
        snapshot = path.join(root, `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        await this.transport.exportNotes(devices[0].id, snapshot)
      } else {
        for (const base of [root, path.join(this.directory, 'device-backups')]) {
          if (!existsSync(base)) continue
          const candidates = (await readdir(base, { withFileTypes: true }))
            .filter((item) => item.isDirectory() && existsSync(path.join(base, item.name, 'snapshot-manifest.json')))
            .sort((a, b) => b.name.localeCompare(a.name))
          if (candidates[0]) {
            snapshot = path.join(base, candidates[0].name)
            fromBackup = true
            break
          }
        }
      }
      if (!snapshot) throw new Error('请退出 KOReader 并连接 Kindle USB，再读取笔记。也可以导入已有 PDF 或 nbk 文件。')
      this.notesImport.message = '已保留原始快照，正在整理笔记'
      this.notify()
      const result = await this.notebookLibrary.importSnapshot(snapshot)
      this.notesImport = {
        ...result,
        working: false,
        message: fromBackup ? '已从本机备份读取笔记，连接设备后可更新' : '笔记已导入本机；打开手写笔记时自动生成 PDF',
      }
      this.notify()
    } catch (error) {
      this.notesImport = {
        ...this.notesImport,
        working: false,
        message: '笔记读取未完成，已有资料仍保留',
        error: error instanceof Error ? error.message : String(error),
      }
      this.notify()
      throw error
    }
  }

  async close() {
    this.closing = true
    clearTimeout(this.initialImportTimer)
    await this.initialImportTask
    await this.automaticSync.close()
    await this.localProfiles.close()
    if (this.preferencesTimer) {
      clearTimeout(this.preferencesTimer)
      this.preferencesTimer = undefined
      await this.publishPreferences().catch(() => {})
    }
    await this.coverCache.close()
    await this.coverReader?.close()
    await this.koreader.close()
    await this.source.close()
    this.cloud.cancelAuthorization()
    await this.libraryPreparation
    await this.processing
    await this.importQueue
    await this.sync.close()
    await this.cloud.close()
    await this.catalog.stop()
    await this.notebookLibrary.close()
    this.store.close()
  }
}
