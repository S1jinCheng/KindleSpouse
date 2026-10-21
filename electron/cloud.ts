import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from './process'
import { contentHash, MAX_BOOK_BYTES } from './books'
import type { CloudAccount, CloudEntry, CloudMutation } from '../src/shared'
import { KOREADER_EXTENSIONS, isKoreaderFilename } from '../src/book-formats'

export interface SecretStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}
interface CloudCredential {
  provider: 'drive' | 'onedrive'
  token: Record<string, unknown>
  driveId?: string
  driveType?: string
}

export function safeRemotePath(value: string) {
  const result = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (
    result.split('/').some((part) => part === '..' || part === '.') ||
    /[\x00-\x1f]/.test(result) ||
    result.includes(':')
  )
    throw new Error('请选择有效的网盘目录。')
  return result
}

export class CloudBridge {
  private queue: Promise<unknown> = Promise.resolve()
  private authorization?: { controller: AbortController; operation: Promise<CloudAccount> }

  constructor(
    private executable: string,
    private directory: string,
    private secrets: SecretStore,
    private openBrowser: (url: string) => Promise<void>,
    private execute: typeof runProcess = runProcess,
  ) {}
  async close() {
    this.cancelAuthorization()
    await this.authorization?.operation.catch(() => {})
    await this.queue.catch(() => {})
  }

  cancelAuthorization() {
    this.authorization?.controller.abort()
  }

  connect(provider: 'drive' | 'onedrive'): Promise<CloudAccount> {
    if (this.authorization) return Promise.reject(new Error('另一个网盘授权正在进行，请先完成或退出后重试。'))
    const controller = new AbortController()
    const operation = this.authorize(provider, controller)
    this.authorization = { controller, operation }
    return operation.finally(() => {
      if (this.authorization?.operation === operation) this.authorization = undefined
    })
  }

