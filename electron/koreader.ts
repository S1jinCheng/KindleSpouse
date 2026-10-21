import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { contentHash } from './books'
import { layoutSettings, luaData, syncedLayout } from './koreader-settings'
import type { StoredCandidate, KoreaderFrame, KoreaderAction } from '../src/shared'
import { isKoreaderFormat, isRollingFormat } from '../src/book-formats'
import { koreaderLocation, parseKoreaderLocation } from '../src/koreader-location'
import { runProcess } from './process'

class KoreaderProcessError extends Error {}

export function readerRuntimeRoot(directory: string) {
  return path.join(tmpdir(), 'KindleSpouse-reader', contentHash(Buffer.from(path.resolve(directory))).slice(0, 16))
}

export function linuxPath(filename: string) {
  const normalized = path.win32.resolve(filename).replace(/\\/g, '/')
  if (!/^[a-z]:\//i.test(normalized) || /[\r\n\0]/.test(normalized)) throw new Error('KOReader 运行目录需要位于本机磁盘。')
  return `/mnt/${normalized[0].toLowerCase()}/${normalized.slice(3)}`
}

export class KoreaderPreview {
  private child?: ChildProcess
  private session?: { id: string; directory: string; documentDirectory: string; book: StoredCandidate; location?: string; syncedAt?: string; exactBook: boolean; font?: string }
  private heartbeat?: ReturnType<typeof setInterval>
  private sequence = 0
  private imageSequence?: number
  private log = ''
  private childError?: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private directory: string, private nativeDirectory: string) {}

  available() { return existsSync(path.join(this.nativeDirectory, 'tools/koreader/squashfs-root/usr/lib/koreader/luajit')) }

  start() {
    const task = this.queue.then(async () => {
      if (this.session && !this.processStopped()) return
      const folder = path.join(this.directory, 'reader-startup')
      await mkdir(folder, { recursive: true })
      const bytes = Buffer.from('KindleSpouse\nReady to read.\n'), filename = path.join(folder, 'welcome.txt')
      await writeFile(filename, bytes)
      await this.openInternal({ id: randomUUID(), title: 'KindleSpouse', author: '', format: 'txt', filename: 'welcome.txt', path: filename, sha256: contentHash(bytes), bytes: bytes.length, createdAt: new Date().toISOString(), source: 'Reader startup', library: false, chapters: 0, warnings: [], progress: 0 })
    })
    this.queue = task.catch(() => {})
    return task
  }

  private frameFile() { return path.join(this.session!.directory, 'frame.json') }

  private processStopped() { return !this.child || this.child.killed || this.child.exitCode !== null || this.child.signalCode !== null || Boolean(this.childError) }

  private async diagnose(error: unknown) {
    await writeFile(path.join(this.directory, 'reader-last-error.log'), `${error instanceof Error ? error.message : 'Reader failure'}\nexit=${this.child?.exitCode ?? ''} signal=${this.child?.signalCode ?? ''}\n${this.log}`).catch(() => {})
  }

  private async readFrame(seq: number, opening = false): Promise<KoreaderFrame> {
    const session = this.session!
    const deadline = Date.now() + (opening || seq === 0 ? 120000 : 25000)
    while (Date.now() < deadline && this.session?.id === session.id) {
      if (this.processStopped()) {
        if (seq === 0 && this.log.includes('opening file')) throw new Error(`KOReader 未能解析这份 ${session.book.format.toUpperCase()} 文件，请更换文件版本；原件已保留。`)
        throw new KoreaderProcessError(seq === 0 ? 'KOReader 无法启动，请重新打开；若仍失败，请检查 WSL 运行环境。' : '阅读会话已中断，请重新打开以继续阅读。')
      }
      const frame = await readFile(this.frameFile(), 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
      if (frame?.seq === seq) {
        if (frame.error) throw new Error('KOReader 无法显示此页面，请更换版本或重新打开。')
        if (frame.version !== 'v2026.07.1' || frame.width !== 1860 || frame.height !== 2480 || !Number.isInteger(frame.page) || !Number.isInteger(frame.pages)) throw new Error('KOReader 页面参数不一致，已停止预览。')
        if (session.font && (frame.font !== session.font || !frame.fontAvailable)) throw new Error(`电脑缺少设备使用的字体 ${session.font}，无法提供一致预览。`)
        const png = await readFile(path.join(session.directory, `frame-${seq}.png`))
        if (png.length > 16 * 1024 * 1024 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('KOReader 返回了无效页面。')
        if (this.imageSequence !== undefined && this.imageSequence !== seq) await rm(path.join(session.directory, `frame-${this.imageSequence}.png`), { force: true }).catch(() => {})
        this.imageSequence = seq
        const domVersion = Number.isSafeInteger(frame.domVersion) && frame.domVersion > 0 ? Number(frame.domVersion) : undefined
        session.location = koreaderLocation(String(frame.location ?? ''), domVersion)
        return { anchorResult: frame.anchorResult, sessionId: session.id, image: new Uint8Array(png), page: frame.page, pages: frame.pages, location: String(frame.location ?? ''), domVersion, font: frame.font, fontSize: frame.fontSize, version: frame.version, syncedAt: session.syncedAt, exactBook: session.exactBook, toc: Array.isArray(frame.toc) ? frame.toc : [] }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('KOReader 页面等待超时，请重新打开。')
  }

  async open(book: StoredCandidate, force = false) {
    const task = this.queue.then(() => !force && this.session?.book.id === book.id && this.session.book.sha256 === book.sha256 && !this.processStopped() ? this.readFrame(this.sequence) : this.openInternal(book))
    this.queue = task.catch(() => {})
    return task
  }

  private async openInternal(book: StoredCandidate, id: string = randomUUID()) {
    const previous = this.session
    const reuse = Boolean(previous && !this.processStopped())
    if (!reuse) await this.close()
    if (!this.available()) throw new Error('尚未安装 KOReader 预览组件，请在设置中准备运行环境。')
    if (!isKoreaderFormat(book.format)) throw new Error('当前 KOReader 不支持这种格式。')
    const original = await readFile(book.path)
    if (contentHash(original) !== book.sha256) throw new Error('原件已改变，请重新导入。')
    const root = readerRuntimeRoot(this.directory)
    await mkdir(root, { recursive: true })
    if (!reuse && process.platform === 'win32') {
      const identity = await runProcess('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 10000 })
      const sid = identity.match(/\bS-\d+(?:-\d+)+\b/)?.[0]
      if (!sid) throw new Error('无法确认阅读缓存的用户权限。')
      await runProcess('icacls.exe', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { timeout: 10000 })
    }
    const directory = reuse ? previous!.directory : await mkdtemp(path.join(root, 'preview-'))
    const documentDirectory = path.join(directory, 'documents', id)
    let layout = await syncedLayout(this.directory, book.sha256, book.format)
    const referenceFile = path.join(this.directory, 'koreader-reading-layout.json')
    if (layout) {
      const { last_xpointer: ignored, last_page: ignoredPage, ...reference } = layout.settings
      await writeFile(referenceFile, JSON.stringify({ settings: reference, syncedAt: layout.syncedAt }))
    } else {
      try {
        const saved = JSON.parse(await readFile(referenceFile, 'utf8'))
        if (typeof saved.syncedAt === 'string') layout = { settings: layoutSettings('return ' + luaData(saved.settings)), syncedAt: saved.syncedAt, exactBook: false }
      } catch {}
    }
    const settings = { ...(layout?.settings ?? {}) }
    if (book.location?.startsWith('koreader:')) {
      const saved = parseKoreaderLocation(book.location)
      if (isRollingFormat(book.format)) {
        if (settings.copt_block_rendering_mode === undefined && settings.last_xpointer === undefined) settings.copt_block_rendering_mode = 3
        settings.last_xpointer = saved.position
        if (saved.domVersion && !settings.cre_dom_version) settings.cre_dom_version = saved.domVersion
      } else settings.last_page = Number(saved.position) || 1
    }
    this.session = { id, directory, documentDirectory, book, syncedAt: layout?.syncedAt, exactBook: layout?.exactBook ?? false, font: isRollingFormat(book.format) && typeof settings.font_face === 'string' ? settings.font_face : undefined }
    try {
      const bookFilename = `book.${book.format}`
      const suffix = path.extname(bookFilename)
      const sidecar = path.basename(bookFilename, suffix) + '.sdr'
      await mkdir(path.join(documentDirectory, sidecar), { recursive: true })
      await writeFile(path.join(documentDirectory, bookFilename), original)
      await writeFile(path.join(documentDirectory, sidecar, `metadata${suffix}.lua`), `return ${luaData(settings)}\n`)
      if (reuse) {
        const seq = ++this.sequence
        await writeFile(path.join(directory, 'request.json'), JSON.stringify({ seq, action: 'open', filename: linuxPath(path.join(documentDirectory, bookFilename)) }))
        const frame = await this.readFrame(seq, true)
        if (previous!.documentDirectory !== documentDirectory) await rm(previous!.documentDirectory, { recursive: true, force: true }).catch(() => {})
        return frame
      }
      await mkdir(path.join(directory, 'patches'))
      await copyFile(path.join(this.nativeDirectory, 'reader/bridge.lua'), path.join(directory, 'patches/2-kindlespouse.lua'))
      await copyFile(path.join(this.nativeDirectory, 'reader/annotations.lua'), path.join(directory, 'annotations.lua'))
      if (existsSync(path.join(this.nativeDirectory, 'sleep-cover/preset.lua'))) await copyFile(path.join(this.nativeDirectory, 'sleep-cover/preset.lua'), path.join(directory, 'sleep_cover.lua'))
      await writeFile(path.join(directory, 'settings.reader.lua'), `return ${luaData({ language: 'en', last_migration_date: 20260701, device_id: 'desktop-preview', color_rendering: false, disable_network_connection: true, auto_suspend_timeout_seconds: 0, autoshutdown_timeout_seconds: 0, plugins_disabled: { autosuspend: true, coverbrowser: true, statistics: true, kosync: true } })}\n`)
      const heartbeat = () => writeFile(path.join(directory, 'heartbeat.json'), JSON.stringify({ at: Math.floor(Date.now() / 1000) })).catch(() => {})
      await heartbeat()
      this.heartbeat = setInterval(() => { void heartbeat() }, 5000)
      this.heartbeat.unref()
      this.sequence = 0
      this.log = ''
      this.childError = undefined
      this.child = spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linuxPath(path.join(this.nativeDirectory, 'tools/koreader/squashfs-root/usr/lib/koreader')), '--exec', 'env', 'SDL_VIDEODRIVER=dummy', 'SDL_AUDIODRIVER=dummy', `KO_HOME=${linuxPath(directory)}`, 'EMULATE_READER_W=1860', 'EMULATE_READER_H=2480', 'EMULATE_READER_DPI=300', 'LD_LIBRARY_PATH=libs', './luajit', 'reader.lua', linuxPath(path.join(documentDirectory, bookFilename))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const log = (chunk: Buffer) => { this.log = (this.log + chunk.toString()).slice(-16000) }
      this.child.stdout!.on('data', log)
      this.child.stderr!.on('data', log)
      this.child.on('error', error => { this.log = error.message; this.childError = error.message })
      return await this.readFrame(0)
    } catch (error) { await this.diagnose(error); await this.close(); throw error }
  }

  private async send(action: KoreaderAction) {
    if (this.processStopped()) throw new KoreaderProcessError('阅读会话已中断，请重新打开以继续阅读。')
    const seq = ++this.sequence
    await writeFile(path.join(this.session!.directory, 'heartbeat.json'), JSON.stringify({ at: Math.floor(Date.now() / 1000) }))
    await writeFile(path.join(this.session!.directory, 'request.json'), JSON.stringify({ ...action, seq, fileHash: this.session!.book.sha256 }))
    return this.readFrame(seq)
  }

  command(id: string, action: KoreaderAction) {
    const task = this.queue.then(async () => {
      if (!this.session || this.session.id !== id) throw new Error('阅读会话已结束，请重新打开。')
      const session = this.session
      try { return await this.send(action) }
      catch (error) {
        await this.diagnose(error)
        if (!(error instanceof KoreaderProcessError) || this.session !== session) throw error
        await this.openInternal({ ...session.book, location: session.location ?? session.book.location }, id)
        try { return await this.send(action) }
        catch (retryError) { await this.diagnose(retryError); throw retryError }
      }
    })
    this.queue = task.catch(() => {})
    return task
  }

  async close(id?: string) {
    if (!this.session || id) return
    const session = this.session
    const child = this.child
    this.session = undefined
    this.child = undefined
    this.imageSequence = undefined
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    await writeFile(path.join(session.directory, 'request.json'), JSON.stringify({ seq: ++this.sequence, action: 'close' })).catch(() => {})
    if (child && child.exitCode === null) {
      await Promise.race([new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) }), new Promise(resolve => setTimeout(resolve, 3000))])
      if (child.exitCode === null) child.kill()
    }
    await rm(session.directory, { recursive: true, force: true }).catch(() => {})
  }
}
