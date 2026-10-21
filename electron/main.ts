import {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  net,
  nativeImage,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { AppCore } from './core'
import { Store } from './store'
import { supportedSourceOrigin } from './source'
import { notesMarkdown } from './notes'
import { contentHash, MAX_BOOK_BYTES, safeFilename } from './books'
import { safeRemotePath } from './cloud'
import { avatarBytes } from './avatar'
import { DoubanCatalog, doubanTarget } from './douban'
import { doubanFontCss, doubanReadingCss, prepareDoubanReadingDocument } from './douban-reading'
import type { DoubanPageState } from '../src/shared'
import { KOREADER_EXTENSIONS, isKoreaderFilename } from '../src/book-formats'
import { KINDLE_MODELS, kindleMode } from '../src/kindle-devices'
import { KindleMail } from './kindle-mail'
import nodemailer from 'nodemailer'
import { canonicalProfile, legacyProfiles, migrateProfilePaths, rememberedProfile, rememberProfile } from './profile-directory'
import { CompanionSetup } from './companion-setup'
import { DeviceBridge } from './device'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kindlespouse',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])
app.setName('KindleSpouse')
if (process.platform === 'win32') app.setAppUserModelId('com.kindlespouse.desktop')
const testMode = !app.isPackaged && process.env.KINDLESPOUSE_TEST_MODE === '1'
if (testMode && process.env.KINDLESPOUSE_DATA_DIR) app.setPath('userData', process.env.KINDLESPOUSE_DATA_DIR)
const acquired = app.requestSingleInstanceLock()
if (!acquired) app.quit()
let mainWindow: BrowserWindow | undefined
let sourceWindow: BrowserWindow | undefined
let doubanView: WebContentsView | undefined
let doubanBounds: { x: number; y: number; width: number; height: number } | undefined
let doubanNavigation = 0
let doubanPage: DoubanPageState = { loading: false, readingMode: true, adapted: false }
let doubanFonts: Promise<string> | undefined
let doubanStyleKey: string | undefined
let core: AppCore
let shuttingDown = false
let startupTask: Promise<void> | undefined
const inFlight = new Set<Promise<unknown>>()
const profileSchema = z.object({
  font: z.enum(['serif', 'sans', 'song']),
  fontSize: z.number().min(12).max(30),
  lineHeight: z.number().min(1.2).max(2.4),
  margin: z.number().min(8).max(40),
  paper: z.enum(['warm', 'white']),
})

function trusted(event: Electron.IpcMainInvokeEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame)
    throw new Error('不受支持的调用来源。')
  const url = new URL(event.senderFrame.url)
  if (url.protocol === 'kindlespouse:' && url.host === 'app') return
  if (!app.isPackaged && url.origin === 'http://127.0.0.1:5173') return
  throw new Error('不受支持的页面。')
}

function handle(name: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(name, (event, ...args: unknown[]) => {
    trusted(event)
    if (shuttingDown) throw new Error('应用正在关闭，请稍后重试。')
    const operation = Promise.resolve().then(() => handler(...args))
    inFlight.add(operation)
    void operation.finally(() => inFlight.delete(operation)).catch(() => {})
    return operation
  })
}

function safeExternal(value: string, allowLocalAuth = false) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(allowLocalAuth && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/auth'))
  )
    throw new Error('不支持打开这个链接。')
  return shell.openExternal(url.href)
}

