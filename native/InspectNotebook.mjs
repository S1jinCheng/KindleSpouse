import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readFragments } from './tools/notebook-converter/src/nbk.ts'

const unwrap = (value) =>
  value && typeof value === 'object' && Array.isArray(value.annotations) ? unwrap(value.value) : value
const strings = (value) => {
  value = unwrap(value)
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return []
  return Object.values(value).flatMap(strings)
}
const inputs = JSON.parse(await readFile(process.argv[2], 'utf8'))
const result = []
for (const input of inputs) {
  try {
    const { fragments } = await readFragments(input.path)
    const pages = fragments.filter(
      (fragment) =>
        fragment.annotation === '$260' &&
        typeof unwrap(fragment.value)?.['nmdl.canvas_width'] === 'number' &&
        typeof unwrap(fragment.value)?.['nmdl.canvas_height'] === 'number',
    )
    const metadata = fragments.filter((fragment) =>
      ['book_metadata', 'metadata', 'document_data'].includes(fragment.id),
    )
    const fields = Object.assign({}, ...metadata.map((fragment) => unwrap(fragment.value)))
    const values = metadata.flatMap((fragment) => strings(fragment.value))
    const titleIndex = values.findIndex((value) => /^(title|notebook_title|display_title)$/i.test(value))
    const title = titleIndex >= 0 ? values[titleIndex + 1] : undefined
    const type = values.some((value) => /^(notebook|kindle_notebook)$/i.test(value))
      ? 'notebook'
      : values.some((value) => /^(sticky_note|annotation|print_replica|pdf)$/i.test(value))
        ? 'attachment'
        : undefined
    const identityIndex = values.indexOf('book_id')
    result.push({
      key: input.key,
      pages: pages.length,
      title,
      identity: identityIndex >= 0 ? values[identityIndex + 1] : undefined,
      kind: pages.length ? (type ?? 'notebook') : 'auxiliary',
      metadata: process.env.KINDLESPOUSE_INSPECT_DEBUG === '1' ? fields : undefined,
    })
  } catch (error) {
    result.push({ key: input.key, pages: 0, kind: 'unknown', error: String(error.message).slice(0, 200) })
  }
}
process.stdout.write(JSON.stringify(result, (key, value) => (typeof value === 'bigint' ? String(value) : value)))
