import JSZip from 'jszip'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const zip = new JSZip()
for (const [source, target] of [
  ['native/tools/companion/kindlespouse-sync', 'kindlespouse/kindlespouse-sync'],
  ['native/companion/sync.sh', 'kindlespouse/sync.sh'],
  ['native/companion/plugin/main.lua', 'koreader/plugins/kindlespouse.koplugin/main.lua'],
  ['native/companion/plugin/home.lua', 'koreader/plugins/kindlespouse.koplugin/home.lua'],
  ['native/companion/plugin/library.lua', 'koreader/plugins/kindlespouse.koplugin/library.lua'],
  ['native/companion/plugin/shelf.lua', 'koreader/plugins/kindlespouse.koplugin/shelf.lua'],
  ['native/companion/plugin/profile.lua', 'koreader/plugins/kindlespouse.koplugin/profile.lua'],
]) zip.file(target, await readFile(source), { unixPermissions: 0o700, createFolders: false })
const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' })
await mkdir('artifacts', { recursive: true })
const filename = process.argv.includes('--full-sync') ? 'artifacts/KindleSpouse-AutoSync-Update.zip' : 'artifacts/KindleSpouse-AutoReceive-Update.zip'
await writeFile(filename, bytes)
await writeFile(filename + '.sha256', createHash('sha256').update(bytes).digest('hex') + '\n')
console.log(JSON.stringify({ package: filename, files: 7, bytes: bytes.length, containsCredentials: false }))