async function openSource(mode: 'auto' | 'custom' = 'auto') {
  const sourceUrl = core.snapshot().settings.sourceUrl
  const targetUrl = await core.source.loginOrigin(sourceUrl, mode === 'custom')
  const downloadDirectory = path.join(core.directory, 'browser-downloads')
  await mkdir(downloadDirectory, { recursive: true })
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    sourceWindow.focus()
    return
  }
  const sourceSession = session.fromPartition('persist:kindlespouse-source')
  sourceSession.setPermissionRequestHandler((contents, permission, callback) => callback(false))
  sourceSession.setPermissionCheckHandler(() => false)
  sourceWindow = new BrowserWindow({
    width: 1160,
    height: 820,
    title: 'KindleSpouse · 书源',
    icon: path.join(app.getAppPath(), 'dist/brand/icon.png'),
    parent: mainWindow,
    webPreferences: {
      partition: 'persist:kindlespouse-source',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  sourceWindow.setMenuBarVisibility(false)
  sourceWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void sourceWindow?.loadURL(url)
    return { action: 'deny' }
  })
  sourceWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https:')) event.preventDefault()
  })
  let activeSourceUrl = targetUrl
  let captureTimer: ReturnType<typeof setTimeout> | undefined
  const capture = async () => {
    if (shuttingDown) return
    const origin = supportedSourceOrigin(activeSourceUrl)
    if (!origin) return
    const cookies = await sourceSession.cookies.get({ url: origin })
    if (shuttingDown) return
    const saved = core.source.saveSession(
      sourceUrl,
      Object.fromEntries(
        cookies
          .filter((cookie) => ['remix_userid', 'remix_userkey'].includes(cookie.name))
          .map((cookie) => [cookie.name, cookie.value]),
      ),
      origin,
    )
    if (saved) {
      core.notify()
      await core.source.verify(sourceUrl).catch(() => {})
    }
  }
  const onCookie = () => {
    clearTimeout(captureTimer)
    captureTimer = setTimeout(() => { void capture().catch(() => {}) }, 400)
  }
  sourceSession.cookies.on('changed', onCookie)
  sourceWindow.webContents.on('did-navigate', (event, url) => {
    activeSourceUrl = url
    onCookie()
  })
  sourceWindow.on('closed', () => {
    sourceSession.cookies.removeListener('changed', onCookie)
    clearTimeout(captureTimer)
    sourceWindow = undefined
    void capture().catch(() => {})
  })
  sourceSession.removeAllListeners('will-download')
  sourceSession.on('will-download', (event, item) => {
    const filename = item.getFilename()
    if (!isKoreaderFilename(filename)) {
      event.preventDefault()
      dialog.showErrorBox('下载格式不支持', '请选择 KOReader 支持的书籍或文档文件。')
      return
    }
    const savedPath = path.join(
      downloadDirectory,
      `${Date.now()}-${path.basename(filename).replace(/[<>:"/\\|?*]/g, '_')}`,
    )
    item.setSavePath(savedPath)
    item.on('updated', () => {
      if (item.getReceivedBytes() > 200 * 1024 * 1024) item.cancel()
    })
    item.once('done', async (doneEvent, state) => {
      if (state !== 'completed') {
        dialog.showErrorBox('下载未完成', '文件未进入试读区，可以从书源重试。')
        return
      }
      try {
        await core.importFile(savedPath, new URL(sourceUrl).hostname)
        mainWindow?.focus()
      } catch (error) {
        dialog.showErrorBox('无法打开这份书籍', error instanceof Error ? error.message : String(error))
      }
    })
  })
  await sourceWindow.loadURL(targetUrl)
}

function closeDouban() {
  doubanNavigation++
  if (!doubanView) return
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(doubanView)
  if (!doubanView.webContents.isDestroyed()) doubanView.webContents.close()
  doubanView = undefined
  doubanStyleKey = undefined
}

function allowedDouban(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'douban.com' || url.hostname.endsWith('.douban.com'))
  } catch { return false }
}

function updateDouban(value: Partial<DoubanPageState>) {
  doubanPage = { ...doubanPage, ...value }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('douban-page', doubanPage)
}

async function prepareDouban(view: WebContentsView) {
  const navigation = doubanNavigation
  const current = () => doubanView === view && navigation === doubanNavigation && !view.webContents.isDestroyed()
  try {
    doubanFonts ??= doubanFontCss(path.join(app.getAppPath(), 'dist')).catch(() => '')
    const fonts = await doubanFonts
    if (!current()) return
    if (!doubanStyleKey) {
      const key = await view.webContents.insertCSS(fonts + doubanReadingCss, { cssOrigin: 'user' })
      if (!current()) return
      doubanStyleKey = key
    }
    if (!current()) return
    const result = await view.webContents.executeJavaScript(`(${prepareDoubanReadingDocument.toString()})(${doubanPage.readingMode})`) as Pick<DoubanPageState, 'title' | 'url' | 'adapted'>
    if (!current()) return
    updateDouban({ ...result, loading: false, error: undefined })
    view.setVisible(true)
  } catch {
    if (!current()) return
    updateDouban({ adapted: false, loading: false, url: view.webContents.getURL(), error: undefined })
    view.setVisible(true)
  }
}

function resizeDouban() {
  if (!mainWindow || !doubanView) return
  const [width, height] = mainWindow.getContentSize()
  if (!doubanBounds) { doubanView.setBounds({ x: 0, y: 0, width: 0, height: 0 }); return }
  const bounds = doubanBounds
  doubanView.setBounds({
    x: Math.min(bounds.x, width - 1),
    y: Math.min(bounds.y, height - 1),
    width: Math.max(1, Math.min(bounds.width, width - bounds.x)),
    height: Math.max(1, Math.min(bounds.height, height - bounds.y)),
  })
}

