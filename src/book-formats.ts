import formats from './book-formats.json'

export type KoreaderFormat = keyof typeof formats
export const KOREADER_FORMATS = formats
export const KOREADER_EXTENSIONS = Object.keys(formats) as KoreaderFormat[]
const suffixes = [...KOREADER_EXTENSIONS, 'azw3', 'azw6', 'kfx', 'kpf'].sort((a, b) => b.length - a.length)
export function isKoreaderFormat(value: unknown): value is KoreaderFormat {
  return typeof value === 'string' && Object.hasOwn(formats, value)
}
export function bookFormatFromFilename(filename: string) {
  const lower = filename.toLowerCase()
  return suffixes.find(extension => lower.endsWith('.' + extension)) as KoreaderFormat | 'azw3' | 'azw6' | 'kfx' | 'kpf' | undefined
}
export function isKoreaderFilename(filename: string) { return isKoreaderFormat(bookFormatFromFilename(filename)) }
export function stripBookExtension(filename: string) {
  const format = bookFormatFromFilename(filename)
  return format ? filename.slice(0, -format.length - 1) : filename
}
export function bookMimeType(format: string) {
  return isKoreaderFormat(format) ? formats[format].mime : 'application/octet-stream'
}
export function formatFromMimeType(mime: string) {
  const value = mime.split(';')[0].trim().toLowerCase()
  const aliases: Record<string, KoreaderFormat> = { 'application/epub': 'epub', 'application/fb2': 'fb2', 'text/fb2+xml': 'fb2', 'application/x-mobi8-ebook': 'azw', 'application/x-cbz': 'cbz', 'application/djvu': 'djvu', 'image/x-djvu': 'djvu', 'application/vnd.rar': 'cbr', 'text/plain': 'txt' }
  if (aliases[value]) return aliases[value]
  return KOREADER_EXTENSIONS.find(extension => formats[extension].mime.toLowerCase() === value && !['application/octet-stream', 'application/zip', 'text/plain', 'text/html'].includes(value))
}
export function isRollingFormat(format: string) { return isKoreaderFormat(format) && formats[format].layout === 'rolling' }
export function isBrowserFormat(format: string) { return ['epub', 'epub3', 'pdf'].includes(format) }
export function usesKoreader(format: string | undefined, engine: 'koreader' | 'browser') { return engine === 'koreader' || Boolean(format && isKoreaderFormat(format) && !isBrowserFormat(format)) }
