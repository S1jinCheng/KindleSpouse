import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import { contentHash, MAX_BOOK_BYTES } from './books'
import { CloudBridge, safeRemotePath } from './cloud'
import { Store } from './store'
import type { StoredNotebook } from '../src/shared'

export interface SyncFile { relative: string; bytes: number; sha256: string }
export interface SyncBundle { sha256: string; bytes: number; objects: string[] }
export interface SyncManifest { version: number; deviceId: string; createdAt: string; files: SyncFile[]; bundles?: SyncBundle[] }
const hashPattern = /^[a-f0-9]{64}$/
export const MAX_BUNDLE_BYTES = MAX_BOOK_BYTES + 1024 * 1024

export function bundleEntries(bytes: Buffer, bundle: SyncBundle) {
  if (bytes.length !== bundle.bytes || contentHash(bytes) !== bundle.sha256) throw new Error('网盘同步包校验失败。')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('同步包格式无效。')
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12)
  if (!count || count > 20000 || count !== bundle.objects.length || start + size > end || new Set(bundle.objects).size !== count) throw new Error('同步包文件清单无效。')
  const expected = new Set(bundle.objects), entries = new Map<string, number>()
  let offset = start, expanded = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('同步包目录无效。')
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), length = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), mode = bytes.readUInt32LE(offset + 38) >>> 16
    if (offset + 46 + nameLength + extra + comment > start + size) throw new Error('同步包目录越界。')
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (!hashPattern.test(name) || !expected.has(name) || entries.has(name) || flags & 1 || ![0, 8].includes(method) || mode & 0xf000 && (mode & 0xf000) !== 0x8000 || length > MAX_BOOK_BYTES) throw new Error('同步包包含无效文件。')
    expanded += length
    entries.set(name, length)
    offset += 46 + nameLength + extra + comment
  }
  if (offset !== start + size || expanded > 16 * 1024 ** 2 && count !== 1) throw new Error('同步包解压体积超过上限。')
  return entries
}

export class SyncObjects {
  private seeds?: Promise<Map<string, string>>
  private directory: string
  constructor(private root: string, private store: Store, private cloud: CloudBridge, private move: typeof rename = rename) { this.directory = path.join(root, 'cloud-objects') }

  private async promote(source: string, destination: string, file: { bytes: number; sha256: string }) {
    try { await this.move(source, destination) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyFile(source, destination)
      if (!await this.valid(destination, file)) throw new Error('网盘缓存原件校验失败。')
      await rm(source, { force: true })
    }
  }

  private async valid(filename: string, file: { bytes: number; sha256: string }) {
    const info = await stat(filename).catch(() => undefined)
    if (!info?.isFile() || info.size !== file.bytes) return false
    return contentHash(await readFile(filename)) === file.sha256
  }