async function openDouban(query?: string, subject?: string) {
  if (!mainWindow) return
  const target = doubanTarget(query, subject)
  const request = ++doubanNavigation
  updateDouban({ loading: true, readingMode: true, adapted: false, title: query || '豆瓣图书', url: target, error: undefined })
  if (!doubanView) {
    const browserSession = session.fromPartition('persist:kindlespouse-douban')
    browserSession.setPermissionRequestHandler((contents, permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.on('will-download', (event) => event.preventDefault())
    const fontsHandled = await browserSession.protocol.isProtocolHandled('kindlespouse')
    if (request !== doubanNavigation) return
    if (!fontsHandled) {
      browserSession.protocol.handle('kindlespouse', async request => {
        const url = new URL(request.url)
        if (url.host !== 'app' || !/^\/(?:fonts\/[\w.-]+\.ttf|assets\/[\w.-]+\.woff2)$/.test(url.pathname)) return new Response('Not found', { status: 404 })
        try {
          return new Response(await readFile(path.join(app.getAppPath(), 'dist', url.pathname)), { headers: { 'Content-Type': url.pathname.endsWith('.ttf') ? 'font/ttf' : 'font/woff2', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' } })
        } catch { return new Response('Not found', { status: 404 }) }
      })
    }
    doubanView = new WebContentsView({
      webPreferences: {
        partition: 'persist:kindlespouse-douban',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    doubanView.setBackgroundColor('#faf9f6')
    doubanView.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedDouban(url)) void doubanView?.webContents.loadURL(url).catch(() => {})
      else if (url.startsWith('https://')) void safeExternal(url).catch(() => {})
      return { action: 'deny' }
    })
    doubanView.webContents.on('will-navigate', (event, url) => {
      if (!allowedDouban(url)) event.preventDefault()
    })
    const view = doubanView
    view.webContents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument) return
      doubanNavigation++
      doubanStyleKey = undefined
      view.setVisible(false)
      updateDouban({ loading: true, adapted: false, url: details.url, error: undefined })
    })
    view.webContents.on('dom-ready', () => { void prepareDouban(view) })
    view.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
      if (code === -3 || !isMainFrame || doubanView !== view) return
      updateDouban({ loading: false, adapted: false, error: '豆瓣页面暂时无法打开，请检查网络后重试。' })
      view.setVisible(false)
    })
    view.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
      if (isMainFrame && doubanView === view) updateDouban({ url })
    })
    mainWindow.contentView.addChildView(doubanView)
  }
  resizeDouban()
  const view = doubanView
  view.setVisible(false)
  try {
    await view.webContents.loadURL(target)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_ABORTED') return
    if (doubanView === view && !view.webContents.isDestroyed())
      throw new Error('豆瓣页面暂时无法打开，请检查网络后重试。')
  }
}

app.on('second-instance', () => {
  mainWindow?.restore()
  mainWindow?.focus()
})

