import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const commit = '44db6b6ee8c0094a98c33770575a9070ddb90fda'
const expected = '799ca3c54ef3f40129ceb887ac16c7af4cddfe6a2f41eb1c620393bed1988a45'
const directory = path.resolve('native/tools/kfx-input')
await mkdir(directory, { recursive: true })
let bytes = await readFile(path.join(directory, 'upstream-source.zip')).catch(() => undefined)
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
  const response = await fetch(`https://codeload.github.com/kluyg/calibre-kfx-input/zip/${commit}`)
  if (!response.ok) throw new Error('KFX input source download failed')
  bytes = Buffer.from(await response.arrayBuffer())
}
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('KFX input checksum mismatch')
await writeFile(path.join(directory, 'upstream-source.zip'), bytes)
const zip = await JSZip.loadAsync(bytes)
for (const file of Object.values(zip.files)) {
  if (file.dir) continue
  const relative = file.name.split('/').slice(1).join('/')
  if (!relative || relative.includes('..') || !/^(kfxlib\/|LICENSE$|README.md$)/.test(relative)) continue
  const target = path.join(directory, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, await file.async('nodebuffer'))
}
await writeFile(path.join(directory, 'BUILD.txt'), `Upstream: John Howell KFX Input, mirrored at https://github.com/kluyg/calibre-kfx-input\nCommit: ${commit}\nArchive SHA256: ${expected}\nLicense: GPL-3.0. Complete unmodified upstream source is included in upstream-source.zip. No DRM removal is included.\n`)
const wheelUrl = 'https://files.pythonhosted.org/packages/48/d9/6cff57c80a6963e7dd183bf09e9f21604a77716644b1e580e97b259f7612/pypdf-5.9.0-py3-none-any.whl'
const wheelHash = 'be10a4c54202f46d9daceaa8788be07aa8cd5ea8c25c529c50dd509206382c35'
const wheelPath = path.join(directory, 'pypdf-5.9.0-py3-none-any.whl')
let wheel = await readFile(wheelPath).catch(() => undefined)
if (!wheel || createHash('sha256').update(wheel).digest('hex') !== wheelHash) {
  const response = await fetch(wheelUrl)
  if (!response.ok) throw new Error('PDF library download failed')
  wheel = Buffer.from(await response.arrayBuffer())
}
if (createHash('sha256').update(wheel).digest('hex') !== wheelHash) throw new Error('PDF library checksum mismatch')
await writeFile(wheelPath, wheel)
const pdf = await JSZip.loadAsync(wheel)
for (const file of Object.values(pdf.files)) {
  if (file.dir || file.name.includes('..') || !/^(pypdf\/|pypdf-5\.9\.0\.dist-info\/)/.test(file.name)) continue
  const target = path.join(directory, file.name)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, await file.async('nodebuffer'))
}
console.log('KFX personal-document reader installed with pinned source and license.')
