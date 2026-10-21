import { readFile, writeFile } from 'node:fs/promises'

const formats = JSON.parse(await readFile(new URL('../src/book-formats.json', import.meta.url), 'utf8'))
const contents = 'package main\n\nvar readableBookFormats = []string{\n' + Object.keys(formats).sort().map(extension => `\t${JSON.stringify(extension)},`).join('\n') + '\n}\n'
const target = new URL('../native/companion/book_formats.go', import.meta.url)
const nativeTarget = new URL('../native/book-formats.json', import.meta.url)
const nativeContents = JSON.stringify(Object.keys(formats).sort(), null, 2) + '\n'
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== contents) throw new Error('Device book formats differ from the application registry.')
  if ((await readFile(nativeTarget, 'utf8')).replace(/\r\n/g, '\n') !== nativeContents) throw new Error('USB book formats differ from the application registry.')
} else {
  await writeFile(target, contents)
  await writeFile(nativeTarget, nativeContents)
}
