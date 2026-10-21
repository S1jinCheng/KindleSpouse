import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export async function verifyDistribution(nativeDirectory) {
  const manifest = JSON.parse(await readFile(path.join(nativeDirectory, 'distribution-requirements.json'), 'utf8'))
  const failures = []
  for (const relative of manifest.files) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw new Error('Invalid distribution requirement.')
    const file = await stat(path.join(nativeDirectory, relative)).catch(() => undefined)
    if (!file?.isFile() || !file.size) failures.push(relative)
  }
  const fonts = JSON.parse(await readFile(path.join(nativeDirectory, 'reader-fonts.json'), 'utf8'))
  for (const asset of fonts.assets) {
    const bytes = await readFile(path.join(nativeDirectory, 'tools/reader-fonts', asset.filename)).catch(() => Buffer.alloc(0))
    if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) failures.push(`tools/reader-fonts/${asset.filename}`)
  }
  if (failures.length) throw new Error('Incomplete distribution:\n' + failures.join('\n'))
  return { requiredFiles: manifest.files.length, verifiedFontAssets: fonts.assets.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyDistribution(path.resolve(process.argv[2] || 'native'))))
