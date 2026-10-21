import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import JSZip from 'jszip'
import { z } from 'zod'
import { CloudBridge, safeRemotePath } from './cloud'
import { Store } from './store'
import { NotebookLibrary } from './notes'
import { ReadingHistory } from './history'
import { contentHash, MAX_BOOK_BYTES, transferFilename } from './books'
import { SyncObjects, MAX_BUNDLE_BYTES } from './sync-objects'
import { annotationJob } from './annotation-edits'
import { sleepProfile } from '../src/sleep-cover'
import { companionPackage } from './device-package'
import { avatarAsset } from './avatar'
import { profileReceiptSchema, type ProfileReceipt } from './local-profile'
import type { CloudAccount, Settings, StoredCandidate, SyncDevice, SyncState, TransferJob } from '../src/shared'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  deviceId: z.string().uuid(),
  createdAt: z.string().datetime(),
  files: z
    .array(
      z.object({ relative: z.string().max(2000), bytes: z.number().int().min(0).max(MAX_BOOK_BYTES), sha256: hash }),
    )
    .max(20000),
  bundles: z.array(z.object({ sha256: hash, bytes: z.number().int().positive().max(MAX_BUNDLE_BYTES), objects: z.array(hash).min(1).max(20000) })).max(20000).optional(),
})
const receiptSchema = z.object({
  bookFormatsVersion: z.number().int().min(1).max(100).optional(),
  version: z.literal(1),
  deviceId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  books: z.array(z.object({ jobId: z.string().uuid(), sha256: hash })).max(10000),
})
const json = (value: unknown) => Buffer.from(JSON.stringify(value))

export class CloudSync {
  private operation?: Promise<void>
  private pairing?: Promise<void>
  private status: Omit<SyncState, 'devices'>
  private objects: SyncObjects
  private preferenceQueue: Promise<void> = Promise.resolve()
  private preferences?: SyncState['preferences']
  constructor(
    private store: Store,
    private cloud: CloudBridge,
    private notes: NotebookLibrary,
    private history: ReadingHistory,
    private directory: string,
    private nativeDirectory: string,
    private settings: () => Settings,
    private changed: () => void,
  ) {
    this.status = { working: false, ...store.get('sync-state', 'main') }
    this.status.working = false
    this.objects = new SyncObjects(directory, store, cloud)
    this.preferences = store.get('preferences-state', 'main')
    if (this.preferences?.state === 'uploading') this.preferences = undefined
  }
  snapshot(): SyncState {
    return { ...this.status, preferences: this.preferences, pairing: Boolean(this.pairing), devices: this.store.list<SyncDevice>('sync-devices') }
  }
  async close() {
    await this.operation?.catch(() => {})
    await this.pairing?.catch(() => {})
    await this.preferenceQueue.catch(() => {})
  }
  root() {
    return safeRemotePath(this.settings().syncFolder || 'KindleSpouse/Sync')
  }

  async ensureBookFolder(accountId: string) {
    const folder = safeRemotePath(this.settings().cloudFolder || 'KindleSpouse/Inbox')
    if (!folder || folder === this.root() || folder.startsWith(this.root() + '/') || this.root().startsWith(folder + '/')) throw new Error('Kindle 书籍目录需要独立于笔记同步目录。')
    const key = `${accountId}:${this.root()}`
    if (this.store.get<{ folder: string }>('cloud-book-folders', key)?.folder === folder) return
    await this.cloud.mutate(accountId, { action: 'mkdir', path: folder }, this.root())
    await this.cloud.writeBytes(accountId, `${this.root()}/book-folder.json`, json({ version: 1, folder }))
    this.store.put('cloud-book-folders', key, { folder })
  }

  publishPreferences(accountId: string) {
    const task = this.preferenceQueue.catch(() => {}).then(() => this.writePreferences(accountId))
    this.preferenceQueue = task
    return task
  }

  markPreferencesPending() {
    if (!this.store.list<SyncDevice>('sync-devices').some(device => device.status !== 'revoked')) return
    this.preferences = { state: 'pending', revision: contentHash(json(sleepProfile(this.settings(), avatarAsset(this.settings().avatarImage)?.hash, this.store.list<CloudAccount>('clouds'), this.history.stats()))) }
    this.store.put('preferences-state', 'main', this.preferences)
    this.changed()
  }

