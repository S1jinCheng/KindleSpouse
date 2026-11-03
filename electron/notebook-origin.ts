import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { contentHash } from './books'
import type { StoredNotebook } from '../src/shared'

export const notebookManifest = z.object({
  deviceId: z.string().min(1).max(256).optional(),
  createdAt: z.string().optional(),
  files: z.array(z.object({ relative: z.string().min(1).max(4096), bytes: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
})

export function notebookOrigin(directory: string, relative: string, deviceId?: string): NonNullable<StoredNotebook['origin']> {
  return deviceId ? { kind: 'device', deviceId, relative } : { kind: 'snapshot', directory: path.resolve(directory), relative }
}

export function notebookSourceKey(origin: NonNullable<StoredNotebook['origin']>) {
  return contentHash(Buffer.from(JSON.stringify(origin.kind === 'device' ? ['device', origin.deviceId, origin.relative] : ['snapshot', origin.directory, origin.relative])))
}

export async function storedNotebookOrigin(book: StoredNotebook, profile: string) {
  const filename = path.resolve(book.path)
  const root = path.resolve(profile)
  if (!filename.startsWith(root + path.sep)) return
  for (let directory = path.dirname(filename); directory.startsWith(root + path.sep) || directory === root; directory = path.dirname(directory)) {
    const bytes = await readFile(path.join(directory, 'snapshot-manifest.json')).catch(() => undefined)
    if (bytes) {
      try {
        const manifest = notebookManifest.parse(JSON.parse(bytes.toString('utf8')))
        const relative = path.relative(directory, filename).split(path.sep).join('/')
        if (!manifest.files.some(file => file.relative.replaceAll('\\', '/') === relative && file.sha256 === book.sha256)) return
        return notebookOrigin(directory, relative, manifest.deviceId)
      } catch { return }
    }
    if (directory === root) return
  }
}
