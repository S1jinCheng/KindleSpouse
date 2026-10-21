import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { _electron } from 'playwright'
import { Store } from '../electron/store.ts'
import { inspectBook } from '../electron/books.ts'
import { verifyDistribution } from '../scripts/verify-distribution.mjs'
import { getAcceptanceBook } from '../scripts/acceptance-book.mjs'

const unpacked = path.resolve(process.argv[2] || 'release/win-unpacked')
const native = path.join(unpacked, 'resources/native')
const components = await verifyDistribution(native)
const require = createRequire(path.join(native, 'tools/notebook-converter/package.json'))
const { makeBinaryWriter, IonTypes } = require('ion-js')
await mkdir('.test-data', { recursive: true })
const root = await mkdtemp(path.resolve('.test-data/distribution-smoke-'))
const profile = path.join(root, 'profile')
const notebookPath = path.join(root, 'generated.nbk')
const writer = makeBinaryWriter()
writer.setAnnotations(['$260'])
writer.stepIn(IonTypes.STRUCT)
for (const [field, value] of Object.entries({ 'nmdl.canvas_width': 18600, 'nmdl.canvas_height': 24800, 'nmdl.normalized_ppi': 2520 })) {
  writer.writeFieldName(field)
  writer.writeInt(value)
}
writer.stepOut()
writer.close()
const notebook = new DatabaseSync(notebookPath)
notebook.exec('CREATE TABLE fragments(id TEXT, payload_type TEXT, payload_value BLOB)')
const insert = notebook.prepare('INSERT INTO fragments VALUES(?,?,?)')
insert.run('$ion_symbol_table', 'blob', Buffer.from([0xe0, 0x01, 0x00, 0xea]))
insert.run('generated-page', 'blob', Buffer.from(writer.getBytes()))
notebook.close()
const notebookBytes = await readFile(notebookPath), id = randomUUID()
const store = new Store(profile)
store.put('settings', 'main', { kindleMode: 'native', readerEngine: 'browser', onboardingComplete: false, sourceUrl: 'https://zh.z-lib.help/', calibreDirectory: '', cloudFolder: 'KindleSpouse/Inbox', profile: { font: 'song', fontSize: 19, lineHeight: 1.8, margin: 20, paper: 'warm' } })
store.put('notebooks', id, { id, title: 'Generated notebook', titleSource: 'manual', classification: 'notebook', format: 'nbk', path: notebookPath, sha256: createHash('sha256').update(notebookBytes).digest('hex'), bytes: notebookBytes.length, sourceKey: id, status: 'original', importedAt: new Date().toISOString() })
const bookPath = await getAcceptanceBook(), book = { ...await inspectBook(bookPath), id: randomUUID(), path: bookPath, filename: path.basename(bookPath), createdAt: new Date().toISOString(), source: 'Generated fixture', library: true, progress: 0 }
store.put('candidates', book.id, book)
store.close()
let application
try {
  application = await _electron.launch({ executablePath: path.join(unpacked, 'KindleSpouse.exe'), args: [`--user-data-dir=${profile}`], timeout: 45000 })
  const page = await application.firstWindow()
  await page.getByRole('dialog', { name: 'Kindle 首次使用向导' }).waitFor()
  const actual = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, directory: app.getPath('userData'), sessionDirectory: app.getPath('sessionData') }))
  assert.equal(actual.packaged, true)
  assert.equal(path.resolve(actual.directory), profile)
  assert.equal(path.resolve(actual.sessionDirectory), profile)
  const state = await page.evaluate(() => window.kindlespouse.state())
  assert.equal(state.notebooks[0].title, 'Generated notebook')
  assert.equal(state.candidates.length, 1)
  const pdf = await page.evaluate(async id => [...await window.kindlespouse.previewNotebook(id)], id)
  assert.ok(Buffer.from(pdf).subarray(0, 5).equals(Buffer.from('%PDF-')))
  const preview = await page.evaluate(id => window.kindlespouse.preview(id), book.id)
  assert.ok(preview)
  const setup = await page.evaluate(() => window.kindlespouse.companionSetup())
  assert.equal(setup.stage, 'idle')
  await page.screenshot({ path: path.join(root, 'packaged-first-run.png') })
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, packaged: true, isolatedProfile: true, requiredComponents: components, generatedNotebookConvertedToPdf: true, bookPreviewOpened: true, setupApiAvailable: true }, null, 2))
  console.log(JSON.stringify({ passed: true, artifacts: root }))
} finally { await application?.close() }