  applyProfileReceipt(receipt: ProfileReceipt, route: 'lan' | 'cloud') {
    const device = this.store.get<SyncDevice>('sync-devices', receipt.deviceId)
    if (!device || device.status === 'revoked') throw new Error('资料回执身份不匹配。')
    const revision = contentHash(json(sleepProfile(this.settings(), avatarAsset(this.settings().avatarImage)?.hash, this.store.list<CloudAccount>('clouds'), this.history.stats())))
    if (device.profileRevision === revision && receipt.revision !== revision) return
    this.store.put('sync-devices', device.id, { ...device, profileVersion: receipt.profileVersion, profileRevision: receipt.revision, profileAvatarHash: receipt.avatarHash, profileReceivedAt: receipt.receivedAt, profileRoute: receipt.revision === device.profileRevision && device.profileRoute === 'lan' ? 'lan' : route })
    if (receipt.revision === revision && !this.preferences?.revision) this.preferences = { state: 'uploaded', revision }
    this.changed()
  }

  private async writePreferences(accountId: string) {
    const settings = this.settings()
    if (settings.sleepCoverEnabled === undefined && !settings.avatarImage && !settings.displayName && !settings.avatar && !settings.defaultCloudId) return
    const asset = avatarAsset(settings.avatarImage)
    const profile = sleepProfile(settings, asset?.hash, this.store.list<CloudAccount>('clouds'), this.history.stats())
    const revision = contentHash(json(profile))
    const paired = this.store.list<SyncDevice>('sync-devices').filter(device => device.accountId === accountId && device.status !== 'revoked')
    const devices = paired.filter(device => this.store.get<{ revision: string }>('device-profile-revisions', device.id)?.revision !== revision)
    if (!devices.length) {
      this.preferences = paired.length ? { state: 'uploaded', revision, updatedAt: this.preferences?.updatedAt } : undefined
      if (this.preferences) this.store.put('preferences-state', 'main', this.preferences)
      else this.store.remove('preferences-state', 'main')
      this.changed()
      return
    }
    this.preferences = { state: 'uploading', revision }
    this.changed()
    try {
      if (asset && !this.store.get('uploaded-profile-assets', accountId + ':' + asset.hash)) {
        const remote = `${this.root()}/avatars/${asset.hash}.png`
        await this.cloud.writeBytes(accountId, remote, asset.bytes)
        if (contentHash(await this.cloud.readBytes(accountId, remote)) !== asset.hash) throw new Error('头像上传校验失败。')
        this.store.put('uploaded-profile-assets', accountId + ':' + asset.hash, { verifiedAt: new Date().toISOString() })
      }
      for (const device of devices) {
        const bytes = json({ ...profile, revision })
        const remote = `${this.root()}/devices/${device.id}/device-settings.json`
        await this.cloud.writeBytes(accountId, remote, bytes)
        if (contentHash(await this.cloud.readBytes(accountId, remote)) !== contentHash(bytes)) throw new Error('资料设置上传校验失败。')
        this.store.put('device-profile-revisions', device.id, { revision })
      }
      if (this.preferences?.revision === revision) this.preferences = { state: 'uploaded', revision, updatedAt: new Date().toISOString() }
    } catch (error) {
      if (this.preferences?.revision === revision) this.preferences = { state: 'error', error: '资料已保存在电脑，网盘上传未完成，请重试。', revision }
      throw error
    } finally {
      this.store.put('preferences-state', 'main', this.preferences)
      this.changed()
    }
  }

  async publishBook(job: TransferJob, book: StoredCandidate, remotePath: string) {
    await this.cloud.writeBytes(
      job.cloudAccountId!,
      `${this.root()}/outbox/${job.id}.json`,
      json({
        version: 1,
        jobId: job.id,
        sha256: job.sha256,
        title: book.title,
        filename: Buffer.byteLength(book.filename, 'utf8') > 220 ? transferFilename(book.title, book.sha256, book.format) : book.filename,
        bytes: book.bytes,
        remotePath,
        createdAt: job.createdAt,
      }),
    )
  }