app.whenReady().then(async () => {
  if (!acquired) return
  const requestedDirectory = app.getPath('userData')
  const explicitProfile = testMode || process.argv.some(argument => argument.startsWith('--user-data-dir'))
  const remembered = explicitProfile ? undefined : rememberedProfile(requestedDirectory)
  let directory = remembered ?? canonicalProfile(requestedDirectory)
  const previousProfiles = explicitProfile || remembered ? [] : legacyProfiles(directory, process.env.LOCALAPPDATA)
  if (previousProfiles.length) {
    const choice = await dialog.showMessageBox({ type: 'question', title: '发现原有 KindleSpouse 资料', message: '要继续使用原有书库、笔记和网盘设置吗？', detail: '原资料会保留在原目录，不复制或覆盖当前资料。选择后可在设置中打开资料目录。', buttons: ['继续使用原资料', '使用当前资料'], defaultId: 0, cancelId: 1 })
    if (choice.response === 0) {
      if (previousProfiles.length === 1) directory = previousProfiles[0]
      else {
        const selected = await dialog.showOpenDialog({ title: '选择原有 KindleSpouse 资料目录', defaultPath: previousProfiles[0], properties: ['openDirectory'] })
        if (!selected.canceled && selected.filePaths[0] && existsSync(path.join(selected.filePaths[0], 'kindlespouse.sqlite'))) directory = canonicalProfile(selected.filePaths[0])
      }
    }
    await rememberProfile(requestedDirectory, directory)
  }
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  if (!testMode) await migrateProfilePaths(directory, [requestedDirectory, path.join(app.getPath('appData'), 'KindleSpouse')])
  const secretDatabase = new Store(path.join(directory, 'private'))
  const secrets = {
    get(key: string) {
      const encrypted = secretDatabase.get<string>('secrets', key)
      return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined
    },
    set(key: string, value: string) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据保护不可用，请检查 Windows 用户登录状态。')
      secretDatabase.put('secrets', key, safeStorage.encryptString(value).toString('base64'))
    },
  }
  const nativeDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(app.getAppPath(), 'native')
  const possibleCalibre = [
    path.resolve(app.getAppPath(), '../kindle-setup/Calibre Portable/Calibre'),
    'C:/Program Files/Calibre2',
    'C:/Program Files (x86)/Calibre2',
  ]
  const fixtureSmtpPort = testMode ? Number(process.env.KINDLESPOUSE_TEST_SMTP_PORT) : 0
  core = new AppCore({
    directory,
    nativeDirectory,
    calibreDirectory: possibleCalibre.find((candidate) => existsSync(path.join(candidate, 'calibredb.exe'))),
    secrets,
    kindleMail: Number.isInteger(fixtureSmtpPort) && fixtureSmtpPort > 0 && fixtureSmtpPort < 65536 ? new KindleMail(secrets, () => nodemailer.createTransport({ host: '127.0.0.1', port: fixtureSmtpPort, secure: false, ignoreTLS: true, allowInternalNetworkInterfaces: true })) : undefined,
    openBrowser: (url) => safeExternal(url, true),
    allowLocalDownloads: testMode,
    readerAutostart: !testMode || process.env.KINDLESPOUSE_TEST_NATIVE_STARTUP === '1',
    douban: new DoubanCatalog((input, options) => session.fromPartition('persist:kindlespouse-douban').fetch(input instanceof Request ? input.url : String(input), options)),
  })
  if (kindleMode(core.snapshot().settings) === 'koreader' && (!testMode || process.env.KINDLESPOUSE_TEST_NATIVE_STARTUP === '1')) {
    const prepareReader = core.koreader.start().catch(() => {})
    inFlight.add(prepareReader)
    void prepareReader.finally(() => inFlight.delete(prepareReader))
  }
  const frontendDirectory = path.join(app.getAppPath(), 'dist')
  protocol.handle('kindlespouse', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    const pathname = decodeURIComponent(url.pathname)
    const filename = path.resolve(frontendDirectory, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!filename.startsWith(frontendDirectory + path.sep)) return new Response('Forbidden', { status: 403 })
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    }
    try {
      return new Response(await readFile(filename), {
        headers: { 'Content-Type': contentTypes[path.extname(filename)] ?? 'application/octet-stream' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders }
    if (details.resourceType === 'image' && /^https:\/\/[a-z0-9.-]+\.doubanio\.com\//i.test(details.url)) requestHeaders.Referer = 'https://book.douban.com/'
    callback({ requestHeaders })
  })
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const remoteImage = details.resourceType === 'image' && /^https:\/\/[a-z0-9.-]+\.doubanio\.com\//i.test(details.url)
    const allowed =
      remoteImage ||
      /^(kindlespouse:|blob:|data:|devtools:)/.test(details.url) ||
      (!app.isPackaged && /^https?:\/\/127\.0\.0\.1:5173\//.test(details.url)) ||
      (!app.isPackaged && /^ws:\/\/127\.0\.0\.1:5173\//.test(details.url))
    callback({ cancel: !allowed })
  })
  mainWindow = new BrowserWindow({
    width: 1510,
    height: 990,
    minWidth: 1040,
    minHeight: 700,
    title: 'KindleSpouse',
    icon: path.join(frontendDirectory, 'brand/icon.png'),
    backgroundColor: '#faf9f6',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron/preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.on('resize', resizeDouban)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  core.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state', state)
  })
  handle('state', () => core.snapshot())
  handle('import-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择要试读的书籍',
      filters: [{ name: 'KOReader 支持的文件', extensions: [...new Set(KOREADER_EXTENSIONS.map(extension => extension.split('.').pop()!))] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    const ids = []
    for (const filename of result.filePaths) ids.push(await core.importFile(filename))
    return ids
  })
  handle('import-dropped', async (value) => {
    const paths = z.array(z.string().max(2000)).max(20).parse(value)
    const ids = []
    for (const filename of paths) ids.push(await core.importFile(filename))
    return ids
  })
  handle('download', (value) => core.download(z.string().url().max(8192).parse(value)))
  handle('preview', (value) => core.preview(z.string().uuid().parse(value)))
  handle('export-book', async value => {
    const id = z.string().uuid().parse(value), book = core.book(id)
    const selected = await dialog.showSaveDialog(mainWindow!, { title: book.isSample ? '保存当前样章' : '保存书籍原文件', defaultPath: path.join(app.getPath('downloads'), safeFilename(book.title, book.format)), filters: [{ name: book.format.toUpperCase(), extensions: [book.format.split('.').at(-1)!] }] })
    if (selected.canceled || !selected.filePath) return false
    await core.exportBook(id, selected.filePath)
    return true
  })
  handle('save-reading', (id, location, progress) =>
    core.saveReading(
      z.string().uuid().parse(id),
      z.string().max(2000).parse(location),
      z.number().min(0).max(1).parse(progress),
    ),
  )
  handle('collect', (value) => core.collect(z.string().uuid().parse(value)))
  handle('discard', (value) => core.discard(z.string().uuid().parse(value)))
  handle('approve', (value) => {
    if (!core.snapshot().settings.onboardingComplete) throw new Error('请先完成设备设置，再开始传书。')
    return core.approve(
      z
        .object({
          candidateId: z.string().uuid(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          method: z.enum(['usb', 'cloud', 'opds', 'kindle-email', 'native-cloud']),
          deviceId: z.string().max(128).optional(),
          cloudAccountId: z.string().uuid().optional(),
        })
        .parse(value),
    )
  })
  handle('retry', (value) => core.retry(z.string().uuid().parse(value)))
  handle('sync-library-cloud', id => core.syncLibraryToCloud(z.string().uuid().parse(id)))
  handle('open-koreader', (value, force) => core.openKoreader(z.string().uuid().parse(value), z.boolean().optional().parse(force) ?? false))
  handle('preview-sleep-cover', id => core.previewSleepCover(z.string().uuid().parse(id)))
  handle('command-koreader', (id, action) => core.koreader.command(z.string().uuid().parse(id), z.object({ action: z.enum(['next', 'prev', 'page', 'tap', 'refresh', 'locate']), anchor: z.object({ format: z.enum(['epub', 'pdf']), page: z.number().int().min(1).max(200000).optional(), quote: z.string().max(20000).optional(), prefix: z.string().max(2000).optional(), suffix: z.string().max(2000).optional(), sourcePosition: z.string().max(4000).optional(), endPosition: z.string().max(4000).optional(), fileHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).optional(), page: z.number().int().min(1).max(200000).optional(), x: z.number().min(0).max(1860).optional(), y: z.number().min(0).max(2480).optional() }).parse(action)))
  handle('close-koreader', (id) => core.koreader.close(z.string().uuid().parse(id)))
  handle('cancel', (value) => core.cancel(z.string().uuid().parse(value)))
  handle('refresh-book-receipts', () => core.refreshBookReceipts())
  handle('refresh-devices', () => core.refreshDevices())
  handle('import-device', () => core.importDevice())
  handle('save-settings', (value) => {
    const fields =
      z
        .object({
          kindleMode: z.enum(['native', 'koreader']).optional(),
          deviceModel: z.string().refine(value => KINDLE_MODELS.some(model => model.id === value)).optional(),
          nativeDelivery: z.enum(['kindle-email', 'native-cloud']).optional(),
          onboardingComplete: z.boolean().optional(),
          sourceUrl: z.string().url().max(2000).optional(),
          cloudFolder: z.string().max(300).optional(),
          profile: profileSchema.optional(),
          readerEngine: z.enum(['koreader', 'browser']).optional(),
          readerPageTurn: z.enum(['paper', 'soft', 'none']).optional(),
          sleepCoverEnabled: z.boolean().optional(),
          autoCloudSync: z.boolean().optional(),
          defaultCloudId: z.string().uuid().optional(),
          displayName: z.string().trim().min(1).max(60).optional(),
          avatar: z.string().max(4).optional(),
          avatarImage: z.string().max(750000).optional(),
          avatarTone: z.enum(['sand', 'clay', 'moss', 'slate', 'plum']).optional(),
          bio: z.string().trim().max(160).optional(),
          location: z.string().trim().max(60).optional(),
        })
        .parse(value)
    if (fields.avatarImage) {
      const image = nativeImage.createFromBuffer(avatarBytes(fields.avatarImage))
      if (image.isEmpty()) throw new Error('无法读取这张头像，请重新选择图片。')
      fields.avatarImage = 'data:image/png;base64,' + image.resize({ width: 256, height: 256, quality: 'best' }).toPNG().toString('base64')
    }
    return core.saveSettings(fields)
  })
  handle('publish-preferences', () => core.publishPreferences())
  handle('prepare-koreader', async () => {
    if (kindleMode(core.snapshot().settings) !== 'koreader') throw new Error('请先选择 KOReader 增强模式。')
    await core.koreader.start()
  })
  handle('save-kindle-mail', value => core.saveKindleMail(z.object({ recipient: z.string().max(254), sender: z.string().max(254), host: z.string().max(253), port: z.number().int(), security: z.enum(['tls', 'starttls']), password: z.string().max(4096).optional(), approvedSender: z.boolean() }).strict().parse(value)))
  handle('verify-kindle-mail', () => core.verifyKindleMail())
  handle('send-kindle-test', () => core.sendKindleTest())
  handle('clear-kindle-mail', () => core.clearKindleMail())
  handle('open-kindle-help', value => {
    const page = z.enum(['email', 'approved', 'web', 'connections']).parse(value)
    const pages = { email: 'https://www.amazon.com/sendtokindle/email', approved: 'https://www.amazon.com/hz/mycd/myx#/home/settings', web: 'https://www.amazon.com/sendtokindle', connections: 'https://www.amazon.com/kindle/connections' }
    return safeExternal(pages[page], true)
  })
  handle('set-local-profiles', value => core.setLocalProfiles(z.boolean().parse(value)))
  handle('export-local-profile-pairing', async value => {
    const id = z.string().uuid().parse(value)
    const selected = await dialog.showSaveDialog(mainWindow!, { title: '保存 Kindle 直连配置', defaultPath: 'KindleSpouse-Private-Local-Profile.zip', filters: [{ name: '直连配置包', extensions: ['zip'] }] })
    if (!selected.canceled && selected.filePath) { await core.exportLocalProfilePairing(id, selected.filePath); shell.showItemInFolder(selected.filePath) }
  })
  handle('choose-calibre', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择包含 calibredb.exe 的 Calibre 程序目录',
      properties: ['openDirectory'],
    })
    if (!result.canceled) {
      if (!existsSync(path.join(result.filePaths[0], 'calibredb.exe'))) throw new Error('这个目录没有 calibredb.exe。')
      await core.saveSettings({ calibreDirectory: result.filePaths[0] })
    }
  })
  handle('open-source', (mode) => openSource(z.enum(['auto', 'custom']).optional().parse(mode)))
  handle('check-sources', () => core.source.pool.refresh())
  handle('check-source-session', () => core.source.verify(core.snapshot().settings.sourceUrl, true))
  handle('import-notes', () => core.importNotes())
  handle('refresh-notebook-titles', () => core.refreshNotebookTitles())
  handle('import-notebook-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入手写笔记 PDF 或 nbk 原始文件',
      filters: [{ name: '笔记文件', extensions: ['pdf', 'nbk', '*'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (!result.canceled) for (const filename of result.filePaths) await core.notebookLibrary.importFile(filename)
  })
  handle('preview-notebook', (value) => core.notebookLibrary.preview(z.string().uuid().parse(value)))
  handle('save-notebook-reading', (id, location) =>
    core.notebookLibrary.saveReading(
      z.string().uuid().parse(id),
      z
        .string()
        .regex(/^pdf:[1-9]\d{0,5}$/)
        .parse(location),
    ),
  )
  handle('export-notebook', async (value) => {
    const id = z.string().uuid().parse(value)
    const book = core.notebookLibrary.notebooks().find((book) => book.id === id)
    if (!book) throw new Error('没有找到这本笔记。')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出手写笔记 PDF',
      defaultPath: book.title.replace(/[<>:"/\\|?*]/g, '_') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (!result.canceled && result.filePath) await core.notebookLibrary.exportPdf(id, result.filePath)
  })
  handle('export-notes', async (value) => {
    const format = z.enum(['markdown', 'json']).parse(value)
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出阅读笔记',
      defaultPath: `Kindle-Notes.${format === 'markdown' ? 'md' : 'json'}`,
    })
    if (!result.canceled && result.filePath)
      await writeFile(
        result.filePath,
        format === 'markdown'
          ? notesMarkdown(core.notebookLibrary.notes())
          : JSON.stringify(core.notebookLibrary.notes(), null, 2),
        'utf8',
      )
  })
  handle('search-source', (value) =>
    core.source.search(z.string().min(1).max(300).parse(value), core.snapshot().settings.sourceUrl),
  )
  handle('download-source', (id, hash) =>
    core.downloadSource(z.string().max(100).parse(id), z.string().max(100).optional().parse(hash)),
  )
  handle('connect-cloud', (value) => core.connectCloud(z.enum(['drive', 'onedrive']).parse(value)))
  handle('list-cloud', (id, folder) => core.cloud.list(z.string().uuid().parse(id), z.string().max(2000).parse(folder)))
  handle('download-cloud', (id, filename) =>
    core.downloadCloud(z.string().uuid().parse(id), z.string().max(2000).parse(filename)),
  )
  handle('enable-opds', async () => {
    await core.catalog.start(testMode ? '127.0.0.1' : '0.0.0.0')
    core.notify()
  })
  handle('disable-opds', async () => {
    await core.catalog.stop()
    core.notify()
  })
  handle('open-data-folder', () => shell.openPath(directory))
  handle('recover-library', () => core.recoverLibrary())
  handle('update-book', (id, fields) =>
    core.updateBook(
      z.string().uuid().parse(id),
      z
        .object({
          title: z.string().trim().min(1).max(500).optional(),
          author: z.string().max(300).optional(),
          collection: z.string().trim().max(80).optional(),
          finished: z.boolean().optional(),
        })
        .parse(fields),
    ),
  )
  handle('update-notebook', (id, title) =>
    core.notebookLibrary.rename(z.string().uuid().parse(id), z.string().trim().min(1).max(300).parse(title)),
  )
  handle('link-note', (id, bookId) =>
    core.notebookLibrary.link(
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(id),
      z.string().uuid().parse(bookId),
    ),
  )
  handle('edit-note', (id, note, deleted) => core.editNote(z.string().regex(/^[a-f0-9]{64}$/).parse(id), z.string().max(20000).parse(note), z.boolean().parse(deleted)))
  handle('restore-note', id => core.restoreNote(z.string().regex(/^[a-f0-9]{64}$/).parse(id)))
  handle('record-reading', (value) =>
    core.recordReading(
      z
        .object({
          id: z.string().max(200),
          deviceId: z.literal('desktop'),
          source: z.literal('desktop'),
          bookId: z.string().uuid(),
          bookHash: z.string().regex(/^[a-f0-9]{64}$/),
          bookTitle: z.string().max(500),
          startedAt: z.string().datetime(),
          endedAt: z.string().datetime(),
          seconds: z.number().positive().max(65),
        })
        .parse(value),
    ),
  )
  handle('search-discovery', (value, scope) => core.searchDiscovery(z.string().trim().min(1).max(300).parse(value), z.enum(['catalog', 'files', 'source', 'cloud']).optional().parse(scope)))
  handle('open-douban', (value, subject) => openDouban(z.string().max(300).optional().parse(value), z.string().max(1000).optional().parse(subject)))
  handle('set-douban-reading', async value => {
    const enabled = z.boolean().parse(value)
    if (!doubanView || doubanView.webContents.isDestroyed()) return
    updateDouban({ readingMode: enabled })
    await prepareDouban(doubanView)
  })
  handle('open-douban-external', async () => {
    const target = doubanView?.webContents.getURL()
    if (!target || !allowedDouban(target)) throw new Error('当前没有可打开的豆瓣页面。')
    await safeExternal(target)
  })
  handle('close-douban', () => closeDouban())
  handle('position-douban', (value) => {
    const bounds = z
      .object({
        x: z.number().int().min(220).max(10000),
        y: z.number().int().min(0).max(10000),
        width: z.number().int().min(1).max(10000),
        height: z.number().int().min(1).max(10000),
      })
      .parse(value)
    doubanBounds = bounds
    resizeDouban()
  })
  handle('cloud-read-text', (id, filename) =>
    core.cloud.readText(z.string().uuid().parse(id), z.string().max(2000).parse(filename)),
  )
  handle('cloud-mutate', (id, mutation) =>
    core.cloud.mutate(
      z.string().uuid().parse(id),
      z
        .object({
          action: z.enum(['mkdir', 'move', 'trash', 'write']),
          path: z.string().max(2000),
          destination: z.string().max(2000).optional(),
          text: z.string().max(1048576).optional(),
          expectedHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .parse(mutation),
      core.sync.root(),
    ),
  )
  handle('cloud-upload', async (id, folder) => {
    const account = z.string().uuid().parse(id),
      remote = safeRemotePath(z.string().max(2000).parse(folder))
    if (remote === core.sync.root() || remote.startsWith(core.sync.root() + '/'))
      throw new Error('请选择同步目录以外的位置。')
    const selected = await dialog.showOpenDialog(mainWindow!, {
      title: '上传文件到网盘',
      properties: ['openFile', 'multiSelections'],
    })
    if (selected.canceled) return
    for (const filename of selected.filePaths) {
      const info = await stat(filename)
      if (!info.isFile() || info.size > MAX_BOOK_BYTES) throw new Error('上传文件不能超过 200 MB。')
      const bytes = await readFile(filename)
      await core.cloud.uploadAndVerify(
        account,
        filename,
        [remote, path.basename(filename)].filter(Boolean).join('/'),
        contentHash(bytes),
        () => {},
      )
    }
  })
  handle('cloud-save-file', async (id, filename) => {
    const account = z.string().uuid().parse(id),
      remote = safeRemotePath(z.string().max(2000).parse(filename))
    const selected = await dialog.showSaveDialog(mainWindow!, {
      title: '下载网盘文件',
      defaultPath: path.posix.basename(remote),
    })
    if (!selected.canceled && selected.filePath) await core.cloud.download(account, remote, selected.filePath)
  })
  handle('check-cloud', (id) => core.checkCloud(z.string().uuid().parse(id)))
  handle('sync-cloud', async (id) => {
    await core.checkCloud(z.string().uuid().parse(id))
    await core.sync.ensureBookFolder(z.string().uuid().parse(id))
    await core.sync.sync(z.string().uuid().parse(id))
    await core.recoverLibrary()
  })
  const companionSetup = new CompanionSetup({
    store: core.store, directory, nativeDirectory, transport: new DeviceBridge(nativeDirectory),
    pair: (accountId, name, destination) => core.sync.pair(accountId, name, destination),
    readReceipt: (accountId, deviceId) => core.cloud.readBytes(accountId, `${core.sync.root()}/devices/${deviceId}/installation-receipt.json`),
    localProfile: async deviceId => {
      if (!core.snapshot().settings.localProfileEnabled) return undefined
      await core.startLocalProfiles()
      return core.localProfiles.config(deviceId)
    },
  })
  handle('companion-setup', () => companionSetup.snapshot())
  handle('inspect-companion', id => companionSetup.inspect(z.string().min(1).max(256).parse(id)))
  handle('install-companion', (id, accountId, name) => {
    const account = z.string().uuid().parse(accountId)
    if (!core.snapshot().clouds.some(cloud => cloud.id === account && cloud.connected)) throw new Error('请先连接同步使用的网盘账号。')
    return companionSetup.install(z.string().min(1).max(256).parse(id), account, z.string().trim().min(1).max(80).parse(name))
  })
  handle('verify-companion', () => companionSetup.verify())
  handle('open-companion-help', value => {
    const page = z.enum(['installation', 'release', 'wsl']).optional().parse(value) ?? 'installation'
    return safeExternal({ installation: 'https://github.com/koreader/koreader/wiki/Installation-on-Kindle-devices', release: 'https://github.com/koreader/koreader/releases/tag/v2026.07.1', wsl: 'https://learn.microsoft.com/windows/wsl/install' }[page], true)
  })
  handle('pair-device', async (id, name) => {
    const account = z.string().uuid().parse(id),
      deviceName = z.string().trim().min(1).max(80).parse(name)
    const folder = app.getPath('documents')
    await mkdir(folder, { recursive: true })
    const defaultPath = path.join(folder, 'KindleSpouse-Private-Pairing.zip')
    const destination = existsSync(defaultPath)
      ? path.join(folder, `KindleSpouse-Private-Pairing-${Date.now()}.zip`)
      : defaultPath
    await core.sync.pair(account, deviceName, destination)
    shell.showItemInFolder(destination)
  })
  handle('revoke-device', (id) => core.sync.revoke(z.string().uuid().parse(id)))
  if (testMode && process.env.KINDLESPOUSE_TEST_ONBOARDING !== '1') await core.saveSettings({ kindleMode: 'koreader', deviceModel: 'scribe-2022', onboardingComplete: true, readerEngine: 'browser' })
  if (process.env.KINDLESPOUSE_DEV_URL && !app.isPackaged) await mainWindow.loadURL('http://127.0.0.1:5173')
  else await mainWindow.loadURL('kindlespouse://app/')
  void core.refreshDevices().catch(() => {})
  if (!testMode) {
    void core.startLocalProfiles().catch(() => {})
    void core.publishPreferences().catch(() => {})
    core.source.pool.start()
    if (core.source.hasSession(core.snapshot().settings.sourceUrl))
      void core.source.verify(core.snapshot().settings.sourceUrl).catch(() => {})
  }
  if (!testMode)
    startupTask = (async () => {
      const { backup } = await import('node:sqlite')
      const destination = path.join(directory, 'migration-backups')
      await mkdir(destination, { recursive: true })
      const marker = path.join(destination, 'v0.3-complete')
      if (!existsSync(marker)) {
        const { DatabaseSync } = await import('node:sqlite')
        const database = new DatabaseSync(path.join(directory, 'kindlespouse.sqlite'), { readOnly: true })
        try {
          await backup(database, path.join(destination, `before-v03-${Date.now()}.sqlite`))
        } finally {
          database.close()
        }
        await core.recoverLibrary()
        await writeFile(marker, new Date().toISOString())
      }
      if (!core.snapshot().candidates.length) await core.recoverLibrary()
      await core.refreshLibraryReadability()
      await core.notebookLibrary.classify()
    })().catch((error) => {
      console.error('Data recovery needs attention:', error instanceof Error ? error.message : String(error))
    }).finally(() => core.startInitialImport())
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    core.cloud.cancelAuthorization()
    closeDouban()
    void Promise.allSettled([startupTask, ...inFlight])
      .then(() => core.close())
      .finally(() => {
        secretDatabase.close()
        app.quit()
      })
  })
})

app.on('window-all-closed', () => app.quit())
