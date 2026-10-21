import { createServer, type Server } from 'node:https'
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { CloudAccount, Settings, SyncDevice, LocalProfileState, ReadingStats } from '../src/shared'
import type { SecretStore } from './cloud'
import { Store } from './store'
import { runProcess } from './process'
import { avatarAsset } from './avatar'
import { sleepProfile } from '../src/sleep-cover'
import { contentHash } from './books'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const profileReceiptSchema = z.object({ version: z.literal(1), profileVersion: z.literal(2), deviceId: z.string().uuid(), revision: hash, avatarHash: hash.optional(), receivedAt: z.string().datetime() })
export type ProfileReceipt = z.infer<typeof profileReceiptSchema>

export function localIPv4() {
  return [...new Set(Object.entries(networkInterfaces()).filter(([name]) => !/virtual|vmware|vbox|wsl|vethernet|loopback/i.test(name)).flatMap(([, items]) => items ?? []).filter(item => item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)).map(item => item.address))].slice(0, 8)
}

export class LocalProfileServer {
  private server?: Server
  private starting?: Promise<void>
  private port = 0
  private host = '0.0.0.0'
  private fingerprint = ''
  private error?: string
  constructor(private directory: string, private nativeDirectory: string, private store: Store, private secrets: SecretStore, private settings: () => Settings, private received: (receipt: ProfileReceipt) => void, private changed: () => void, private reading: () => ReadingStats) {}

  snapshot(): LocalProfileState {
    return { enabled: Boolean(this.server?.listening), addresses: this.server?.listening ? (this.host === '127.0.0.1' ? ['127.0.0.1'] : localIPv4()).map(address => `https://${address}:${this.port}`) : [], error: this.error }
  }

  start(host = '0.0.0.0', port?: number) {
    if (this.server?.listening) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.open(host, port).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async open(host: string, port?: number) {
    this.error = undefined
    try {
      const identity = path.join(this.directory, 'local-profile-identity')
      const helper = path.join(this.nativeDirectory, 'tools/companion/kindlespouse-link.exe')
      if (!existsSync(path.join(identity, 'certificate.pem')) || !existsSync(path.join(identity, 'private-key.pem'))) {
        if (!existsSync(helper)) throw new Error('局域网组件尚未安装。')
        await mkdir(identity, { recursive: true })
        await runProcess(helper, ['--directory', identity], { timeout: 15000 })
      }
      const cert = await readFile(path.join(identity, 'certificate.pem')), key = await readFile(path.join(identity, 'private-key.pem'))
      this.fingerprint = contentHash(new X509Certificate(cert).raw)
      this.host = host
      const server = createServer({ cert, key, minVersion: 'TLSv1.2', requestTimeout: 5000, headersTimeout: 3000, keepAliveTimeout: 1500 }, (request, response) => {
        void (async () => {
          response.setHeader('Cache-Control', 'no-store')
          if (request.headers.origin || request.url?.includes('?')) { response.writeHead(403).end(); return }
          const route = /^\/v1\/profiles\/([a-f0-9-]{36})(\/receipt)?$/.exec(request.url ?? '')
          const device = route && this.store.get<SyncDevice>('sync-devices', route[1])
          const token = device && device.status !== 'revoked' ? this.secrets.get('local-profile:' + device.id) : undefined
          const expected = Buffer.from('Bearer ' + (token ?? ''))
          const supplied = Buffer.from(request.headers.authorization ?? '')
          if (!token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return }
          const settings = this.settings(), asset = avatarAsset(settings.avatarImage), profile = sleepProfile(settings, asset?.hash, this.store.list<CloudAccount>('clouds'), this.reading())
          const revision = contentHash(Buffer.from(JSON.stringify(profile)))
          if (request.method === 'GET' && !route![2]) {
            const body = JSON.stringify({ version: 1, deviceId: device!.id, profile: { ...profile, revision }, avatar: asset?.bytes.toString('base64') })
            response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body)
            return
          }
          if (request.method === 'POST' && route![2]) {
            let size = 0
            const chunks: Buffer[] = []
            for await (const chunk of request) {
              size += chunk.length
              if (size > 4096) { response.writeHead(413).end(); request.destroy(); return }
              chunks.push(Buffer.from(chunk))
            }
            const parsed = profileReceiptSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            if (!parsed.success || parsed.data.deviceId !== device!.id) { response.writeHead(400).end(); return }
            const current = this.settings(), currentAsset = avatarAsset(current.avatarImage)
            const currentRevision = contentHash(Buffer.from(JSON.stringify(sleepProfile(current, currentAsset?.hash, this.store.list<CloudAccount>('clouds'), this.reading()))))
            if (parsed.data.revision !== currentRevision || parsed.data.avatarHash !== currentAsset?.hash) { response.writeHead(409).end(); return }
            this.received({ ...parsed.data, receivedAt: new Date().toISOString() })
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
            return
          }
          response.writeHead(405).end()
        })().catch(() => { if (!response.headersSent) response.writeHead(400).end(); else response.destroy() })
      })
      server.maxConnections = 16
      this.server = server
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port ?? this.store.get<{ port: number }>('local-profile', 'listener')?.port ?? 41943, host, resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动局域网连接。')
      this.port = address.port
      this.store.put('local-profile', 'listener', { port: this.port })
      server.on('error', () => { this.error = '局域网连接不可用，将通过网盘同步。'; this.changed() })
    } catch (error) {
      this.server?.close()
      this.server = undefined
      this.error = error instanceof Error && error.message === '局域网组件尚未安装。' ? error.message : '无法开启局域网连接，将通过网盘同步。'
      throw new Error(this.error)
    } finally { this.changed() }
  }

  config(deviceId: string) {
    const device = this.store.get<SyncDevice>('sync-devices', deviceId), state = this.snapshot()
    if (!device || device.status === 'revoked') throw new Error('请选择已配对的 Kindle。')
    if (!state.enabled || !state.addresses.length) throw new Error('请先启用局域网连接，并连接 Wi-Fi。')
    const key = 'local-profile:' + deviceId
    let token = this.secrets.get(key)
    if (!token) { token = randomBytes(32).toString('hex'); this.secrets.set(key, token) }
    return Buffer.from(JSON.stringify({ version: 1, deviceId, urls: state.addresses, certificateSha256: this.fingerprint, token }))
  }

  async close() {
    await this.starting?.catch(() => {})
    if (this.server?.listening) {
      const server = this.server
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    this.server = undefined
  }
}