  async publishBooks(entries: { job: TransferJob; book: StoredCandidate; remotePath: string }[]) {
    if (!entries.length) return
    const account = entries[0].job.cloudAccountId!
    if (entries.some(entry => entry.job.cloudAccountId !== account)) throw new Error('批量书籍账号不一致。')
    const directory = await mkdtemp(path.join(this.directory, 'outbox-batch-'))
    try {
      const files = []
      for (const { job, book, remotePath } of entries) {
        const source = path.join(directory, job.id + '.json')
        const content = json({ version: 1, jobId: job.id, sha256: job.sha256, title: book.title, filename: Buffer.byteLength(book.filename, 'utf8') > 220 ? transferFilename(book.title, book.sha256, book.format) : book.filename, bytes: book.bytes, remotePath, createdAt: job.createdAt })
        await writeFile(source, content)
        files.push({ source, name: job.id + '.json', sha256: contentHash(content) })
      }
      await this.cloud.uploadManyAndVerify(account, `${this.root()}/outbox`, files, () => {})
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(this.directory)) throw new Error('临时书籍清单目录不在预期位置。')
      await rm(directory, { recursive: true, force: true })
    }
  }

  private applyBookReceipt(accountId: string, device: SyncDevice, bytes: Buffer) {
    const receipt = receiptSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (receipt.deviceId !== device.id) throw new Error('设备回执身份不匹配。')
    this.store.put('sync-devices', device.id, { ...this.store.get<SyncDevice>('sync-devices', device.id)!, bookFormatsVersion: receipt.bookFormatsVersion ?? 1 })
    let changed = false
    for (const item of receipt.books) {
      const job = this.store.get<TransferJob>('jobs', item.jobId)
      if (job?.cloudAccountId === accountId && job.sha256 === item.sha256 && job.method === 'cloud' && job.status !== 'cancelled' && !job.deviceReceivedAt) {
        this.store.put('jobs', job.id, { ...job, deviceReceivedAt: receipt.receivedAt, message: 'Kindle 已下载并校验' })
        changed = true
      }
    }
    return changed
  }

  async refreshBookReceipts(accountId: string) {
    let changed = false
    for (const device of this.store.list<SyncDevice>('sync-devices').filter(device => device.accountId === accountId && device.status === 'connected')) {
      try {
        const bytes = await this.cloud.readBytes(accountId, `${this.root()}/devices/${device.id}/receipts.json`)
        changed = this.applyBookReceipt(accountId, device, bytes) || changed
      } catch {}
    }
    if (changed) this.changed()
  }

  async pair(accountId: string, name: string, destination: string) {
    if (this.pairing) throw new Error('设备正在授权，请先完成当前配对。')
    this.status = { ...this.status, error: undefined }
    this.pairing = this.preparePair(accountId, name, destination)
    this.changed()
    try {
      await this.pairing
    } catch (error) {
      this.status = { ...this.status, error: error instanceof Error ? error.message : String(error) }
      this.store.put('sync-state', 'main', this.status)
      throw error
    } finally {
      this.pairing = undefined
      this.changed()
    }
  }

  private async preparePair(accountId: string, name: string, destination: string) {
    const bundle = path.join(this.nativeDirectory, 'tools', 'companion')
    for (const file of ['kindlespouse-sync', 'rclone'])
      if (!existsSync(path.join(bundle, file))) throw new Error('设备同步组件尚未构建，请先安装配套工具。')
    const markerPath = `${this.root()}/account.json`
    const entries = await this.cloud.list(accountId, this.root()).catch(() => [])
    const accountMarker = entries.some((entry) => entry.name === 'account.json')
      ? z
          .object({ marker: z.string().uuid() })
          .parse(JSON.parse((await this.cloud.readBytes(accountId, markerPath)).toString('utf8'))).marker
      : randomUUID()
    await this.cloud.writeBytes(accountId, markerPath, json({ version: 1, marker: accountMarker }))
    await this.cloud.writeBytes(accountId, `${this.root()}/outbox/.keep`, Buffer.alloc(0))
    await this.cloud.writeBytes(accountId, `${this.root()}/objects/.keep`, Buffer.alloc(0))
    const credential = await this.cloud.separateDeviceCredential(accountId)
    const marker = JSON.parse((await this.cloud.readBytes(credential.accountId, markerPath)).toString('utf8')) as {
      marker?: string
    }
    if (marker.marker !== accountMarker) throw new Error('设备授权使用了另一个网盘账号，请使用与桌面相同的账号重试。')
    const device: SyncDevice = {
      id: randomUUID(),
      name: name.trim() || 'Kindle',
      accountId,
      pairedAt: new Date().toISOString(),
      status: 'awaiting_pairing',
    }
    const zip = await companionPackage(this.nativeDirectory)
    zip.file('kindlespouse/rclone.conf', credential.config, { unixPermissions: 0o600 })
    zip.file(
      'kindlespouse/config.json',
      json({ version: 1, deviceId: device.id, name: device.name, remoteRoot: this.root(), mount: '/mnt/us' }),
      { unixPermissions: 0o600 },
    )
    zip.file(
      'extensions/kindlespouse/menu.json',
      json({
        items: [
          {
            name: 'KindleSpouse',
            priority: 0,
            items: [{ name: 'Sync now', action: 'sh /mnt/us/kindlespouse/sync.sh' }],
          },
        ],
      }),
    )
    zip.file(
      'extensions/kindlespouse/config.xml',
      '<extension><information><name>KindleSpouse</name><version>0.3.0</version><author>KindleSpouse</author><id>kindlespouse</id></information><menus><menu type="json" dynamic="true">menu.json</menu></menus></extension>',
    )
    zip.file(
      'INSTALL.txt',
      'Extract this private package to the Kindle USB root once. Save and exit KOReader before installation. After unplugging USB, open KOReader and choose KindleSpouse > Sync now, or use KUAL > KindleSpouse > Sync now. Keep this package private: it contains a separate cloud authorization. Revoke it from your cloud provider if the device is lost. No firmware update or automatic Wi-Fi wake is required.\n',
    )
    await this.cloud.writeBytes(
      accountId,
      `${this.root()}/pairings/${device.id}.json`,
      json({ version: 1, deviceId: device.id, active: true }),
    )
    await writeFile(
      destination,
      await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' }),
      { mode: 0o600 },
    )
    this.store.put('sync-devices', device.id, device)
    this.changed()
  }

  async revoke(id: string) {
    const device = this.store.get<SyncDevice>('sync-devices', id)
    if (!device) throw new Error('找不到已配对设备。')
    await this.cloud.writeBytes(
      device.accountId,
      `${this.root()}/pairings/${id}.json`,
      json({ version: 1, deviceId: id, active: false }),
      false,
    )
    this.store.put('sync-devices', id, { ...device, status: 'revoked' })
    this.changed()
  }

  sync(accountId: string, automatic = false) {
    if (this.operation) return this.operation
    this.operation = this.run(accountId, automatic).finally(() => {
      this.operation = undefined
    })
    return this.operation
  }

  syncTitles(accountId: string) {
    if (this.operation) return this.operation
    this.operation = this.runTitles(accountId).finally(() => { this.operation = undefined })
    return this.operation
  }

  private async runTitles(accountId: string) {
    this.status = { ...this.status, working: true, error: undefined, progress: { phase: '正在读取网盘标题索引', done: 0, total: 0 } }
    this.changed()
    try {
      const devices = this.store.list<SyncDevice>('sync-devices').filter((device) => device.accountId === accountId && device.status !== 'revoked')
      let imported = false
      for (const device of devices) imported = await this.importCatalog(device) || imported
      if (!imported) throw new Error('网盘还没有设备标题索引。请连接 Kindle 的 Wi-Fi，在 KOReader → KindleSpouse 选择 Sync titles。')
    } catch (error) {
      this.status.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.status.working = false
      this.status.progress = undefined
      this.store.put('sync-state', 'main', this.status)
      this.changed()
    }
  }

  private async manifest(accountId: string, remote: string, fingerprint: string) {
    const directory = path.join(this.directory, 'cloud-manifests')
    await mkdir(directory, { recursive: true })
    const filename = path.join(directory, fingerprint + '.json')
    let content = await readFile(filename).catch(() => undefined)
    if (!content || contentHash(content) !== fingerprint) {
      content = await this.cloud.readBytes(accountId, remote, 16 * 1024 ** 2)
      if (contentHash(content) !== fingerprint) throw new Error('云端同步清单校验失败。')
      await writeFile(filename, content)
    }
    return { content, manifest: manifestSchema.parse(JSON.parse(content.toString('utf8'))) }
  }

  private async importCatalog(device: SyncDevice, metadata?: Map<string, Buffer>, automatic = false) {
    const base = `${this.root()}/devices/${device.id}`
    const files = metadata ?? await this.cloud.readSyncState(device.accountId, base)
    const latest = files.get('catalog/latest.json')
    if (!latest) return false
    const pointer = z.object({ manifest: hash }).parse(JSON.parse(latest.toString('utf8')))
    const { content, manifest } = await this.manifest(device.accountId, `${base}/catalog/snapshots/${pointer.manifest}.json`, pointer.manifest)
    if (manifest.deviceId !== device.id || !manifest.files.length || manifest.files.length > 2 || new Set(manifest.files.map((file) => file.relative)).size !== manifest.files.length || manifest.files.some((file) => !['cc.db', 'ksdk.content.db'].includes(file.relative))) throw new Error('标题索引不属于已配对设备，或包含无效文件。')
    const directory = path.join(this.directory, 'notebook-catalogs', device.id, pointer.manifest)
    if (automatic && this.store.get('synced-catalogs', pointer.manifest) && manifest.files.every(file => existsSync(path.join(directory, file.relative)))) return true
    await mkdir(directory, { recursive: true })
    await this.objects.materialize(device.accountId, this.root(), manifest, directory)
    await writeFile(path.join(directory, 'snapshot-manifest.json'), content)
    const result = this.notes.matchTitles(directory)
    if (result.error) throw new Error(result.error)
    this.store.put('synced-catalogs', pointer.manifest, { importedAt: new Date().toISOString() })
    return true
  }

  private async run(accountId: string, automatic = false) {
    this.status = { ...this.status, working: true, error: undefined, progress: { phase: '正在检查网盘更新', done: 0, total: 0 } }
    this.changed()
    try {
      const devices = this.store
        .list<SyncDevice>('sync-devices')
        .filter((device) => device.accountId === accountId && device.status !== 'revoked')
      await this.publishPreferences(accountId)
      for (const device of devices) {
        const base = `${this.root()}/devices/${device.id}`
        for (const note of this.notes.notes().filter(note => note.origin?.deviceId === device.id && note.edit?.status === 'queued')) {
          const payload = json(annotationJob(note))
          const remote = `${base}/annotation-outbox/${note.edit!.jobId}.json`
          await this.cloud.writeBytes(accountId, remote, payload)
          if (contentHash(await this.cloud.readBytes(accountId, remote)) !== contentHash(payload)) throw new Error('标注上传校验失败。')
          this.store.put('reading-notes', note.id, { ...note, edit: { ...note.edit!, status: 'uploaded' } })
        }
        const metadata = await this.cloud.readSyncState(accountId, base)
        if (metadata.has('profile-receipt.json')) {
          const receipt = profileReceiptSchema.parse(JSON.parse(metadata.get('profile-receipt.json')!.toString('utf8')))
          if (receipt.deviceId !== device.id) throw new Error('个人资料回执身份不匹配。')
          this.applyProfileReceipt(receipt, 'cloud')
        }
        if (metadata.has('annotation-receipts.json')) {
          const receipt = z.object({ version: z.literal(1), deviceId: z.string().uuid(), results: z.array(z.object({ jobId: z.string().uuid(), status: z.enum(['applied', 'conflict']), error: z.string().max(1000).optional() })).max(1000) }).parse(JSON.parse(metadata.get('annotation-receipts.json')!.toString('utf8')))
          if (receipt.deviceId !== device.id) throw new Error('标注回执身份不匹配。')
          for (const item of receipt.results) {
            const note = this.notes.notes().find(note => note.origin?.deviceId === device.id && note.edit?.jobId === item.jobId)
            if (note?.edit) this.store.put('reading-notes', note.id, { ...note, edit: { ...note.edit, status: item.status, error: item.status === 'conflict' ? '设备版本已变化或无法安全写入，请更新后核对。' : undefined } })
          }
          if (receipt.results.length >= 400) for (const note of this.notes.notes().filter(note => note.origin?.deviceId === device.id && note.edit?.status === 'uploaded')) {
            const raw = await this.cloud.readBytes(accountId, `${base}/annotation-results/${note.edit!.jobId}.json`).catch(() => undefined)
            if (!raw) continue
            const item = z.object({ jobId: z.literal(note.edit!.jobId!), status: z.enum(['applied', 'conflict']) }).parse(JSON.parse(raw.toString('utf8')))
            this.store.put('reading-notes', note.id, { ...note, edit: { ...note.edit!, status: item.status } })
          }
        }
        await this.importCatalog(device, metadata, automatic)
        if (metadata.has('receipts.json')) {
          this.applyBookReceipt(accountId, device, metadata.get('receipts.json')!)
        }
        if (metadata.has('status.json')) {
          const status = z
            .object({ ok: z.boolean(), error: z.string().max(2000).optional() })
            .parse(JSON.parse(metadata.get('status.json')!.toString('utf8')))
          if (!status.ok) throw new Error('设备端同步未完成：' + (status.error ?? '请查看 Kindle 同步结果'))
        }
        if (!metadata.has('latest.json')) continue
        const pointer = z
          .object({ manifest: hash })
          .parse(JSON.parse(metadata.get('latest.json')!.toString('utf8')))
        const { manifest } = await this.manifest(accountId, `${base}/snapshots/${pointer.manifest}.json`, pointer.manifest)
        if (manifest.deviceId !== device.id) throw new Error('同步清单不属于已配对设备。')
        const snapshot = path.join(this.directory, 'cloud-snapshots', device.id, pointer.manifest)
        if (!automatic || !this.store.get('synced-manifests', pointer.manifest)) {
          await mkdir(snapshot, { recursive: true })
          await this.objects.materialize(accountId, this.root(), manifest, snapshot, (done, total, bytes, totalBytes) => {
            this.status.progress = { phase: '正在读取笔记与标注', done, total, bytes, totalBytes }
            this.changed()
          })
          await writeFile(path.join(snapshot, 'snapshot-manifest.json'), json(manifest))
        }
        if (!this.store.get('synced-manifests', pointer.manifest)) {
          await this.notes.importSnapshot(snapshot)
          this.importStatistics(snapshot, device)
          this.store.put('synced-manifests', pointer.manifest, { importedAt: new Date().toISOString() })
        }
        this.store.put('sync-devices', device.id, {
          ...this.store.get<SyncDevice>('sync-devices', device.id)!,
          status: 'connected',
          lastSeen: manifest.createdAt,
          error: undefined,
        })
      }
      await this.publishPreferences(accountId)
      this.status = { working: false, lastSuccess: new Date().toISOString() }
    } catch (error) {
      this.status = { ...this.status, working: false, error: error instanceof Error ? error.message : String(error) }
      throw error
    } finally {
      this.store.put('sync-state', 'main', this.status)
      this.changed()
    }
  }

  private importStatistics(snapshot: string, device: SyncDevice) {
    const filename = path.join(snapshot, 'statistics.sqlite3')
    if (!existsSync(filename)) return
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(filename, { readOnly: true })
      const table = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('page_stat_data','page_stat') ORDER BY CASE name WHEN 'page_stat_data' THEN 0 ELSE 1 END",
        )
        .get()
      if (!table) return
      const rows = database
        .prepare(
          `SELECT b.title AS title, s.id_book AS book, s.page AS page, s.start_time AS started, s.duration AS duration FROM "${String(table.name)}" s JOIN book b ON b.id=s.id_book WHERE s.duration>0 AND s.duration<=86400 ORDER BY s.start_time LIMIT 1000000`,
        )
        .all()
      this.store.transaction(() => {
        for (const row of rows) {
          const start = Number(row.started) * 1000,
            seconds = Number(row.duration)
          if (!Number.isFinite(start) || !Number.isFinite(seconds)) continue
          this.history.record({
            id: `${row.book}:${row.page}:${row.started}`,
            deviceId: device.id,
            source: 'koreader',
            bookTitle: String(row.title),
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(start + seconds * 1000).toISOString(),
            seconds,
          })
        }
      })
    } catch (error) {
      throw new Error(`阅读统计尚未导入：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      database?.close()
    }
  }
}