  private async authorize(provider: 'drive' | 'onedrive', controller: AbortController): Promise<CloudAccount> {
    let opened = false
    let outputBuffer = ''
    let browserFailed = false
    const output = await this.execute(
      this.executable,
      ['authorize', provider, '--auth-no-open-browser', '--config', 'NUL'],
      {
        timeout: 30 * 60 * 1000,
        signal: controller.signal,
        onOutput: (chunk) => {
          outputBuffer = (outputBuffer + chunk).slice(-16000)
          const match = outputBuffer.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?state=[A-Za-z0-9_=-]+(?=\s)/)
          if (match && !opened) {
            opened = true
            void this.openBrowser(match[0]).catch(() => {
              browserFailed = true
              controller.abort()
            })
          }
        },
      },
    ).catch(() => {
      if (browserFailed) throw new Error('浏览器未能打开，请检查默认浏览器后重新开始授权。')
      if (controller.signal.aborted) throw new Error('授权已取消。已连接的网盘仍然保留。')
      throw new Error('本次授权等待已结束，请重新开始并使用最新打开的页面；旧页面无法继续授权。')
    })
    const match = output.match(/\{[^{}]*"access_token"[^{}]*\}/s)
    if (!match) throw new Error('未取得网盘授权，请在浏览器完成授权后重试。')
    const token = JSON.parse(match[0]) as Record<string, unknown>
    const credential: CloudCredential = { provider, token }
    if (provider === 'onedrive') {
      const response = await fetch('https://graph.microsoft.com/v1.0/me/drive', {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error('OneDrive 授权成功，但未取得个人云盘，请确认账号拥有 OneDrive。')
      const drive = (await response.json()) as { id: string; driveType: string }
      credential.driveId = drive.id
      credential.driveType = drive.driveType
    }
    const id = randomUUID()
    this.secrets.set(`cloud:${id}`, JSON.stringify(credential))
    return { id, provider, name: provider === 'drive' ? 'Google Drive' : 'OneDrive', connected: true }
  }

  private withConfig<T>(accountId: string, operation: (config: string) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const saved = this.secrets.get(`cloud:${accountId}`)
      if (!saved) throw new Error('请先连接这个网盘账号。')
      const credential = JSON.parse(saved) as CloudCredential
      await mkdir(this.directory, { recursive: true })
      const temporary = await mkdtemp(path.join(tmpdir(), 'KS-cloud-'))
      const config = path.join(temporary, 'rclone.conf')
      const extra =
        credential.provider === 'drive'
          ? 'scope = drive\n'
          : `drive_id = ${credential.driveId}\ndrive_type = ${credential.driveType}\n`
      await writeFile(
        config,
        `[remote]\ntype = ${credential.provider}\n${extra}token = ${JSON.stringify(credential.token)}\n`,
        { mode: 0o600 },
      )
      try {
        return await operation(config)
      } finally {
        try {
          const updated = await readFile(config, 'utf8').catch(() => '')
          const token = updated.match(/^token\s*=\s*(\{[^\n]+\})/m)
          if (token)
            this.secrets.set(`cloud:${accountId}`, JSON.stringify({ ...credential, token: JSON.parse(token[1]) }))
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
    })
    this.queue = task.catch(() => {})
    return task
  }

  async list(accountId: string, folder: string): Promise<CloudEntry[]> {
    const remotePath = safeRemotePath(folder)
    return this.withConfig(accountId, async (config) => {
      const output = await runProcess(
        this.executable,
        ['lsjson', `remote:${remotePath}`, '--config', config, '--max-depth', '1', '--no-modtime', '--no-mimetype'],
        { timeout: 90000 },
      )
      return (JSON.parse(output) as { Name: string; Path: string; Size: number; IsDir: boolean }[])
        .map((item) => ({
          name: item.Name,
          path: safeRemotePath([remotePath, item.Path].filter(Boolean).join('/')),
          size: item.Size,
          isDir: item.IsDir,
        }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    })
  }

  async download(accountId: string, remotePath: string, destination: string) {
    return this.withConfig(accountId, (config) =>
      runProcess(
        this.executable,
        [
          'copyto',
          `remote:${safeRemotePath(remotePath)}`,
          destination,
          '--config',
          config,
          '--max-transfer',
          String(MAX_BOOK_BYTES),
          '--cutoff-mode',
          'HARD',
          '--retries',
          '2',
        ],
        { timeout: 300000 },
      ),
    )
  }

  async downloadMany(accountId: string, folder: string, names: string[], destination: string, onProgress?: (bytes: number, total: number) => void) {
    if (!names.length) return
    const files = [...new Set(names.map((name) => {
      const value = safeRemotePath(name)
      if (!value || value !== name || value.includes('\n')) throw new Error('同步文件路径无效。')
      return value
    }))]
    if (files.length > 20000) throw new Error('同步文件数超过上限。')
    await mkdir(destination, { recursive: true })
    return this.withConfig(accountId, async (config) => {
      const list = path.join(path.dirname(config), 'files.txt')
      await writeFile(list, files.join('\n') + '\n')
      let pending = ''
      await this.execute(this.executable, ['copy', `remote:${safeRemotePath(folder)}`, destination, '--config', config, '--files-from-raw', list, '--ignore-times', '--inplace', '--no-traverse', '--transfers', '4', '--checkers', '4', '--buffer-size', '1M', '--multi-thread-streams', '0', '--retries', '2', '--contimeout', '15s', '--timeout', '60s', '--stats', '2s', '--stats-log-level', 'NOTICE', '--use-json-log', '--log-level', 'NOTICE', '--max-transfer', String(5 * 1024 ** 3), '--cutoff-mode', 'HARD'], {
        timeout: 30 * 60 * 1000,
        onOutput: (chunk) => {
          pending += chunk
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          if (pending.length > 262144) pending = ''
          for (const line of lines) {
            try {
              const value = JSON.parse(line)
              if (value.stats && Number.isFinite(value.stats.bytes) && Number.isFinite(value.stats.totalBytes)) onProgress?.(value.stats.bytes, value.stats.totalBytes)
            } catch {}
          }
        },
      }).catch((error) => {
        let detail = ''
        for (const line of String(error instanceof Error ? error.message : error).split('\n')) {
          try {
            const value = JSON.parse(line)
            if (typeof value.stats?.lastError === 'string') detail = value.stats.lastError
            else if (value.level === 'error' && typeof value.msg === 'string') detail = value.msg
          } catch {}
        }
        throw new Error('网盘批量读取失败，请重试。' + (detail ? ` ${detail.slice(0, 240)}` : ''), { cause: error })
      })
    })
  }

  async readSyncState(accountId: string, folder: string) {
    return this.withConfig(accountId, async (config) => {
      const destination = path.join(path.dirname(config), 'metadata')
      const allowed = ['latest.json', 'receipts.json', 'status.json', 'catalog/latest.json', 'annotation-receipts.json', 'profile-receipt.json']
      const filters = allowed.flatMap((name) => ['--include', '/' + name])
      try {
        await this.execute(this.executable, ['copy', `remote:${safeRemotePath(folder)}`, destination, '--config', config, '--max-depth', '2', ...filters, '--max-size', '64k', '--max-transfer', '384k', '--cutoff-mode', 'HARD', '--transfers', '4', '--checkers', '4', '--buffer-size', '256k', '--retries', '2', '--contimeout', '15s', '--timeout', '60s'], { timeout: 180000 })
      } catch (error) {
        if (!/directory not found|directory doesn't exist/i.test(error instanceof Error ? error.message : String(error))) throw error
        return new Map<string, Buffer>()
      }
      const result = new Map<string, Buffer>()
      for (const name of allowed) {
        const bytes = await readFile(path.join(destination, name)).catch(() => undefined)
        if (bytes && bytes.length <= 65536) result.set(name, bytes)
      }
      return result
    })
  }

  async uploadAndVerify(
    accountId: string,
    source: string,
    remotePath: string,
    expectedHash: string,
    onVerify: () => void,
  ) {
    return this.withConfig(accountId, async (config) => {
      const remote = `remote:${safeRemotePath(remotePath)}`
      await runProcess(
        this.executable,
        ['copyto', source, remote, '--config', config, '--immutable', '--retries', '2'],
        { timeout: 300000 },
      )
      onVerify()
      const directory = await mkdtemp(path.join(this.directory, 'cloud-check-'))
      const copy = path.join(directory, 'verify.bin')
      try {
        await runProcess(
          this.executable,
          [
            'copyto',
            remote,
            copy,
            '--config',
            config,
            '--max-transfer',
            String(MAX_BOOK_BYTES),
            '--cutoff-mode',
            'HARD',
          ],
          { timeout: 300000 },
        )
        if (contentHash(await readFile(copy)) !== expectedHash)
          throw new Error('网盘文件回读校验不一致，尚未标记成功。')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  async uploadManyAndVerify(accountId: string, folder: string, files: { source: string; name: string; sha256: string }[], onVerify: () => void) {
    if (!files.length) return
    const remote = safeRemotePath(folder)
    if (!remote || files.length > 1000 || new Set(files.map(file => file.name)).size !== files.length || files.some(file => !file.name || safeRemotePath(file.name) !== file.name || file.name.includes('/') || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('批量上传文件清单无效。')
    return this.withConfig(accountId, async config => {
      const directory = await mkdtemp(path.join(this.directory, 'cloud-batch-'))
      const source = path.join(directory, 'source'), verified = path.join(directory, 'verified'), list = path.join(directory, 'files.txt')
      try {
        await mkdir(source)
        await mkdir(verified)
        let bytes = 0
        for (const file of files) {
          const destination = path.join(source, file.name)
          await copyFile(file.source, destination)
          const content = await readFile(destination)
          if (content.length > MAX_BOOK_BYTES || contentHash(content) !== file.sha256) throw new Error('批量上传前文件校验失败。')
          bytes += content.length
        }
        await writeFile(list, files.map(file => file.name).join('\n') + '\n')
        const common = ['--config', config, '--files-from-raw', list, '--local-encoding', 'None', '--no-traverse', '--transfers', '4', '--checkers', '4', '--buffer-size', '1M', '--multi-thread-streams', '0', '--retries', '2', '--contimeout', '15s', '--timeout', '60s']
        await this.execute(this.executable, ['copy', source, `remote:${remote}`, ...common, '--checksum', '--immutable'], { timeout: 30 * 60 * 1000 })
        onVerify()
        await this.execute(this.executable, ['copy', `remote:${remote}`, verified, ...common, '--ignore-times', '--max-transfer', String(bytes + 1024 * files.length), '--cutoff-mode', 'HARD'], { timeout: 30 * 60 * 1000 })
        for (const file of files) if (contentHash(await readFile(path.join(verified, file.name))) !== file.sha256) throw new Error('网盘批量回读校验不一致，尚未标记成功。')
      } finally {
        if (path.dirname(path.resolve(directory)) !== path.resolve(this.directory)) throw new Error('临时上传目录不在预期位置。')
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  async search(accountId: string, query: string, folder = 'KindleSpouse/Inbox'): Promise<CloudEntry[]> {
    const normalized = query.normalize('NFKC').toLowerCase()
    return this.withConfig(accountId, async (config) => {
      const output = await this.execute(
        this.executable,
        [
          'lsjson',
          `remote:${safeRemotePath(folder)}`,
          '--config',
          config,
          '--recursive',
          '--files-only',
          '--ignore-case',
          ...KOREADER_EXTENSIONS.flatMap(extension => ['--include', '*.' + extension]),
          '--max-depth',
          '8',
          '--no-modtime',
          '--no-mimetype',
        ],
        { timeout: 90000 },
      ).catch(error => {
        if (/directory not found|directory doesn't exist/i.test(error instanceof Error ? error.message : String(error))) return '[]'
        throw error
      })
      return (JSON.parse(output) as { Name: string; Path: string; Size: number }[])
        .filter((item) => isKoreaderFilename(item.Name) && item.Name.normalize('NFKC').toLowerCase().includes(normalized))
        .slice(0, 150)
        .map((item) => ({ name: item.Name, path: safeRemotePath([folder, item.Path].filter(Boolean).join('/')), size: item.Size, isDir: false }))
    })
  }

  async readBytes(accountId: string, remotePath: string, max = 4 * 1024 * 1024) {
    return this.withConfig(accountId, async (config) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'KS-cloud-read-'))
      const filename = path.join(directory, 'content')
      try {
        await this.execute(
          this.executable,
          [
            'copyto',
            `remote:${safeRemotePath(remotePath)}`,
            filename,
            '--config',
            config,
            '--max-transfer',
            String(max),
            '--cutoff-mode',
            'HARD',
            '--retries',
            '1',
          ],
          { timeout: 90000 },
        )
        const bytes = await readFile(filename)
        if (bytes.length > max) throw new Error('文件超过读取上限。')
        return bytes
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  async writeBytes(accountId: string, remotePath: string, bytes: Uint8Array, immutable = true) {
    return this.withConfig(accountId, async (config) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'KS-cloud-write-'))
      const filename = path.join(directory, 'content')
      try {
        await writeFile(filename, bytes)
        await runProcess(
          this.executable,
          [
            'copyto',
            filename,
            `remote:${safeRemotePath(remotePath)}`,
            '--config',
            config,
            ...(immutable ? ['--immutable'] : []),
            '--retries',
            '2',
          ],
          { timeout: 180000 },
        )
        const verify = path.join(directory, 'verified')
        await runProcess(
          this.executable,
          [
            'copyto',
            `remote:${safeRemotePath(remotePath)}`,
            verify,
            '--config',
            config,
            '--max-transfer',
            String(bytes.length + 1024),
            '--cutoff-mode',
            'HARD',
          ],
          { timeout: 180000 },
        )
        if (contentHash(await readFile(verify)) !== contentHash(Buffer.from(bytes)))
          throw new Error('网盘回读校验失败。')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  async readText(accountId: string, filename: string) {
    if (!/\.(txt|md|markdown|json|csv)$/i.test(filename)) throw new Error('仅可编辑文本、Markdown、JSON 或 CSV。')
    const bytes = await this.readBytes(accountId, filename, 1024 * 1024)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, hash: contentHash(bytes) }
  }

  async mutate(accountId: string, mutation: CloudMutation, managedFolder = 'KindleSpouse/Sync') {
    const source = safeRemotePath(mutation.path)
    const managed = safeRemotePath(managedFolder)
    const destination = mutation.destination === undefined ? undefined : safeRemotePath(mutation.destination)
    const protectedPath = (value: string) =>
      !value ||
      value === '.KindleSpouse-Trash' ||
      value.startsWith('.KindleSpouse-Trash/') ||
      value === managed ||
      value.startsWith(managed + '/') ||
      managed.startsWith(value + '/')
    if (protectedPath(source) || (destination !== undefined && protectedPath(destination)))
      throw new Error('同步目录与根目录由应用管理，请选择其他位置。')
    if (mutation.action === 'write') {
      if (
        !/\.(txt|md|markdown|json|csv)$/i.test(source) ||
        mutation.text === undefined ||
        Buffer.byteLength(mutation.text) > 1024 * 1024 ||
        !mutation.expectedHash
      )
        throw new Error('保存文本需要原版本指纹，文件不能超过 1 MB。')
      const previous = await this.readBytes(accountId, source, 1024 * 1024)
      if (contentHash(previous) !== mutation.expectedHash) throw new Error('网盘文件已更新，请重新打开后编辑。')
      await this.writeBytes(
        accountId,
        `.KindleSpouse-Versions/${contentHash(previous)}/${path.posix.basename(source)}`,
        previous,
      )
      await this.writeBytes(accountId, source, Buffer.from(mutation.text), false)
      return
    }
    return this.withConfig(accountId, async (config) => {
      if (mutation.action === 'mkdir')
        await runProcess(this.executable, ['mkdir', `remote:${source}`, '--config', config], { timeout: 90000 })
      else {
        const target =
          mutation.action === 'trash'
            ? `.KindleSpouse-Trash/${Date.now()}-${randomUUID()}/${path.posix.basename(source)}`
            : destination
        if (!target) throw new Error('请选择目标路径。')
        await runProcess(
          this.executable,
          ['moveto', `remote:${source}`, `remote:${target}`, '--config', config, '--immutable'],
          { timeout: 180000 },
        )
      }
    })
  }

  async separateDeviceCredential(accountId: string) {
    const original = this.secrets.get(`cloud:${accountId}`)
    if (!original) throw new Error('请先连接网盘。')
    const provider = (JSON.parse(original) as CloudCredential).provider
    const account = await this.connect(provider)
    const value = this.secrets.get(`cloud:${account.id}`)
    if (!value) throw new Error('设备授权未完成。')
    const credential = JSON.parse(value) as CloudCredential
    const extra =
      credential.provider === 'drive'
        ? 'scope = drive\n'
        : `drive_id = ${credential.driveId}\ndrive_type = ${credential.driveType}\n`
    return {
      accountId: account.id,
      config: `[remote]\ntype = ${provider}\n${extra}token = ${JSON.stringify(credential.token)}\n`,
    }
  }
}
