import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../native/reader-fonts.json', import.meta.url), 'utf8'))
const directory = new URL('../native/tools/reader-fonts/', import.meta.url)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(directory, { recursive: true })
for (const asset of manifest.assets) {
  const filename = new URL(asset.filename, directory)
  if (hash(await readFile(filename).catch(() => Buffer.alloc(0))) === asset.sha256) continue
  const urls = asset.url.includes('/CTAN/')
    ? [asset.url.replace('https://mirrors.ustc.edu.cn/CTAN/', 'https://ctan.math.illinois.edu/'), asset.url.replace('https://mirrors.ustc.edu.cn/CTAN/', 'https://mirrors.ctan.org/'), asset.url]
    : [asset.url]
  let bytes
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok || Number(response.headers.get('content-length')) > asset.bytes) throw new Error(`Could not obtain ${asset.filename}.`)
      const downloaded = Buffer.from(await response.arrayBuffer())
      if (downloaded.length !== asset.bytes || hash(downloaded) !== asset.sha256) throw new Error(`${asset.filename} fingerprint mismatch.`)
      bytes = downloaded
      break
    } catch (error) {
      if (url === urls.at(-1)) throw error
    }
  }
  const temporary = new URL(asset.filename + '.partial', directory)
  await writeFile(temporary, bytes)
  await rename(temporary, filename)
}
console.log(`Reader fonts verified: ${manifest.assets.filter(asset => asset.style).length} static Chinese font families and original licenses.`)
