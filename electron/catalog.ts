import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { TransferJob, StoredCandidate } from '../src/shared'
import { bookMimeType } from '../src/book-formats'

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

export class CatalogServer {
  private server?: Server
  private credentials = { username: 'kindle', password: randomBytes(15).toString('base64url') }
  info?: { address: string; username: string; password: string }

  constructor(
    private getEntries: () => { job: TransferJob; book: StoredCandidate }[],
    private acquire: (
      job: TransferJob,
      book: StoredCandidate,
    ) => Promise<{ path: string; cleanup?: () => Promise<void> }>,
  ) {}

  async start(host = '0.0.0.0') {
    if (this.server && this.info) return this.info
    const expected = Buffer.from(
      'Basic ' + Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64'),
    )
    this.server = createServer(async (request, response) => {
      const received = Buffer.from(request.headers.authorization ?? '')
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        response
          .writeHead(401, { 'WWW-Authenticate': 'Basic realm="KindleSpouse"', 'Cache-Control': 'no-store' })
          .end('Authentication required')
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end()
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const entries = this.getEntries()
      if (url.pathname === '/' || url.pathname === '/opds') {
        const body = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog"><id>urn:kindlespouse:approved</id><title>KindleSpouse · 已确认书籍</title><updated>${new Date().toISOString()}</updated><link rel="self" href="/opds" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>${entries.map(({ job, book }) => `<entry><id>urn:uuid:${job.id}</id><title>${xml(book.title)}</title><author><name>${xml(book.author)}</name></author><updated>${job.createdAt}</updated><summary>${xml(job.method === 'cloud' ? '来自网盘；经电脑转接下载，电脑需保持运行。' : '已试读确认的文件。')}</summary><link rel="http://opds-spec.org/acquisition" href="/books/${job.id}" type="${bookMimeType(book.format)}"/></entry>`).join('')}</feed>`
        response
          .writeHead(200, {
            'Content-Type': 'application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          .end(body)
        return
      }
      const entry = entries.find((item) => url.pathname === `/books/${item.job.id}`)
      if (!entry) {
        response.writeHead(404).end()
        return
      }
      try {
        const file = await this.acquire(entry.job, entry.book)
        const info = await stat(file.path)
        response.writeHead(200, {
          'Content-Type': bookMimeType(entry.book.format),
          'Content-Length': info.size,
          'Content-Disposition': `attachment; filename="${entry.book.sha256.slice(0, 12)}.${entry.book.format}"; filename*=UTF-8''${encodeURIComponent(entry.book.filename)}`,
          'Cache-Control': 'no-store',
        })
        response.on('close', () => {
          void file.cleanup?.()
        })
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        const stream = createReadStream(file.path)
        stream.on('error', () => response.destroy())
        response.on('close', () => stream.destroy())
        stream.pipe(response)
      } catch {
        if (!response.headersSent)
          response.writeHead(502).end('Cloud download unavailable; retry while the computer is online.')
        else response.destroy()
      }
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, host, resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动无线书目。')
    const interfaces = Object.entries(networkInterfaces())
      .flatMap(([name, items]) => (items ?? []).map((item) => ({ ...item, name })))
      .filter(
        (item) => item.family === 'IPv4' && !item.internal && !/virtual|vmware|vbox|wsl|vethernet/i.test(item.name),
      )
    const ipv4 =
      host === '127.0.0.1'
        ? host
        : (interfaces.find((item) => item.address.startsWith('10.'))?.address ?? interfaces[0]?.address ?? '127.0.0.1')
    this.info = { address: `http://${ipv4}:${address.port}/opds`, ...this.credentials }
    return this.info
  }

  async stop() {
    if (this.server) {
      this.server.closeAllConnections()
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    }
    this.server = undefined
    this.info = undefined
  }
}
