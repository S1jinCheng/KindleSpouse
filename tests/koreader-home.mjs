import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, appendFile, readdir, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import JSZip from 'jszip'

const root = path.resolve('.test-data/koreader-home')
const runtime = path.resolve('native/tools/koreader/squashfs-root/usr/lib/koreader')
const linux = filename => `/mnt/${filename[0].toLowerCase()}/${filename.slice(3).replaceAll('\\', '/')}`
await mkdir(path.join(root, 'patches'), { recursive: true })
await mkdir(path.join(root, 'books', 'nested'), { recursive: true })
await mkdir(path.join(root, 'fonts'), { recursive: true })
for (const name of ['NotoSerifCJKsc-Regular.otf', 'NotoSansCJKsc-Regular.otf']) await copyFile(path.join('native/tools/reader-fonts', name), path.join(root, 'fonts', name))
await mkdir('artifacts', { recursive: true })
const names = ['山间来信', '一日三餐', '阅读的四季', '慢慢走', '生活的形状', '一间自己的书房', '寻常故事', '昨日书简']
for (const [index, title] of names.entries()) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('book.opf', `<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">home-test-${index}</dc:identifier><dc:title>${title}</dc:title><dc:creator>KindleSpouse</dc:creator><dc:language>zh-CN</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.svg" media-type="image/svg+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="text"/></spine></package>`)
  zip.file('text.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>这是用于检查书架封面和中文排版的测试图书。</p></body></html>`)
  zip.file('toc.ncx', `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="home-test-${index}"/></head><docTitle><text>${title}</text></docTitle><navMap><navPoint id="one" playOrder="1"><navLabel><text>${title}</text></navLabel><content src="text.xhtml"/></navPoint></navMap></ncx>`)
  const shade = [225, 180, 80, 210, 140, 55, 195, 110][index]
  zip.file('cover.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="rgb(${shade},${shade},${shade})"/><rect x="30" y="30" width="340" height="540" fill="none" stroke="${shade < 150 ? 'white' : 'black'}" stroke-width="2"/><text x="200" y="260" fill="${shade < 150 ? 'white' : 'black'}" font-size="32" text-anchor="middle">BOOK ${index + 1}</text><text x="200" y="510" fill="${shade < 150 ? 'white' : 'black'}" font-size="18" text-anchor="middle">KindleSpouse</text></svg>`)
  await writeFile(path.join(root, 'books', index > 3 ? 'nested' : '', `${index + 1}.epub`), await zip.generateAsync({ type: 'nodebuffer' }))
}
await mkdir(path.join(root, 'books', '.notebooks'), { recursive: true })
await writeFile(path.join(root, 'books', '.notebooks', 'private.txt'), 'Excluded notebook fixture')
const disabled = (await readdir(path.join(runtime, 'plugins'))).filter(name => name.endsWith('.koplugin') && name !== 'coverbrowser.koplugin').map(name => `["${name.replace('.koplugin', '')}"]=true`).join(',')
await writeFile(path.join(root, 'settings.reader.lua'), `return { language="en", last_migration_date=20260701, quickstart_shown_version=99999999, home_dir="${linux(path.join(root, 'books'))}", start_with="filemanager", disable_network_connection=true, auto_suspend_timeout_seconds=0, plugins_disabled={${disabled}} }`)
await writeFile(path.join(root, 'patches', '2-home-test.lua'), await readFile('tests/koreader-home.lua'))
await writeFile(path.join(root, 'runtime.log'), '')
const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--cd', linux(runtime), '--exec', 'env', 'SDL_VIDEODRIVER=dummy', 'SDL_AUDIODRIVER=dummy', `XDG_DATA_HOME=${linux(root)}`, `KO_HOME=${linux(root)}`, `KINDLESPOUSE_TEST_ROOT=${linux(process.cwd())}`, 'EMULATE_READER_W=1860', 'EMULATE_READER_H=2480', 'EMULATE_READER_DPI=300', 'LD_LIBRARY_PATH=libs', './luajit', 'reader.lua', '-d', linux(path.join(root, 'books'))], { windowsHide: true })
let output = ''
const record = bytes => { output += bytes.toString(); void appendFile(path.join(root, 'runtime.log'), bytes) }
child.stdout.on('data', record)
child.stderr.on('data', record)
const timeout = setTimeout(() => child.kill(), 180000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timeout)
await writeFile(path.join(root, 'runtime.log'), output)
assert.equal(code, 0, output.slice(-6000))
assert.match(output, /KindleSpouse home acceptance passed/, output.slice(-6000))
for (const name of ['library', 'list', 'notebook', 'landscape']) assert.ok((await readFile(`artifacts/koreader-home-${name}.png`)).length > 1000)
console.log('Native KOReader home passed: search, status/author/format/folder filters, favorites, collections, sorting, grid/list, ten fonts, two tabs, portrait/landscape and reversible settings.')
