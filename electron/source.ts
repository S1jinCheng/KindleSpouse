import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { SourcePool, supportedSourceOrigin } from './source-pool'
import { runProcess } from './process'
import type { SecretStore } from './cloud'
import { MAX_BOOK_BYTES } from './books'
import type { SourceBook, SourceAccount } from '../src/shared'
import { isKoreaderFormat, isKoreaderFilename } from '../src/book-formats'

export interface SourceSession {
  cookies: Record<string, string>
  domain: string
  entryDomain?: string
  mode: string
  verifiedAt?: string
  remaining?: number
  dailyLimit?: number
  expired?: boolean
}

export { supportedSourceOrigin } from './source-pool'

const bookSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/).max(100),
  hash: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100).optional(),
  name: z.string().min(1).max(1000),
  authors: z.array(z.string().max(500)).max(100).optional(),
  extension: z.string().transform(value => value.toLowerCase()).refine(isKoreaderFormat),
  language: z.string().max(100).optional(),
  size: z.string().max(100).optional(),
  year: z.string().max(20).optional(),
  publisher: z.string().max(500).optional(),
})

function validCookies(cookies: Record<string, string> | undefined) {
  return Boolean(cookies && typeof cookies.remix_userid === 'string' && /^[1-9]\d{0,30}$/.test(cookies.remix_userid) &&
    typeof cookies.remix_userkey === 'string' && cookies.remix_userkey.length > 0 && cookies.remix_userkey.length <= 4096 && !/[\r\n]/.test(cookies.remix_userkey))
}

function failureKind(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/daily|quota|limit reached|额度|配额/i.test(message)) return 'quota'
  if (/not authorized|unauthorized|incorrect|not logged|session.*expir|login|credential|authorization failed/i.test(message)) return 'auth'
  if (/HTTP (403|513|517)|anti.bot|challenge|diamwall/i.test(message)) return 'blocked'
  if (/network|timeout|timed out|connection|HTTP (502|503|504)|redirect|ENOTFOUND|ECONN|网络|超时/i.test(message)) return 'network'
  return 'other'
}

export function sourceError(error: unknown) {
  switch (failureKind(error)) {
    case 'quota': return new Error('书源今日下载额度已用完，请在额度恢复后重试。')
    case 'auth': return new Error('书源登录已失效，请打开登录窗口重新登录。')
    case 'blocked': return new Error('书源要求网页验证，请打开登录窗口完成验证后重试。')
    case 'network': return new Error('书源连接超时或中断，登录信息已保留，可以重试。')
    default: return new Error('书源未返回有效结果，请重试或在书源窗口中检查。')
  }
}

export function sourceReference(id: string, hash?: string) {
  if (!/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(id) || (hash && !/^[a-zA-Z0-9_-]+$/.test(hash)))
    throw new Error('无效的书籍编号。')
  const [base, embedded] = id.split(':')
  if (embedded && hash && embedded !== hash) throw new Error('书籍版本编号不一致，请重新搜索。')
  const version = hash ?? embedded
  return version ? `${base}:${version}` : base
}

export class ZlibSource {
  private queue: Promise<unknown> = Promise.resolve()
  private verification?: { key: string; promise: Promise<void> }
  private accountState?: SourceAccount
  readonly pool: SourcePool
  activeOrigin?: string
  constructor(
    private executable: string,
    private directory: string,
    private secrets: SecretStore,
    private changed: () => void = () => {},
    pool?: SourcePool,
    private execute: typeof runProcess = runProcess,
  ) {
    this.pool = pool ?? new SourcePool(changed)
  }

  private session(domain?: string): SourceSession | undefined {
    try {
      const saved = JSON.parse(this.secrets.get('zlib-session') ?? 'null') as SourceSession | null
      if (!saved || !supportedSourceOrigin(saved.domain) || !validCookies(saved.cookies)) return
      if (domain && ![saved.domain, saved.entryDomain].includes(new URL(domain).origin)) return
      return saved
    } catch { return undefined }
  }

  hasSession(domain: string) {
    const session = this.session(domain)
    return Boolean(session && !session.expired)
  }

  connected(domain: string) {
    return this.hasSession(domain) && Boolean(this.session(domain)?.verifiedAt)
  }

