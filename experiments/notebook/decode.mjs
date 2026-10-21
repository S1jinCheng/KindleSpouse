import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readNotebook } from '../../native/tools/notebook-converter/src/notebook.ts'

const source = path.resolve(process.argv[2] ?? '')
const destination = path.resolve(process.argv[3] ?? '')
if (process.argv.length !== 4 || source === destination) throw new Error('Provide a local NBK copy and a new vector output path')
const before = await readFile(source)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const notebook = await readNotebook(source)
if (sha256(await readFile(source)) !== sha256(before)) throw new Error('Source changed during decode')
await writeFile(destination, JSON.stringify({ version: 1, source: { format: 'scribe-nbk', sha256: sha256(before), bytes: before.length }, pages: notebook.pages }), { flag: 'wx' })
console.log(JSON.stringify({ pages: notebook.pages.length, strokes: notebook.pages.reduce((count, page) => count + page.strokes.length, 0), sourceUnchanged: true }))
