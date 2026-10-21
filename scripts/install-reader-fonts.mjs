import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../native/reader-fonts.json', import.meta.url), 'utf8'))
const directory = new URL('../native/tools/reader-fonts/', import.meta.url)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(directory, { recursive: true })
for (const asset of manifest.assets) {
  const filename = new URL(asset.filename, directory)
  if (hash(await readFile(filename).catch(() => Buffer.alloc(0))) === asset.sha256) continue
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok || Number(response.headers.get('content-length')) > asset.bytes) throw new Error(`Could not obtain ${asset.filename}.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error(`${asset.filename} fingerprint mismatch.`)
  const temporary = new URL(asset.filename + '.partial', directory)
  await writeFile(temporary, bytes)
  await rename(temporary, filename)
}
console.log(`Reader fonts verified: ${manifest.assets.filter(asset => asset.style).length} static Chinese font families and original licenses.`)
