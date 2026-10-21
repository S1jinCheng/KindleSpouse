import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const manifest = JSON.parse(await readFile('experiments/notebook/engine.json', 'utf8'))
const directory = path.resolve('native/tools/notebook-koplugin')
await mkdir(directory, { recursive: true })
const archiveFile = path.join(directory, 'upstream-source.zip')
let bytes = await readFile(archiveFile).catch(() => undefined)
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
  const response = await fetch(manifest.url)
  if (!response.ok) throw new Error('Notebook source download failed')
  bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Notebook source fingerprint mismatch')
  await writeFile(archiveFile, bytes)
}
const archive = await JSZip.loadAsync(bytes)
for (const item of Object.values(archive.files)) {
  const relative = item.name.split('/').slice(1).join('/')
  if (item.dir || !/^(lua\/|docs\/|LICENSE$|README.md$)/.test(relative) || relative.split('/').some(part => part === '..' || part === '.')) continue
  const filename = path.join(directory, relative)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, await item.async('nodebuffer'))
}
console.log('Pinned Notebook engine prepared for computer simulation. No device accessed.')
