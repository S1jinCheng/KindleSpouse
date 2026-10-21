import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import sanitizeHtml from 'sanitize-html'
import { KOREADER_FORMATS, isKoreaderFilename, type KoreaderFormat } from '../src/book-formats'

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false })
const text = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as Record<string, unknown>)['#text'] ?? '') : ''
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const clean = (value: string) => sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 2000)

export function checkBookArchive(zip: JSZip) {
  const entries = Object.values(zip.files)
  if (entries.length > 6000) throw new Error('书籍压缩包包含过多文件。')
  let expanded = 0
  for (const file of entries) {
    const name = (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? file.name
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) throw new Error('书籍压缩包包含无效路径。')
    expanded += (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    if (expanded > 320 * 1024 * 1024) throw new Error('书籍解压后超过 320 MB，无法预览。')
  }
}

function decode(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('gb18030').decode(bytes) }
}

function palm(bytes: Buffer, mobi: boolean) {
  if (bytes.length < 80) throw new Error('Palm/MOBI 文件头不完整。')
  const count = bytes.readUInt16BE(76)
  if (!count || 78 + count * 8 > bytes.length) throw new Error('Palm/MOBI 记录目录无效。')
  const offset = bytes.readUInt32BE(78)
  if (offset < 78 + count * 8 || offset + 16 > bytes.length) throw new Error('Palm/MOBI 正文记录无效。')
  const signature = bytes.subarray(60, 68).toString('ascii')
  if (mobi && signature !== 'BOOKMOBI') throw new Error('文件内容不是有效 MOBI/AZW。')
  const warnings: string[] = []
  const encrypted = ['BOOKMOBI', 'TEXtREAd'].includes(signature) && bytes.readUInt16BE(offset + 12) !== 0
  if (encrypted) warnings.push('文件带有平台 DRM 加密，无法用于 KOReader 试读与传书。')
  let title = clean(bytes.subarray(0, 32).toString('utf8').replace(/\0.*$/s, '')), author = ''
  if (signature === 'BOOKMOBI' && bytes.subarray(offset + 16, offset + 20).toString('ascii') === 'MOBI' && offset + 40 <= bytes.length) {
    const header = offset + 16, length = bytes.readUInt32BE(header + 4)
    const charset = bytes.readUInt32BE(header + 12) === 1252 ? 'windows-1252' : 'utf-8'
    const readText = (start: number, size: number) => clean(new TextDecoder(charset).decode(bytes.subarray(start, start + size)))
    if (length >= 92 && header + length <= bytes.length) {
      const titleOffset = bytes.readUInt32BE(header + 68), size = bytes.readUInt32BE(header + 72)
      if (size <= 8192 && offset + titleOffset + size <= bytes.length) title = readText(offset + titleOffset, size) || title
      const exth = header + length
      if (bytes.subarray(exth, exth + 4).toString('ascii') === 'EXTH' && exth + 12 <= bytes.length) {
        const records = Math.min(bytes.readUInt32BE(exth + 8), 1000)
        let position = exth + 12
        const authors: string[] = []
        for (let index = 0; index < records && position + 8 <= bytes.length; index++) {
          const type = bytes.readUInt32BE(position), size = bytes.readUInt32BE(position + 4)
          if (size < 8 || size > 65536 || position + size > bytes.length) break
          if (type === 100) authors.push(readText(position + 8, size - 8))
          if (type === 503) title = readText(position + 8, size - 8) || title
          position += size
        }
        author = authors.filter(Boolean).join('、')
      }
    }
  }
  return { title, author, warnings }
}

async function archive(bytes: Buffer, format: KoreaderFormat) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('文件内容不是有效的书籍压缩包。')
  const zip = await JSZip.loadAsync(bytes)
  checkBookArchive(zip)
  const names = Object.values(zip.files).filter(file => !file.dir).map(file => file.name)
  const expected: Record<string, RegExp> = { docx: /^word\/document\.xml$/, docm: /^word\/document\.xml$/, pptx: /^ppt\/presentation\.xml$/, xlsx: /^xl\/workbook\.xml$/, odt: /^content\.xml$/, fb3: /(?:^|\/)fb3\/body\.xml$/, xps: /\.(?:fpage|fdseq)$/i, cbz: /\.(?:jpe?g|png|webp|gif|tiff?|jp2|j2k|jxr|svg|pam|pbm|pgm|ppm|pnm)$/i, 'fb2.zip': /\.fb2$/i, 'txt.zip': /\.txt$/i, 'md.zip': /\.md$/i, 'log.zip': /\.log$/i, 'rtf.zip': /\.rtf$/i, 'html.zip': /\.x?html?$/i, 'htm.zip': /\.x?html?$/i, htmlz: /\.x?html?$/i }
  if (!names.length || expected[format] && !names.some(name => expected[format].test(name))) throw new Error(`这份 ${format.toUpperCase()} 缺少可阅读的正文。`)
  if (format === 'zip' && !names.some(isKoreaderFilename)) throw new Error('ZIP 中没有可阅读的书籍或图片。')
  const metadata = zip.file('docProps/core.xml') ?? zip.file('meta.xml') ?? zip.file('ComicInfo.xml')
  if (metadata && ((metadata as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0) <= 1024 * 1024) {
    const xml = await metadata.async('string')
    if (!/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      const data = parser.parse(xml)
      const fields = data.coreProperties ?? data['document-meta']?.meta ?? data.ComicInfo ?? {}
      return { title: clean(text(fields.title ?? fields.Title)), author: clean(text(fields.creator ?? fields.Writer)) }
    }
  }
  return {}
}

