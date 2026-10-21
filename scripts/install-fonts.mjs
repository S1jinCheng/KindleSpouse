import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const directory = 'public/fonts'
const revision = '8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5'
const assets = [
  { remote: 'NotoSerifSC%5Bwght%5D.ttf', filename: 'NotoSerifSC-VF.ttf', sha256: '050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9', limit: 30 * 1024 * 1024 },
  { remote: 'OFL.txt', filename: 'NotoSerifSC-OFL.txt', sha256: '5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6', limit: 16384 },
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(directory, { recursive: true })
for (const asset of assets) {
  const filename = `${directory}/${asset.filename}`
  if (hash(await readFile(filename).catch(() => Buffer.alloc(0))) === asset.sha256) continue
  const response = await fetch(`https://raw.githubusercontent.com/google/fonts/${revision}/ofl/notoserifsc/${asset.remote}`, { signal: AbortSignal.timeout(120000) })
  if (!response.ok || Number(response.headers.get('content-length')) > asset.limit) throw new Error(`Could not obtain ${asset.filename}.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > asset.limit || hash(bytes) !== asset.sha256) throw new Error(`${asset.filename} fingerprint mismatch.`)
  await writeFile(filename, bytes)
}
console.log('Noto Serif SC: original variable font and OFL license verified.')
