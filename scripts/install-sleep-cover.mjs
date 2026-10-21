import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const commit = 'feb29ac02bbafeac32ccc9ceb471869c233ea253'
const expected = '7dad30adda75bb799b2f3f04c173a2c1b4c7bd7f60e904916e4b15564fdc4811'
const directory = path.resolve('native/tools/sleep-screen')
await mkdir(directory, { recursive: true })
let bytes = await readFile(path.join(directory, 'upstream-source.zip')).catch(() => undefined)
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
  const response = await fetch(`https://codeload.github.com/pxlflux/customisablesleepscreen.koplugin/zip/${commit}`)
  if (!response.ok) throw new Error('Sleep screen source download failed')
  bytes = Buffer.from(await response.arrayBuffer())
}
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Sleep screen source checksum mismatch')
await writeFile(path.join(directory, 'upstream-source.zip'), bytes)
const zip = await JSZip.loadAsync(bytes)
for (const file of Object.values(zip.files)) {
  if (file.dir) continue
  const relative = file.name.split('/').slice(1).join('/')
  if (!relative || relative.split('/').some(part => part === '..' || part === '.') || relative.startsWith('.git')) continue
  const target = path.join(directory, relative)
  await mkdir(path.dirname(target), { recursive: true })
  let content = await file.async('nodebuffer')
  if (relative === 'main.lua') content = Buffer.from(content.toString('utf8').replaceAll('insertDB(ui.statistics.id_curr_book)', 'insertDB()'))
  if (relative === 'css_infobox.lua') {
    const source = content.toString('utf8')
    if (!source.includes('buildInfoBox               = layout_mod.buildInfoBox,')) throw new Error('Upstream sleep interface changed')
    content = Buffer.from(source.replace('buildInfoBox               = layout_mod.buildInfoBox,', 'buildInfoBox               = require("spouse_preset").wrap(layout_mod.buildInfoBox),'))
  }
  await writeFile(target, content)
}
await writeFile(path.join(directory, 'spouse_preset.lua'), await readFile('native/sleep-cover/preset.lua'))
await writeFile(path.join(directory, 'BUILD.txt'), `Upstream: https://github.com/pxlflux/customisablesleepscreen.koplugin\nCommit: ${commit}\nSHA256: ${expected}\nLicense: AGPL-3.0. Full original source archive and complete modified source are included.\nChanges: KindleSpouse editorial cover preset; statistics insertDB() argument correction.\n`)
console.log('Pinned Customisable Sleep Screen installed with KindleSpouse preset, source and licenses.')