  account(domain: string): SourceAccount {
    const session = this.session(domain)
    if (!session) return { status: 'signed_out' }
    return this.accountState ?? {
      status: session.expired ? 'expired' : session.verifiedAt ? 'connected' : 'unverified',
      origin: session.domain, checkedAt: session.verifiedAt, remaining: session.remaining, dailyLimit: session.dailyLimit,
    }
  }

  private sameSession(a: SourceSession, b: SourceSession | undefined) {
    return b && a.entryDomain === b.entryDomain && a.cookies.remix_userid === b.cookies.remix_userid &&
      a.cookies.remix_userkey === b.cookies.remix_userkey
  }

  saveSession(domain: string, cookies: Record<string, string>, actualDomain = domain) {
    const origin = supportedSourceOrigin(actualDomain)
    if (!origin || !validCookies(cookies)) return false
    const next = { cookies: { remix_userid: cookies.remix_userid, remix_userkey: cookies.remix_userkey }, domain: origin, entryDomain: new URL(domain).origin, mode: 'eapi' }
    const previous = this.session(domain)
    if (this.sameSession(next, previous) && previous?.domain === origin) return false
    this.secrets.set(
      'zlib-session',
      JSON.stringify(next),
    )
    this.accountState = undefined
    return true
  }

  verify(domain: string, force = false): Promise<void> {
    const session = this.session(domain)
    if (!session) return Promise.reject(new Error('请先在书源窗口登录自己的账号。'))
    if (!force && session.verifiedAt && !session.expired && Date.now() - Date.parse(session.verifiedAt) < 300000) return Promise.resolve()
    const key = JSON.stringify([session.entryDomain, session.cookies.remix_userid, session.cookies.remix_userkey])
    if (this.verification?.key === key) return this.verification.promise
    this.accountState = { status: 'verifying', origin: session.domain }
    this.changed()
    const promise = (async () => {
      try {
        const output = await this.run(['profile', '--json'], domain)
        const profile = JSON.parse(output) as Record<string, unknown>
        if (!['daily_remaining', 'daily_allowed'].every(key => typeof profile[key] === 'number' && Number.isSafeInteger(profile[key]) && Number(profile[key]) >= 0)) throw new Error('Invalid profile')
        const current = this.session(domain)
        if (!this.sameSession(session, current)) return
        const verifiedAt = new Date().toISOString()
        const remaining = Number(profile.daily_remaining), dailyLimit = Number(profile.daily_allowed)
        this.secrets.set('zlib-session', JSON.stringify({ ...current, verifiedAt, remaining, dailyLimit, expired: false }))
        this.accountState = { status: 'connected', origin: current!.domain, checkedAt: verifiedAt, remaining, dailyLimit }
      } catch (error) {
        if (this.sameSession(session, this.session(domain))) {
          const expired = failureKind(error) === 'auth'
          if (expired) this.secrets.set('zlib-session', JSON.stringify({ ...this.session(domain), expired: true, verifiedAt: undefined }))
          this.accountState = { status: expired ? 'expired' : 'unavailable', origin: session.domain, error: sourceError(error).message }
        }
        throw sourceError(error)
      } finally {
        if (this.verification?.key === key) this.verification = undefined
        this.changed()
      }
    })()
    this.verification = { key, promise }
    return promise
  }

  async loginOrigin(entryUrl: string, custom = false) {
    if (custom) return entryUrl
    const origin = await this.pool.firstAvailable()
    if (!origin) throw new Error('当前网络下没有可用的接口入口。请检查网络或使用自定义网页入口。')
    return origin
  }

