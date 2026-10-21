import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class SleepPreviewCache {
  private pending = new Map<string, Promise<Uint8Array>>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {}
  get(key: string, render: () => Promise<Uint8Array>) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('无效的封面缓存标识。')
    const existing = this.pending.get(key)
    if (existing) return existing
    const task = this.queue.catch(() => {}).then(async () => {
      const filename = path.join(this.directory, key + '.png')
      const cached = await readFile(filename).catch(() => undefined)
      if (cached && cached.length > 32 && cached.length < 16 * 1024 ** 2 && cached.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return cached
      const image = await render()
      await mkdir(this.directory, { recursive: true })
      await writeFile(filename, image)
      return image
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    this.queue = task
    return task
  }
  async close() { await this.queue.catch(() => {}) }
}
