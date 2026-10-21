import type { SourceHealth, SourceEndpoint } from '../src/shared'

export const SOURCE_SUFFIXES = [
  'zlib.bz',
  'z-lib.gd',
  'z-lib.gl',
  'z-library.ec',
  'article.sk',
  'articles.sk',
  'zliba.ru',
  '1lib.sk',
  'z-lib.fm',
  'z-lib.sk',
]

export function supportedSourceOrigin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !SOURCE_SUFFIXES.some((suffix) => url.hostname === suffix || url.hostname.endsWith('.' + suffix))
  )
    return undefined
  return url.origin
}

export class SourcePool {
  private entries: SourceEndpoint[] = SOURCE_SUFFIXES.map((host) => ({ origin: `https://${host}`, status: 'unknown' }))
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private controllers = new Set<AbortController>()
  private checkedAt?: string
  private stopped = false

  constructor(
    private changed: () => void,
    private request: typeof fetch = fetch,
    private timeout = 8000,
  ) {}

  snapshot(): SourceHealth {
    return {
      checking: Boolean(this.pending),
      checkedAt: this.checkedAt,
      entries: this.entries.map((entry) => ({ ...entry })),
    }
  }

  start() {
    if (this.timer) return
    this.stopped = false
    void this.refresh().catch(() => {})
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, 120000)
    this.timer.unref()
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    for (const controller of this.controllers) controller.abort()
  }

  usable(preferred?: string) {
    return [
      ...new Set(
        this.entries
          .filter((entry) => entry.status === 'online')
          .sort(
            (a, b) =>
              Number((b.resolvedOrigin ?? b.origin) === preferred) -
                Number((a.resolvedOrigin ?? a.origin) === preferred) ||
              (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
          )
          .map((entry) => entry.resolvedOrigin ?? entry.origin),
      ),
    ]
  }

  async ensureFresh(maxAge = 60000) {
    if (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > maxAge) await this.refresh()
  }

  async firstAvailable() {
    const fresh = () =>
      this.entries.find(
        (entry) => entry.status === 'online' && entry.checkedAt && Date.now() - Date.parse(entry.checkedAt) < 60000,
      )
    let entry = fresh()
    if (entry) return entry.resolvedOrigin ?? entry.origin
    const checking = this.refresh()
    while (this.pending && !this.stopped) {
      entry = fresh()
      if (entry) return entry.resolvedOrigin ?? entry.origin
      await Promise.race([checking, new Promise((resolve) => setTimeout(resolve, 80))])
    }
    entry = fresh()
    return entry?.resolvedOrigin ?? entry?.origin
  }

  markFailed(origin: string) {
    this.entries = this.entries.map((entry) =>
      entry.origin === origin || entry.resolvedOrigin === origin
        ? { ...entry, status: 'offline', detail: '连接失败，已选择备用入口', checkedAt: new Date().toISOString() }
        : entry,
    )
    if (!this.stopped) this.changed()
  }

  refresh() {
    if (this.pending) return this.pending
    this.stopped = false
    this.pending = this.checkAll().finally(() => {
      this.pending = undefined
      this.checkedAt = new Date().toISOString()
      if (!this.stopped) this.changed()
    })
    this.changed()
    return this.pending
  }

  private async checkAll() {
    let index = 0
    const worker = async () => {
      while (index < this.entries.length && !this.stopped) {
        const position = index++
        const previous = this.entries[position]
        this.entries[position] = { ...previous, status: 'checking' }
        this.changed()
        const result = await this.probe(previous.origin)
        this.entries[position] = result
        if (!this.stopped) this.changed()
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  private async probe(origin: string): Promise<SourceEndpoint> {
    const started = Date.now()
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), this.timeout)
    const base = () => ({ origin, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started })
    try {
      let url = `${origin}/eapi/info/domains`
      for (let hop = 0; hop < 4; hop++) {
        const response = await this.request(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'KindleSpouse/0.2' },
        })
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          const next = location ? new URL(location, url) : undefined
          if (!next || !supportedSourceOrigin(next.href))
            return { ...base(), status: 'blocked', detail: '跳转目标不在上游支持范围内' }
          url = next.href
          continue
        }
        if (!response.ok) {
          await response.body?.cancel()
          return {
            ...base(),
            status:
              response.status === 403 || response.status === 517 || response.status === 503 ? 'blocked' : 'offline',
            detail: `接口返回 HTTP ${response.status}`,
          }
        }
        const reader = response.body?.getReader()
        if (!reader) return { ...base(), status: 'offline', detail: '接口没有返回数据' }
        let length = 0
        const parts: Uint8Array[] = []
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            length += part.value.length
            if (length > 256 * 1024) {
              await reader.cancel()
              throw new Error('Response too large')
            }
            parts.push(part.value)
          }
        } finally {
          reader.releaseLock()
        }
        const body = JSON.parse(Buffer.concat(parts).toString('utf8')) as { success?: number; domains?: unknown }
        if (body.success !== 1 || !Array.isArray(body.domains))
          return { ...base(), status: 'blocked', detail: '响应不是有效的书源接口' }
        return {
          ...base(),
          resolvedOrigin: supportedSourceOrigin(url)!,
          status: 'online',
          detail: '接口可用，下载仍需有效账号',
        }
      }
      return { ...base(), status: 'blocked', detail: '重定向次数过多' }
    } catch {
      return { ...base(), status: 'offline', detail: controller.signal.aborted ? '连接超时' : '网络或接口响应不可用' }
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }
}
