import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, cp, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const staging = path.resolve((await readFile('.test-data/notebook-preview-latest.txt', 'utf8')).trim())
if (!staging.startsWith(path.resolve('.test-data/notebook-preview-'))) throw new Error('Invalid preview staging directory')
const runtime = path.resolve('native/tools/koreader/squashfs-root/usr/lib/koreader')
const linux = filename => `/mnt/${filename[0].toLowerCase()}/${filename.slice(3).replaceAll('\\', '/')}`
const converted = JSON.parse(await readFile(path.join(staging, 'converted.json'), 'utf8'))
await writeFile(path.join(staging, 'converted-linux.json'), JSON.stringify({ converted: converted.converted.map(item => ({ ...item, vector: linux(item.vector) })), destination: linux(path.join(staging, 'files/koreader/notebook/Scribe 可编辑副本')) }))
const disabled = (await readdir(path.join(runtime, 'plugins'))).filter(name => name.endsWith('.koplugin') && name !== 'coverbrowser.koplugin').map(name => `["${name.replace('.koplugin', '')}"]=true`).join(',')
async function settings(root) {
  await mkdir(path.join(root, 'books'), { recursive: true })
  await mkdir(path.join(root, 'patches'), { recursive: true })
  await writeFile(path.join(root, 'settings.reader.lua'), `return {language="zh_CN",last_migration_date=20260701,quickstart_shown_version=99999999,home_dir="${linux(path.join(root, 'books'))}",start_with="filemanager",disable_network_connection=true,auto_suspend_timeout_seconds=0,kindlespouse_auto_receive=false,kindlespouse_auto_sync=false,plugins_disabled={${disabled}}}`)
}
async function run(root, marker, extra = []) {
  const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linux(runtime), '--exec', 'env', 'SDL_VIDEODRIVER=dummy', 'SDL_AUDIODRIVER=dummy', `KO_HOME=${linux(root)}`, `KINDLESPOUSE_TEST_ROOT=${linux(process.cwd())}`, `KINDLESPOUSE_PREVIEW_STAGING=${linux(staging)}`, 'EMULATE_READER_W=1860', 'EMULATE_READER_H=2480', 'EMULATE_READER_DPI=300', 'LD_LIBRARY_PATH=libs', ...extra, './luajit', 'reader.lua', linux(path.join(root, 'books'))], { windowsHide: true })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes.toString() })
  child.stderr.on('data', bytes => { output += bytes.toString() })
  const timer = setTimeout(() => child.kill(), 180000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  clearTimeout(timer)
  await writeFile(path.join(root, 'runtime.log'), output)
  assert.equal(code, 0, output.slice(-5000))
  assert.ok(output.includes(marker), output.slice(-5000))
}
const preparation = path.join(staging, 'preparation-runtime')
await settings(preparation)
await cp(path.join(staging, 'files/koreader/icons'), path.join(preparation, 'icons'), { recursive: true })
await copyFile('experiments/notebook/prepare-import.lua', path.join(preparation, 'patches/2-prepare-import.lua'))
await run(preparation, 'Preview copies prepared:')
const result = JSON.parse(await readFile(path.join(staging, 'import-result.json'), 'utf8'))
const acceptance = path.join(staging, 'acceptance-runtime')
await cp(path.join(staging, 'files/koreader'), acceptance, { recursive: true })
await settings(acceptance)
await copyFile('tests/notebook-preview.lua', path.join(acceptance, 'patches/2-preview-acceptance.lua'))
await run(acceptance, 'Device preview package passed:', [`KINDLESPOUSE_PREVIEW_NOTEBOOKS=${result.imported}`])
for (const item of converted.converted) assert.equal(createHash('sha256').update(await readFile(item.source)).digest('hex'), item.sha256)
await writeFile(path.join(staging, 'verified.json'), JSON.stringify({ verified: true, imported: result.imported, skipped: result.skipped + converted.failures.length, pages: result.pages, strokes: result.strokes, sourceFilesUnchanged: true }))
console.log(JSON.stringify({ packageStartupPassed: true, importedNotebooks: result.imported, pages: result.pages, strokes: result.strokes, skipped: result.skipped + converted.failures.length, sourceFilesUnchanged: true }))
