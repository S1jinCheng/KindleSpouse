import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const resources = [
  {
    url: 'https://go.dev/dl/go1.27.2.windows-amd64.zip',
    sha256: '1314008898bd40df77af4b014f777f08873dbdfbcd3d92308728ee03304fe04f',
    directory: '.test-data/go-sdk',
    all: true,
  },
  {
    url: 'https://downloads.rclone.org/v1.75.2/rclone-v1.75.2-linux-arm-v7.zip',
    sha256: '757a5b233ad0e8cdc60749a2d451231d81be45c01304a4c04b4514e733275b73',
    directory: 'native/tools/companion',
    all: false,
  },
]
for (const resource of resources) {
  const cache = path.resolve('.test-data/tool-cache', path.basename(new URL(resource.url).pathname))
  await mkdir(path.dirname(cache), { recursive: true })
  let bytes = await readFile(cache).catch(() => undefined)
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== resource.sha256) {
    const response = await fetch(resource.url)
    if (!response.ok) throw new Error(`Tool download failed: ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256)
      throw new Error('Companion tool checksum mismatch')
    await writeFile(cache, bytes)
  }
  const zip = await JSZip.loadAsync(bytes)
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue
    const relative = file.name.split('/').slice(1).join('/')
    if (
      !relative ||
      relative.includes('..') ||
      (!resource.all && !/^(rclone|COPYING|README\.html|rclone\.1)$/.test(relative))
    )
      continue
    const destination = path.resolve(resource.directory, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, await file.async('nodebuffer'))
  }
  console.log(`Installed verified ${path.basename(new URL(resource.url).pathname)}`)
}
const certificates = await fetch('https://curl.se/ca/cacert.pem')
if (!certificates.ok) throw new Error('CA certificate bundle download failed')
await writeFile('native/tools/companion/ca.pem', Buffer.from(await certificates.arrayBuffer()))
