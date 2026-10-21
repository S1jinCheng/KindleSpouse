import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const tools = [
  { name: 'zlib', url: 'https://github.com/heartleo/zlib/releases/download/v0.0.8/zlib_0.0.8_windows_x86_64.zip', sha256: '9ed402ff2f2c1fde9c51b3a354eb161f468bf77bd577d1396af9faa3da4a726e' },
  { name: 'rclone', url: 'https://github.com/rclone/rclone/releases/download/v1.75.2/rclone-v1.75.2-windows-amd64.zip', sha256: '8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818' },
]
const destination = path.resolve('native/tools')
await mkdir(destination, { recursive: true })
for (const tool of tools) {
  const response = await fetch(tool.url)
  if (!response.ok) throw new Error(`${tool.name}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== tool.sha256) throw new Error(`${tool.name}: checksum mismatch`)
  const zip = await JSZip.loadAsync(bytes)
  const binary = Object.values(zip.files).find(file => path.basename(file.name).toLowerCase() === tool.name + '.exe')
  if (!binary) throw new Error(`${tool.name}: binary not found`)
  await writeFile(path.join(destination, tool.name + '.exe'), await binary.async('nodebuffer'))
  const license = Object.values(zip.files).find(file => /^(licen[sc]e|copying)(\.txt|\.md)?$/i.test(path.basename(file.name)))
  if (license) await writeFile(path.join(destination, tool.name + '-LICENSE.txt'), await license.async('nodebuffer'))
  else if (tool.name === 'rclone') {
    const response = await fetch('https://raw.githubusercontent.com/rclone/rclone/v1.75.2/COPYING')
    if (!response.ok) throw new Error('rclone license download failed')
    await writeFile(path.join(destination, 'rclone-LICENSE.txt'), await response.text())
  }
  const hash = createHash('sha256').update(await readFile(path.join(destination, tool.name + '.exe'))).digest('hex')
  console.log(`${tool.name}: installed, SHA256 ${hash}`)
}
await import('./install-notebook-tool.mjs')
