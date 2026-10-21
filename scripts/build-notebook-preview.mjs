import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import JSZip from 'jszip'
import { build } from 'esbuild'

const root = process.cwd()
const staging = path.resolve((await readFile('.test-data/notebook-preview-latest.txt', 'utf8')).trim())
if (!staging.startsWith(path.join(root, '.test-data', 'notebook-preview-'))) throw new Error('Invalid preview staging directory')
const files = path.join(staging, 'files')
const engineManifest = JSON.parse(await readFile('experiments/notebook/engine.json', 'utf8'))
const source = await readFile('native/tools/notebook-koplugin/upstream-source.zip')
if (createHash('sha256').update(source).digest('hex') !== engineManifest.sha256) throw new Error('Notebook engine source fingerprint mismatch')
const archive = await JSZip.loadAsync(source)
async function output(relative, bytes) {
  const filename = path.join(files, relative)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, bytes, { flag: 'wx' })
}
for (const item of Object.values(archive.files)) {
  const relative = item.name.split('/').slice(1).join('/')
  if (item.dir || relative.split('/').some(part => part === '.' || part === '..')) continue
  if (/^lua\/(?!spec\/)(?:[^/]+\.lua|icons\/[^/]+\.svg|locale\/[^/]+\.po)$/.test(relative)) {
    await output('koreader/kindlespouse-notebook/engine/' + relative.slice(4), await item.async('nodebuffer'))
    if (relative.startsWith('lua/icons/')) await output('koreader/icons/' + path.posix.basename(relative), await item.async('nodebuffer'))
  } else if (relative === 'LICENSE') await output('koreader/kindlespouse-notebook/ENGINE-LICENSE', await item.async('nodebuffer'))
}
for (const name of ['main.lua', 'home.lua', 'library.lua', 'shelf.lua', 'profile.lua', '_meta.lua', 'annotation_apply.lua', 'LICENSE']) await output('koreader/plugins/kindlespouse.koplugin/' + name, await readFile('native/companion/plugin/' + name))
for (const name of ['embedded.lua', 'gallery.lua', 'import.lua', 'engine.json', 'LICENSE']) await output('koreader/kindlespouse-notebook/' + name, await readFile('experiments/notebook/' + name))
await output('koreader/patches/2-kindlespouse-notebook-preview.lua', await readFile('experiments/notebook/preview.lua'))
await build({ entryPoints: ['experiments/notebook/decode.mjs'], outfile: 'native/tools/notebook-converter/export-native-vectors.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', legalComments: 'external' })
let records = []
try {
  const database = new DatabaseSync(path.join(process.env.APPDATA, 'KindleSpouse', 'kindlespouse.sqlite'), { readOnly: true })
  try { records = database.prepare("SELECT payload FROM records WHERE namespace='notebooks'").all().map(row => JSON.parse(row.payload)) } finally { database.close() }
} catch {}
const titles = new Map(records.filter(book => book.identity && book.title && !['unresolved'].includes(book.titleSource)).map(book => [book.identity.toLowerCase(), book.title]))
const inputs = JSON.parse(await readFile(path.join(staging, 'inputs.json'), 'utf8'))
await mkdir(path.join(staging, 'vectors'))
await mkdir(path.join(files, 'koreader/notebook/Scribe 可编辑副本'), { recursive: true })
const converted = [], failures = [], used = new Set()
for (const [index, notebook] of inputs.notebooks.entries()) {
  const vector = path.join(staging, 'vectors', notebook.identity + '.json')
  const before = await readFile(notebook.source)
  if (createHash('sha256').update(before).digest('hex') !== notebook.sha256) throw new Error('Local notebook snapshot changed')
  try {
    execFileSync(process.execPath, ['native/tools/notebook-converter/export-native-vectors.mjs', notebook.source, vector], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
    let title = (titles.get(notebook.identity.toLowerCase()) ?? `Scribe 笔记 ${index + 1}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim().slice(0, 55)
    if (!title || /^\.+$/.test(title)) title = `Scribe 笔记 ${index + 1}`
    let filename = title + '.scribe', suffix = 2
    while (used.has(filename.toLowerCase())) filename = title + ` (${suffix++}).scribe`
    used.add(filename.toLowerCase())
    converted.push({ source: notebook.source, sha256: notebook.sha256, vector, filename })
  } catch {
    failures.push({ identity: notebook.identity, reason: 'Native notebook variant could not be decoded' })
  }
}
await writeFile(path.join(staging, 'converted.json'), JSON.stringify({ converted, failures, files }), { flag: 'wx' })
console.log(JSON.stringify({ preparedCode: true, decodedNotebooks: converted.length, unsupportedNotebooks: failures.length, originalFilesChanged: false }))
