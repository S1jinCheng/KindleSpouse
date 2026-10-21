import { randomUUID, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { z } from 'zod'
import { companionPackage, DEVICE_READER_VERSION } from './device-package'
import { runProcess } from './process'
import type { Store } from './store'
import type { CompanionInspection, CompanionSetupState, SyncDevice } from '../src/shared'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function componentPath(relative: string, credentials = false) {
  if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_. -]+$/.test(part))) return false
  if (credentials && /^kindlespouse\/(config\.json|rclone\.conf|lan\.json)$/.test(relative)) return true
  return /^kindlespouse\/(kindlespouse-sync|rclone|ca\.pem|catalog\.sh|sync\.sh|component-manifest\.json)$/.test(relative)
    || /^kindlespouse\/licenses\//.test(relative)
    || /^koreader\/plugins\/(kindlespouse|customisablesleepscreen)\.koplugin\//.test(relative)
    || /^koreader\/fonts\/kindlespouse\//.test(relative)
}

interface SetupOptions {
  store: Store
  directory: string
  nativeDirectory: string
  transport: {
    inspectCompanion(id: string): Promise<CompanionInspection>
    installCompanion(id: string, directory: string, manifest: string, backup: string, progress?: (files: number, total: number) => void): Promise<{ verified: boolean; files: number }>
  }
  pair(accountId: string, name: string, destination: string): Promise<void>
  readReceipt(accountId: string, deviceId: string): Promise<Buffer>
  localProfile?: (deviceId: string) => Promise<Buffer | undefined>
  protect?: (directory: string) => Promise<void>
}