  private seedFiles() {
    this.seeds ??= (async () => {
      const values = new Map<string, string>()
      for (const book of this.store.list<StoredNotebook>('notebooks')) if (book.path && hashPattern.test(book.sha256)) values.set(book.sha256, book.path)
      const scan = async (directory: string, depth: number) => {
        if (depth > 4) return
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
        if (entries.some((entry) => entry.name === 'snapshot-manifest.json' && entry.isFile())) {
          const filename = path.join(directory, 'snapshot-manifest.json')
          try {
            const info = await stat(filename)
            if (info.size > 16 * 1024 ** 2) return
            const manifest = JSON.parse(await readFile(filename, 'utf8'))
            if (!Array.isArray(manifest.files) || manifest.files.length > 20000) return
            for (const file of manifest.files) {
              if (typeof file.relative !== 'string' || !hashPattern.test(file.sha256)) continue
              const relative = safeRemotePath(file.relative), source = path.resolve(directory, relative)
              if (source.startsWith(directory + path.sep)) values.set(file.sha256, source)
            }
          } catch {}
          return
        }
        for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) await scan(path.join(directory, entry.name), depth + 1)
      }
      for (const name of ['notes-backups', 'device-backups', 'cloud-snapshots', 'notebook-catalogs']) await scan(path.join(this.root, name), 0)
      return values
    })()
    return this.seeds
  }

  async materialize(account: string, remoteRoot: string, manifest: SyncManifest, destination: string, progress: (done: number, total: number, bytes?: number, totalBytes?: number) => void = () => {}) {
    await mkdir(this.directory, { recursive: true })
    const expected = new Map<string, SyncFile>(), paths = new Set<string>()
    let total = 0
    for (const file of manifest.files) {
      const relative = safeRemotePath(file.relative), target = path.resolve(destination, relative), key = process.platform === 'win32' ? target.toLowerCase() : target
      if (!relative || !target.startsWith(destination + path.sep) || !/^(?:\.notebooks\/|documents\/|Books\/|cc\.db$|ksdk\.content\.db$|statistics\.sqlite3$)/.test(relative) || paths.has(key) || total + file.bytes > 5 * 1024 ** 3) throw new Error('同步清单包含无效路径或重复文件。')
      paths.add(key)
      total += file.bytes
      const prior = expected.get(file.sha256)
      if (prior && prior.bytes !== file.bytes) throw new Error('同步清单内容大小不一致。')
      expected.set(file.sha256, file)
    }
    const missing = new Map<string, SyncFile>()
    const seeds = await this.seedFiles()
    for (const [hash, file] of expected) {
      const cached = path.join(this.directory, hash)
      if (await this.valid(cached, file)) continue
      const source = seeds.get(hash)
      if (source && await this.valid(source, file)) await copyFile(source, cached)
      else missing.set(hash, file)
    }
    const mapping = new Map<string, SyncBundle>(), bundleIds = new Set<string>()
    for (const bundle of manifest.bundles ?? []) {
      if (bundleIds.has(bundle.sha256) || new Set(bundle.objects).size !== bundle.objects.length) throw new Error('同步包清单重复。')
      bundleIds.add(bundle.sha256)
      for (const hash of bundle.objects) {
        if (mapping.has(hash)) throw new Error('同步包内容重复映射。')
        mapping.set(hash, bundle)
      }
    }
    const bundles = [...new Map([...missing.keys()].filter((hash) => mapping.has(hash)).map((hash) => [mapping.get(hash)!.sha256, mapping.get(hash)!])).values()]
    const pending = path.join(this.directory, 'pending')
    const packs = path.join(pending, 'bundles')
    await mkdir(packs, { recursive: true })
    const download = []
    for (const bundle of bundles) if (!await this.valid(path.join(packs, bundle.sha256 + '.zip'), bundle)) download.push(bundle.sha256 + '.zip')
    let failure: unknown
    try { await this.cloud.downloadMany(account, `${remoteRoot}/bundles`, download, packs, (bytes, totalBytes) => progress(expected.size - missing.size, expected.size, bytes, totalBytes)) }
    catch (error) { failure = error }
    for (const bundle of bundles) {
      const filename = path.join(packs, bundle.sha256 + '.zip')
      if (!await this.valid(filename, bundle)) { failure ??= new Error('网盘同步包校验失败。'); continue }
      await this.unpack(await readFile(filename), bundle)
      for (const hash of bundle.objects) if (missing.has(hash) && await this.valid(path.join(this.directory, hash), missing.get(hash)!)) missing.delete(hash)
      progress(expected.size - missing.size, expected.size)
    }
    if (failure) throw failure
    const raw = [...missing.keys()].filter((hash) => !mapping.has(hash))
    const rawDirectory = path.join(pending, 'objects')
    await mkdir(rawDirectory, { recursive: true })
    try { await this.cloud.downloadMany(account, `${remoteRoot}/objects`, raw, rawDirectory, (bytes, totalBytes) => progress(expected.size - missing.size, expected.size, bytes, totalBytes)) }
    catch (error) { failure = error }
    for (const hash of raw) {
      const file = missing.get(hash)!, source = path.join(rawDirectory, hash)
      if (!await this.valid(source, file)) { failure ??= new Error('网盘笔记原件校验失败。'); continue }
      await this.promote(source, path.join(this.directory, hash), file)
      missing.delete(hash)
    }
    if (failure) throw failure
    if (missing.size) throw new Error('同步包缺少需要的笔记内容。')
    for (const file of manifest.files) {
      const filename = path.resolve(destination, safeRemotePath(file.relative))
      await mkdir(path.dirname(filename), { recursive: true })
      if (!await this.valid(filename, file)) await copyFile(path.join(this.directory, file.sha256), filename)
    }
    progress(expected.size, expected.size)
  }

  private async unpack(bytes: Buffer, bundle: SyncBundle) {
    const sizes = bundleEntries(bytes, bundle)
    const zip = await JSZip.loadAsync(bytes)
    for (const [hash, size] of sizes) {
      const filename = path.join(this.directory, hash)
      if (await this.valid(filename, { sha256: hash, bytes: size })) continue
      const entry = zip.file(hash)
      if (!entry || entry.dir || entry.unsafeOriginalName && entry.unsafeOriginalName !== hash) throw new Error('同步包文件名无效。')
      const temporary = path.join(this.directory, '.partial-' + randomUUID())
      const target = await open(temporary, 'wx', 0o600), digest = createHash('sha256')
      let length = 0
      const stream = new Readable().wrap(entry.nodeStream())
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk)
          length += buffer.length
          if (length > size) throw new Error('同步包解压体积不符。')
          digest.update(buffer)
          await target.writeFile(buffer)
        }
        if (length !== size || digest.digest('hex') !== hash) throw new Error('同步包内笔记校验失败。')
        await target.close()
        await this.promote(temporary, filename, { bytes: size, sha256: hash })
      } finally { stream.destroy(); await target.close().catch(() => {}); await rm(temporary, { force: true }) }
    }
  }
}