export async function inspectNativeBook(bytes: Buffer, format: KoreaderFormat): Promise<{ title?: string; author?: string; language?: string; warnings?: string[] }> {
  const kind = KOREADER_FORMATS[format].kind
  if (kind === 'mobi' || kind === 'palm') return palm(bytes, kind === 'mobi')
  if (kind === 'zip') return archive(bytes, format)
  const header = bytes.subarray(0, 1024)
  const invalid = () => { throw new Error(`文件内容不是有效的 ${format.toUpperCase()}。`) }
  if (kind === 'compound' && !header.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) invalid()
  if (kind === 'chm' && header.subarray(0, 4).toString() !== 'ITSF') invalid()
  if (kind === 'tcr' && header.subarray(0, 9).toString() !== '!!8-Bit!!') invalid()
  if (kind === 'djvu' && (header.subarray(0, 8).toString() !== 'AT&TFORM' || !['DJVU', 'DJVM'].includes(header.subarray(12, 16).toString()))) invalid()
  if (kind === 'rar' && !header.subarray(0, 6).equals(Buffer.from('526172211a07', 'hex'))) invalid()
  if (kind === 'tar') {
    const declared = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0/g, '').trim(), 8)
    const calculated = [...header.subarray(0, 512)].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    if (bytes.length < 512 || declared !== calculated) invalid()
  }
  if (kind === 'image') {
    const signatures: Record<string, boolean> = {
      jpg: header[0] === 0xff && header[1] === 0xd8, jpeg: header[0] === 0xff && header[1] === 0xd8,
      png: header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
      gif: /^GIF8[79]a/.test(header.toString('ascii')),
      webp: header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP',
      tif: /^(49492a00|4d4d002a|49492b00|4d4d002b)/.test(header.toString('hex')), tiff: /^(49492a00|4d4d002a|49492b00|4d4d002b)/.test(header.toString('hex')),
      hdp: header.subarray(0, 4).toString('hex') === '4949bc01', jxr: header.subarray(0, 4).toString('hex') === '4949bc01', wdp: header.subarray(0, 4).toString('hex') === '4949bc01',
      jp2: header.subarray(0, 12).toString('hex') === '0000000c6a5020200d0a870a', j2k: header.subarray(0, 4).toString('hex') === 'ff4fff51',
      pam: /^P7\s/.test(header.toString('ascii')), pbm: /^P[14]\s/.test(header.toString('ascii')), pgm: /^P[25]\s/.test(header.toString('ascii')), ppm: /^P[36]\s/.test(header.toString('ascii')), pnm: /^P[1-6]\s/.test(header.toString('ascii')),
    }
    if (!signatures[format]) invalid()
  }
  if (['text', 'html', 'xml', 'rtf'].includes(kind)) {
    const source = decode(bytes.subarray(0, 1024 * 1024)).replace(/^\uFEFF/, '')
    if (source.includes('\0') || /^[\x00-\x08\x0e-\x1f]|^MZ/.test(source)) invalid()
    if (kind === 'rtf' && !source.trimStart().startsWith('{\\rtf')) invalid()
    if (kind === 'xml' && (!source.trimStart().startsWith('<') || /<!DOCTYPE|<!ENTITY/i.test(source))) invalid()
    if (kind === 'html') {
      if (!/<(?:!doctype\s+html|html|head|body|p|h[1-6])\b/i.test(source)) invalid()
      const title = clean(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
      if (/^(?:登录|登入|login|sign in|access denied|安全验证|验证您的|404\b|403\b)/i.test(title)) throw new Error('下载到的是登录或错误页面，请使用书籍文件。')
      return { title, warnings: ['HTML 的外部图片与样式需随书打包；可使用 HTMLZ 或 HTML.ZIP 保留资源。'] }
    }
    if (format === 'fb2') {
      if (!/<(?:\w+:)?FictionBook\b/i.test(source)) invalid()
      const description = source.match(/<(?:\w+:)?description\b[^>]*>[\s\S]*?<\/(?:\w+:)?description>/i)?.[0]
      if (description) {
        const info = parser.parse(description).description?.['title-info'] ?? {}
        return { title: clean(text(info['book-title'])), author: list(info.author).map(author => ['first-name', 'middle-name', 'last-name', 'nickname'].map(key => text((author as Record<string, unknown>)[key])).filter(Boolean).join(' ')).filter(Boolean).join('、'), language: clean(text(info.lang)) }
      }
    }
  }
  return {}
}