export async function protectSetupDirectory(directory: string) {
  if (process.platform !== 'win32') return
  const identity = await runProcess('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 10000 })
  const sid = identity.match(/\bS-\d+(?:-\d+)+\b/)?.[0]
  if (!sid) throw new Error('无法确认安装缓存的用户权限。')
  await runProcess('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { timeout: 10000 })
}

export class CompanionSetup {
  private state: CompanionSetupState
  private busy = false
  constructor(private options: SetupOptions) {
    this.state = options.store.get<CompanionSetupState>('companion-setup', 'main') ?? { stage: 'idle', message: '连接已退出 KOReader 的 Kindle，开始检查。' }
    if (['checking', 'authorizing', 'preparing', 'installing'].includes(this.state.stage)) this.update({ stage: 'error', message: '上次安装已中断，请接好同一设备后重试；已有资料保留。' })
  }
  snapshot() { return { ...this.state } }
  private update(fields: Partial<CompanionSetupState>) {
    this.state = { ...this.state, ...fields }
    this.options.store.put('companion-setup', 'main', this.state)
    return this.snapshot()
  }
  private async operation(task: () => Promise<CompanionSetupState>) {
    if (this.busy) throw new Error('设备设置正在进行，请等待当前步骤完成。')
    this.busy = true
    try { return await task() }
    catch (error) { return this.update({ stage: 'error', message: '这一步未完成，可以按提示重试。', error: error instanceof Error ? error.message : '设备连接失败。' }) }
    finally { this.busy = false }
  }
  inspect(deviceId: string) {
    return this.operation(async () => {
      this.update({ stage: 'checking', error: undefined, message: '正在检查 Kindle 上的 KOReader 与已有配对。' })
      const inspection = await this.options.transport.inspectCompanion(deviceId)
      if (deviceId !== this.state.usbDeviceId) this.state = { stage: 'idle', message: '', inspection, usbDeviceId: deviceId }
      return this.update({ stage: this.state.installedAt ? 'awaiting_device' : 'idle', usbDeviceId: deviceId, inspection, message: inspection.readerInstalled ? `已发现 KOReader ${inspection.readerVersion ?? ''}。` : '未发现 KOReader。请按安装说明准备设备后，再连接 USB 检查。' })
    })
  }
  install(deviceId: string, accountId: string, name: string) {
    return this.operation(async () => {
      const previous = this.snapshot()
      this.update({ stage: 'checking', error: undefined, message: '正在重新检查设备，安装期间请保持 USB 连接。' })
      const inspection = await this.options.transport.inspectCompanion(deviceId)
      if (!inspection.readerInstalled) throw new Error('请先在 Kindle 安装 KOReader；向导里的官方说明包含 KPM 安装步骤。')
      if (inspection.readerVersion !== DEVICE_READER_VERSION) throw new Error(`此安装包配套 KOReader ${DEVICE_READER_VERSION}，设备当前为 ${inspection.readerVersion ?? '未知版本'}。请先按官方说明更新并重新检查。`)
      const paired = this.options.store.list<SyncDevice>('sync-devices').find(device => device.id === inspection.pairedDeviceId && device.status !== 'revoked' && device.accountId === accountId)
      const root = path.join(this.options.directory, 'private/device-install')
      await mkdir(root, { recursive: true, mode: 0o700 })
      await (this.options.protect ?? protectSetupDirectory)(root)
      const pendingKey = `${deviceId}:${accountId}`
      const pending = this.options.store.get<{ directory: string; deviceId?: string }>('companion-pending', pendingKey)
      if ((inspection.pairedDeviceId || inspection.hasCredential) && !paired && !pending) throw new Error('设备已有其他配对，不能覆盖原授权。请在原电脑管理或撤销该设备后重新配对。')
      let stage = pending?.directory
      if (stage && (!path.resolve(stage).startsWith(path.resolve(root) + path.sep) || (await lstat(stage)).isSymbolicLink() || !path.resolve(await realpath(stage)).startsWith(path.resolve(await realpath(root)) + path.sep))) throw new Error('安装缓存位置无效。')
      stage ??= await mkdtemp(path.join(root, 'setup-'))
      this.options.store.put('companion-pending', pendingKey, { directory: stage })
      const privateZip = path.join(stage, 'pairing.zip')
      let zip: JSZip
      const privatePairing = !paired || !inspection.hasCredential && existsSync(privateZip)
      if (privatePairing) {
        this.update({ stage: 'authorizing', message: '请在浏览器为 Kindle 授权同一网盘账号，授权完成后将继续安装。' })
        if (!existsSync(privateZip)) await this.options.pair(accountId, name, privateZip)
        zip = await JSZip.loadAsync(await readFile(privateZip))
      } else zip = await companionPackage(this.options.nativeDirectory)
      const config = zip.file('kindlespouse/config.json')
      const pairedDeviceId = paired?.id ?? JSON.parse(await config!.async('string')).deviceId as string
      if (!z.string().uuid().safeParse(pairedDeviceId).success) throw new Error('配对包缺少有效的设备标识。')
      if (inspection.pairedDeviceId && inspection.pairedDeviceId !== pairedDeviceId) throw new Error('设备配对已发生变化，不能覆盖原授权。')
      if (!inspection.hasCredential && !zip.file('kindlespouse/rclone.conf')) throw new Error('设备授权文件缺失，请使用原有私有配对包恢复，或撤销原配对后重新安装。')
      const localProfile = await this.options.localProfile?.(pairedDeviceId)
      if (localProfile) zip.file('kindlespouse/lan.json', localProfile)
      const installationId = previous.usbDeviceId === deviceId && previous.accountId === accountId && previous.stage === 'error' && previous.installationId ? previous.installationId : randomUUID()
      const component = JSON.parse(await zip.file('kindlespouse/component-manifest.json')!.async('string'))
      component.installationId = installationId
      zip.file('kindlespouse/component-manifest.json', JSON.stringify(component))
      this.update({ stage: 'preparing', usbDeviceId: deviceId, accountId, pairedDeviceId, installationId, revision: component.revision, message: '正在准备组件；书籍、笔记、原授权和暂停状态会保留。' })
      const content = path.join(stage, 'content')
      await mkdir(content, { recursive: true })
      const files = []
      for (const entry of Object.values(zip.files).filter(entry => !entry.dir)) {
        if (['INSTALL.txt', 'extensions/kindlespouse/menu.json', 'extensions/kindlespouse/config.xml'].includes(entry.name)) continue
        if (!componentPath(entry.name, privatePairing || Boolean(localProfile))) throw new Error('安装包含有不允许写入的路径。')
        const bytes = await entry.async('nodebuffer')
        const filename = path.join(content, entry.name)
        await mkdir(path.dirname(filename), { recursive: true })
        await writeFile(filename, bytes, { mode: 0o600 })
        files.push({ relative: entry.name, bytes: bytes.length, sha256: hash(bytes) })
      }
      files.sort((a, b) => Number(a.relative === 'kindlespouse/component-manifest.json') - Number(b.relative === 'kindlespouse/component-manifest.json') || Number(a.relative === 'kindlespouse/config.json') - Number(b.relative === 'kindlespouse/config.json') || a.relative.localeCompare(b.relative))
      const manifest = path.join(stage, 'transfer.json')
      const backup = path.join(this.options.directory, 'migration-backups', `device-components-${installationId}`)
      await mkdir(backup, { recursive: true, mode: 0o700 })
      await (this.options.protect ?? protectSetupDirectory)(backup)
      await writeFile(manifest, JSON.stringify({ version: 1, pairedDeviceId, credentials: privatePairing || Boolean(localProfile), files }))
      this.update({ stage: 'installing', total: files.length, files: 0, message: '正在安装并回读校验组件，请保持接线；完成后会提示拔线。' })
      const result = await this.options.transport.installCompanion(deviceId, content, manifest, backup, (files, total) => this.update({ files, total, message: `正在安装并校验组件 ${files}/${total}，请保持接线。` }))
      if (!result.verified || result.files !== files.length) throw new Error('组件回读校验未完成，请保持接线并重试。')
      await rm(stage, { recursive: true, force: true })
      this.options.store.remove('companion-pending', pendingKey)
      return this.update({ stage: 'awaiting_device', files: result.files, installedAt: new Date().toISOString(), inspection, message: '组件已校验。现在拔掉 USB，连接 Wi-Fi 并打开 KOReader；电脑将检查本次安装的联网回执。' })
    })
  }
  verify() {
    return this.operation(async () => {
      if (!['awaiting_device', 'ready'].includes(this.state.stage) || !this.state.accountId || !this.state.pairedDeviceId || !this.state.installationId) throw new Error('请先完成 USB 安装与回读校验。')
      let bytes: Buffer
      try { bytes = await this.options.readReceipt(this.state.accountId, this.state.pairedDeviceId) }
      catch { return this.update({ stage: 'awaiting_device', message: '还未收到本次安装的联网回执。请保持 Wi-Fi 与 KOReader 运行；若同步已暂停，请选择 Resume sync。' }) }
      let value: unknown
      try { value = JSON.parse(bytes.toString()) } catch { return this.update({ stage: 'awaiting_device', message: '设备回执暂时无法读取，稍后会自动重试。' }) }
      const receipt = z.object({ version: z.literal(1), protocol: z.literal(1), deviceId: z.literal(this.state.pairedDeviceId), installationId: z.literal(this.state.installationId), revision: z.literal(this.state.revision), checkedAt: z.string().datetime() }).safeParse(value)
      if (!receipt.success || !this.state.installedAt || Date.parse(receipt.data.checkedAt) < Date.parse(this.state.installedAt) - 300000) return this.update({ stage: 'awaiting_device', message: '发现旧版本回执，正在等待设备载入本次安装的组件。' })
      return this.update({ stage: 'ready', verifiedAt: new Date().toISOString(), error: undefined, message: '两端已连通。试读后点下载会上传专用网盘目录，Kindle 自动收书；笔记与真实阅读记录按变化同步。' })
    })
  }
}
