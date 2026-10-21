import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile, copyFile, cp, appendFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import JSZip from 'jszip'

const root = path.resolve('.test-data/notebook-embedded-' + randomUUID())
const runtime = path.resolve('native/tools/koreader/squashfs-root/usr/lib/koreader')
const linux = filename => `/mnt/${filename[0].toLowerCase()}/${filename.slice(3).replaceAll('\\', '/')}`
await mkdir(path.join(root, 'patches'), { recursive: true })
await mkdir(path.join(root, 'books'), { recursive: true })
await mkdir(path.join(root, 'fonts'), { recursive: true })
for (const name of ['NotoSerifCJKsc-Regular.otf', 'NotoSansCJKsc-Regular.otf']) await copyFile(path.join('native/tools/reader-fonts', name), path.join(root, 'fonts', name))
await mkdir('artifacts', { recursive: true })
await cp('native/tools/notebook-koplugin/lua/icons', path.join(root, 'icons'), { recursive: true })
await writeFile('.test-data/notebook-embedded-latest.txt', root)
const book = new JSZip()
book.file('mimetype', 'application/epub+zip')
book.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
book.file('book.opf', '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">notebook-fixture</dc:identifier><dc:title>阅读的四季</dc:title><dc:creator>KindleSpouse</dc:creator></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>')
book.file('text.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>阅读的四季</title></head><body><h1>阅读的四季</h1><p>Notebook 模拟器书架样本。</p></body></html>')
const bookTitles = ['阅读的四季', '山间来信', '一日三餐', '慢慢走', '生活的形状', '一间自己的书房', '寻常故事', '昨日书简', '漫长的旅途', '春日来信', '理想的下午', '此时此地']
for (const [index, title] of bookTitles.entries()) {
  book.file('book.opf', `<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">notebook-fixture-${index}</dc:identifier><dc:title>${title}</dc:title><dc:creator>KindleSpouse</dc:creator><meta name="cover" content="cover"/></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="text"/></spine></package>`)
  const shade = [235, 85, 195, 150, 215, 110][index % 6]
  const ink = shade < 150 ? 'white' : 'black'
  book.file('cover.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="rgb(${shade},${shade},${shade})"/><rect x="25" y="25" width="350" height="550" stroke="${ink}" stroke-width="2" fill="none"/><text x="200" y="210" font-size="30" text-anchor="middle" fill="${ink}">READING</text><text x="200" y="320" font-size="82" text-anchor="middle" fill="${ink}">${String(index + 1).padStart(2, '0')}</text><text x="200" y="530" font-size="17" text-anchor="middle" fill="${ink}">KindleSpouse</text></svg>`)
  await writeFile(path.join(root, 'books', `${title}.epub`), await book.generateAsync({ type: 'nodebuffer' }))
}
const disabled = (await readdir(path.join(runtime, 'plugins'))).filter(name => name.endsWith('.koplugin') && name !== 'coverbrowser.koplugin').map(name => `["${name.replace('.koplugin', '')}"]=true`).join(',')
await writeFile(path.join(root, 'settings.reader.lua'), `return { language="zh_CN", last_migration_date=20260701, quickstart_shown_version=99999999, home_dir="${linux(path.join(root, 'books'))}", start_with="filemanager", disable_network_connection=true, auto_suspend_timeout_seconds=0, notebook_draw_with_finger=true, plugins_disabled={${disabled}} }`)
await copyFile('tests/notebook-embedded.lua', path.join(root, 'patches', '2-notebook-test.lua'))
await writeFile(path.join(root, 'native-vectors.json'), JSON.stringify({ version: 1, source: { format: 'synthetic-native-vector-fixture' }, pages: [
  { width: 18600, height: 24800, strokes: [
    { brushType: 0, opacity: 1, points: [{ x: 1000, y: 1000, width: 30 }, { x: 2000, y: 2000, width: 40 }, { x: 3000, y: 1000, width: 20 }] },
    { brushType: 0, opacity: 1, points: [{ x: 1000, y: 4000, width: 30 }, { x: 2000, y: 5000, width: 40 }, { x: 3000, y: 4000, width: 20 }] },
  ] },
  { width: 18600, height: 24800, strokes: [] },
] }))
let offlineSource, offlineHash
if (process.env.KINDLESPOUSE_OFFLINE_NOTEBOOK_TEST === '1') {
  const filename = (await readFile('.test-data/notebook-offline/latest-path.txt', 'utf8')).trim()
  const bytes = await readFile(filename)
  await writeFile(path.join(root, 'private-native-vectors.json'), bytes)
  offlineSource = filename.replace(/\.vectors\.json$/, '')
  offlineHash = createHash('sha256').update(await readFile(offlineSource)).digest('hex')
}
const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linux(runtime), '--exec', 'env', 'SDL_VIDEODRIVER=dummy', 'SDL_AUDIODRIVER=dummy', `XDG_DATA_HOME=${linux(root)}`, `KO_HOME=${linux(root)}`, `KINDLESPOUSE_TEST_ROOT=${linux(process.cwd())}`, `KINDLESPOUSE_NOTEBOOK_TEST_ROOT=${linux(root)}`, 'EMULATE_READER_W=1860', 'EMULATE_READER_H=2480', 'EMULATE_READER_DPI=300', 'LD_LIBRARY_PATH=libs', './luajit', 'reader.lua', '-d', linux(path.join(root, 'books'))], { windowsHide: true })
let output = ''
const record = bytes => { output += bytes.toString(); void appendFile(path.join(root, 'runtime.log'), bytes) }
child.stdout.on('data', record)
child.stderr.on('data', record)
const timer = setTimeout(() => child.kill(), 120000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer)
await writeFile(path.join(root, 'runtime.log'), output)
assert.equal(code, 0, output.slice(-7000))
assert.match(output, /Embedded Notebook acceptance passed/, output.slice(-7000))
if (offlineSource) {
  assert.match(output, /Offline native Notebook edit passed/, output.slice(-7000))
  assert.equal(createHash('sha256').update(await readFile(offlineSource)).digest('hex'), offlineHash)
}
for (const name of ['library', 'profile', 'profile-day', 'profile-syncing', 'gallery', 'scrolled', 'editor', 'saved', 'landscape']) assert.ok((await readFile(`artifacts/notebook-embedded-${name}.png`)).length > 1000)
console.log('Embedded Notebook passed in the real KOReader runtime. All files remained on this computer.')
