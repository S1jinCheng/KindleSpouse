import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { getAcceptanceBook } from './acceptance-book.mjs'

export async function getAcceptanceFormats(directory) {
  const input = process.env.KINDLESPOUSE_FORMAT_BOOK || await getAcceptanceBook()
  const calibre = process.env.KINDLESPOUSE_CALIBRE_DIRECTORY
  if (!calibre) throw new Error('Set KINDLESPOUSE_CALIBRE_DIRECTORY to generate native format acceptance files.')
  await mkdir(directory, { recursive: true })
  const execute = promisify(execFile)
  const files = [input]
  for (const extension of ['mobi', 'fb2', 'docx', 'txt', 'rtf', 'htmlz']) {
    const filename = path.join(directory, 'Original.' + extension)
    const config = path.join(directory, 'calibre-' + extension)
    await mkdir(config, { recursive: true })
    await execute(path.join(calibre, 'ebook-convert.exe'), [input, filename], { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CALIBRE_CONFIG_DIRECTORY: config, CALIBRE_OVERRIDE_LANG: 'en', PYTHONIOENCODING: 'utf-8' } })
    files.push(filename)
  }
  for (const extension of ['fb2', 'txt']) {
    const filename = path.join(directory, 'Original.' + extension + '.zip')
    await writeFile(filename, await new JSZip().file('Original.' + extension, await readFile(path.join(directory, 'Original.' + extension))).generateAsync({ type: 'nodebuffer' }))
    files.push(filename)
  }
  const html = await JSZip.loadAsync(await readFile(path.join(directory, 'Original.htmlz')))
  const entry = Object.values(html.files).find(file => /\.html?$/i.test(file.name))
  if (entry) {
    const filename = path.join(directory, 'Original.html')
    await writeFile(filename, await entry.async('nodebuffer'))
    files.push(filename)
  }
  const markdown = path.join(directory, 'Original.md')
  await writeFile(markdown, '# Original reading text\n\n' + await readFile(path.join(directory, 'Original.txt'), 'utf8'))
  files.push(markdown)
  return files
}
