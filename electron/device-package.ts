import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'

export const DEVICE_READER_VERSION = 'v2026.07.1'

export async function companionPackage(nativeDirectory: string) {
  if (!existsSync(path.join(nativeDirectory, 'tools/reader-fonts'))) throw new Error('中文字体组件不完整，请重新安装完整的 KindleSpouse。')
  const zip = new JSZip()
  const bundle = path.join(nativeDirectory, 'tools/companion')
  for (const file of ['kindlespouse-sync', 'rclone', 'ca.pem']) zip.file(`kindlespouse/${file}`, await readFile(path.join(bundle, file)), { unixPermissions: 0o700 })
  for (const file of ['Go-LICENSE.txt', 'rclone-LICENSE.txt', 'CA-MPL-2.0.txt']) zip.file(`kindlespouse/licenses/${file}`, await readFile(path.join(bundle, file)))
  for (const file of ['catalog.sh', 'sync.sh']) zip.file(`kindlespouse/${file}`, await readFile(path.join(nativeDirectory, 'companion', file)), { unixPermissions: 0o700 })
  for (const file of await readdir(path.join(nativeDirectory, 'companion/plugin'))) {
    if (!/^[a-zA-Z0-9_.-]+\.lua$/.test(file) && file !== 'LICENSE') throw new Error('设备插件目录含有不支持的文件。')
    zip.file(`koreader/plugins/kindlespouse.koplugin/${file}`, await readFile(path.join(nativeDirectory, 'companion/plugin', file)))
  }
  await addReaderFonts(zip, nativeDirectory)
  await addSleepPlugin(zip, nativeDirectory)
  const files = []
  for (const file of Object.values(zip.files).filter(file => !file.dir).sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await file.async('nodebuffer')
    files.push({ relative: file.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  zip.file('kindlespouse/component-manifest.json', JSON.stringify({ version: 1, protocol: 1, readerVersion: DEVICE_READER_VERSION, revision, files }))
  return zip
}

export async function addReaderFonts(zip: JSZip, nativeDirectory: string) {
  const root = path.join(nativeDirectory, 'tools/reader-fonts')
  if (!existsSync(root)) return
  const manifest = JSON.parse(await readFile(path.join(nativeDirectory, 'reader-fonts.json'), 'utf8')) as { assets: { filename: string; target: string; sha256: string }[] }
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(root, asset.filename))
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Reader font fingerprint mismatch: ${asset.filename}`)
    zip.file(asset.target, bytes)
  }
  zip.file('kindlespouse/licenses/reader-fonts/manifest.json', JSON.stringify(manifest, null, 2))
}

export async function addSleepPlugin(zip: JSZip, nativeDirectory: string) {
  const root = path.join(nativeDirectory, 'tools/sleep-screen')
  if (!existsSync(path.join(root, 'spouse_preset.lua'))) throw new Error('请先构建休眠封面插件。')
  const visit = async (relative: string) => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) await visit(name)
      else zip.file(name === 'upstream-source.zip' ? 'kindlespouse/licenses/sleep-screen-upstream.zip' : `koreader/plugins/customisablesleepscreen.koplugin/${name}`, await readFile(path.join(root, name)))
    }
  }
  await visit('')
}