  private run(args: string[], domain: string, signal?: AbortSignal) {
    const task = this.queue.then(async () => {
      const session = this.session(domain)
      if (!session) throw new Error('Not logged in')
      await this.pool.firstAvailable()
      const origins = this.pool.usable(session.domain).slice(0, 3)
      if (!origins.length) throw new Error('目前没有可用书源连接，已保留登录状态，请稍后重试或打开网页入口。')
      let lastError: unknown
      for (const origin of origins) {
        const temporary = await mkdtemp(path.join(tmpdir(), 'KS-source-'))
        const configDirectory = path.join(temporary, '.config', 'zlib')
        try {
          await mkdir(configDirectory, { recursive: true })
          await writeFile(path.join(configDirectory, 'session.json'), JSON.stringify({ ...session, domain: origin }), { mode: 0o600 })
          this.activeOrigin = origin
          this.changed()
          const output = await this.execute(this.executable, args, {
            env: { ...process.env, HOME: temporary, USERPROFILE: temporary, ZLIB_DOMAIN: origin, ZLIB_DOWNLOAD_RETRIES: '1', NO_COLOR: '1' },
            timeout: args[0] === 'download' ? 180000 : 45000,
            cwd: temporary,
            signal,
          })
          if (this.sameSession(session, this.session(domain)))
            this.secrets.set('zlib-session', JSON.stringify({ ...this.session(domain), domain: origin }))
          return output
        } catch (error) {
          lastError = error
          if (signal?.aborted || !['network', 'blocked'].includes(failureKind(error))) throw error
          if (args[0] === 'download') {
            const outputDirectory = args[args.indexOf('--dir') + 1]
            if ((await readdir(outputDirectory)).length)
              throw new Error('下载连接中断，未将不完整文件加入试读区；请重试下载。')
          }
          this.pool.markFailed(origin)
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      throw lastError instanceof Error ? lastError : new Error('所有可用入口均连接失败，请稍后重试。')
    })
    this.queue = task.catch(() => {})
    return task
  }

  async search(query: string, domain: string): Promise<SourceBook[]> {
    await this.verify(domain)
    try {
      const output = await this.run(['search', '--json', '--', query], domain)
      const parsed = JSON.parse(output)
      const books: unknown = Array.isArray(parsed) ? parsed : parsed.books
      if (!Array.isArray(books)) throw new Error('Invalid search results')
      return books.flatMap(book => {
        const parsed = bookSchema.safeParse(book)
        if (!parsed.success) return []
        try { sourceReference(parsed.data.id, parsed.data.hash); return [parsed.data] } catch { return [] }
      })
    } catch (error) {
      this.failSession(domain, error)
      throw sourceError(error)
    }
  }

  private failSession(domain: string, error: unknown) {
    const current = this.session(domain)
    if (current && failureKind(error) === 'auth') {
      this.secrets.set('zlib-session', JSON.stringify({ ...current, expired: true, verifiedAt: undefined }))
      this.accountState = { status: 'expired', origin: current.domain, error: sourceError(error).message }
      this.changed()
    }
  }

  async download(id: string, hash: string | undefined, domain: string, destination: string, progress?: (bytes: number) => void) {
    const reference = sourceReference(id, hash)
    await this.verify(domain)
    await mkdir(destination, { recursive: true })
    const controller = new AbortController()
    let tooLarge = false, polling = false
    const update = async () => {
      if (polling) return
      polling = true
      try {
        const entries = await readdir(destination, { withFileTypes: true })
        const sizes = await Promise.all(entries.filter(entry => entry.isFile()).map(entry => stat(path.join(destination, entry.name)).then(info => info.size).catch(() => 0)))
        const bytes = sizes.reduce((sum, size) => sum + size, 0)
        progress?.(bytes)
        if (bytes > MAX_BOOK_BYTES) { tooLarge = true; controller.abort() }
      } finally { polling = false }
    }
    const timer = setInterval(() => { void update().catch(() => {}) }, 500)
    try {
      await this.run(['download', '--dir', destination, '--', reference], domain, controller.signal)
      await update()
      if (tooLarge) throw new Error('File too large')
      const files = (await readdir(destination, { withFileTypes: true })).filter(entry => entry.isFile() && isKoreaderFilename(entry.name))
      if (files.length !== 1) throw new Error('Invalid downloaded files')
      const filename = path.join(destination, files[0].name)
      const info = await stat(filename)
      if (!info.size || info.size > MAX_BOOK_BYTES) throw new Error('Invalid downloaded size')
      return filename
    } catch (error) {
      this.failSession(domain, error)
      if (tooLarge) throw new Error('下载超过 200 MB，已停止，文件未进入试读区。')
      throw sourceError(error)
    } finally { clearInterval(timer) }
  }

  async close() {
    this.pool.stop()
    await this.queue.catch(() => {})
    await this.verification?.promise.catch(() => {})
  }
}
