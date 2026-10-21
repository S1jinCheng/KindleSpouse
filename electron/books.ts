import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import sanitizeHtml from 'sanitize-html'
import type { BookFormat } from '../src/shared'
import { bookFormatFromFilename, isKoreaderFormat, stripBookExtension } from '../src/book-formats'
import { checkBookArchive, inspectNativeBook } from './book-inspection'

export const MAX_BOOK_BYTES = 200 * 1024 * 1024
const MAX_EXPANDED_BYTES = 320 * 1024 * 1024
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: true })
const parseXml = (value: string) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('书籍目录包含不支持的 XML 声明。')
  return parser.parse(value)
}
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]
const textValue = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : value && typeof value === 'object'
        ? String((value as Record<string, unknown>)['#text'] ?? '')
        : ''


async function encryptionStatus(zip: JSZip) {
  const encrypted = zip.file('META-INF/encryption.xml')
  if (!encrypted) return { blocked: false, fontOnly: false }
  const xml = await encrypted.async('string')
  const algorithms = [...xml.matchAll(/Algorithm\s*=\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  const fontAlgorithms = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'])
  return {
    blocked: algorithms.length === 0 || algorithms.some((algorithm) => !fontAlgorithms.has(algorithm)),
    fontOnly: algorithms.length > 0 && algorithms.every((algorithm) => fontAlgorithms.has(algorithm)),
  }
}

export function contentHash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function safeFilename(input: string, format: BookFormat) {
  const stem =
    stripBookExtension(path.basename(input))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 100) || 'Book'
  return `${stem}.${format}`
}

export function transferFilename(title: string, sha256: string, format: BookFormat) {
  let stem = Array.from(Buffer.from(safeFilename(title, format).slice(0, -format.length - 1), 'utf8').toString('utf8')).slice(0, 87).join('')
  while (Buffer.byteLength(stem, 'utf8') > 180) stem = Array.from(stem).slice(0, -1).join('')
  return `${stem}_${sha256.slice(0, 12)}.${format}`
}

export async function inspectBook(filename: string) {
  const info = await stat(filename)
  if (!info.isFile() || info.size === 0 || info.size > MAX_BOOK_BYTES)
    throw new Error('请选择完整的 KOReader 支持文件，文件上限为 200 MB。')
  const bytes = await readFile(filename)
  const format = bookFormatFromFilename(filename)
  const title = stripBookExtension(path.basename(filename))
  if (!isKoreaderFormat(format)) throw new Error('当前 KOReader 不支持这种文件格式。')
  if (format === 'pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
      throw new Error('文件内容不是有效 PDF，可能下载到了网页。')
    return {
      bytes,
      format: 'pdf' as const,
      title,
      author: '作者信息未提供',
      chapters: 0,
      warnings: ['请试读确认页面清晰度；扫描版可能没有可搜索文字。'],
      sha256: contentHash(bytes),
    }
  }
  if (!['epub', 'epub3'].includes(format)) {
    const metadata = await inspectNativeBook(bytes, format)
    return { bytes, format, title: metadata.title || title, author: metadata.author || '作者信息未提供', chapters: 0, warnings: metadata.warnings ?? [], language: 'language' in metadata ? metadata.language : undefined, sha256: contentHash(bytes) }
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('文件内容不是有效 EPUB，可能是下载页面。')
  const zip = await JSZip.loadAsync(bytes)
  checkBookArchive(zip)
  const container = zip.file('META-INF/container.xml')
  if (!container) throw new Error('EPUB 缺少 META-INF/container.xml。')
  const rootfile = array(parseXml(await container.async('string')).container?.rootfiles?.rootfile)[0] as
    | Record<string, string>
    | undefined
  const opfPath = rootfile?.['@_full-path']
  if (!opfPath || !zip.file(opfPath)) throw new Error('EPUB 缺少有效的书籍目录。')
  const pkg = parseXml(await zip.file(opfPath)!.async('string')).package
  const metadata = pkg?.metadata ?? {}
  const items = array(pkg?.manifest?.item) as Record<string, string>[]
  const chapters = array(pkg?.spine?.itemref).length
  if (!chapters) throw new Error('这份 EPUB 没有可阅读的正文。')
  const coverId = (array(metadata.meta) as Record<string, string>[]).find((item) => item['@_name'] === 'cover')?.[
    '@_content'
  ]
  const coverItem =
    items.find((item) => item['@_properties']?.split(' ').includes('cover-image')) ??
    items.find((item) => item['@_id'] === coverId)
  let cover: string | undefined
  if (coverItem && /^image\/(png|jpeg|webp)$/.test(coverItem['@_media-type'])) {
    const coverPath = path.posix.normalize(
      path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(coverItem['@_href'])),
    )
    const image = await zip.file(coverPath)?.async('uint8array')
    const imageHeader = image ? Buffer.from(image).subarray(0, 12) : Buffer.alloc(0)
    const validImage =
      (imageHeader[0] === 0xff && imageHeader[1] === 0xd8) ||
      imageHeader.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      imageHeader.toString('ascii').startsWith('RIFF')
    if (image && image.length < 4 * 1024 * 1024 && validImage)
      cover = `data:${coverItem['@_media-type']};base64,${Buffer.from(image).toString('base64')}`
  }
  const encryption = await encryptionStatus(zip)
  const warnings = ['排版为电脑模拟，实际换行与分页以 KOReader 为准。']
  if (encryption.blocked)
    warnings.push('文件带有平台 DRM 加密，当前无法试读或发送给 KOReader，请导入可用的无 DRM 文件。')
  else if (encryption.fontOnly) warnings.push('书内字体包含混淆信息，预览可能使用替代字体。')
  return {
    bytes,
    format,
    title: textValue(array(metadata.title)[0]) || title,
    author: array(metadata.creator).map(textValue).filter(Boolean).join('、') || '作者信息未提供',
    description: sanitizeHtml(textValue(array(metadata.description)[0]), { allowedTags: [], allowedAttributes: {} }),
    language: textValue(array(metadata.language)[0]),
    isbn: array(metadata.identifier)
      .map(textValue)
      .map((value) => value.replace(/^urn:isbn:/i, '').replace(/-/g, ''))
      .find((value) => /^(?:97[89]\d{10}|\d{9}[\dXx])$/.test(value)),
    chapters,
    warnings,
    sha256: contentHash(bytes),
    cover,
  }
}

export async function safePreview(filename: string, expectedHash: string) {
  const original = await readFile(filename)
  if (contentHash(original) !== expectedHash) throw new Error('书籍文件已经变化，请重新导入并试读。')
  if (path.extname(filename).toLowerCase() === '.pdf') return new Uint8Array(original)
  const zip = await JSZip.loadAsync(original)
  checkBookArchive(zip)
  if ((await encryptionStatus(zip)).blocked)
    throw new Error('这份书有平台 DRM 加密。请导入你持有的可用无 DRM EPUB/PDF；当前文件无法用于 KOReader 试读与传书。')
  let expanded = 0
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    const data = await file.async('uint8array')
    expanded += data.length
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('EPUB 解压后过大，已停止预览。')
    if (/\.(xhtml|html|htm)$/i.test(name)) {
      const clean = sanitizeHtml(Buffer.from(data).toString('utf8'), {
        allowedTags: [
          ...sanitizeHtml.defaults.allowedTags,
          'html',
          'head',
          'body',
          'title',
          'meta',
          'img',
          'figure',
          'figcaption',
          'section',
          'article',
          'aside',
          'nav',
          'ruby',
          'rt',
          'rp',
          'link',
          'style',
          'svg',
          'image',
          'path',
          'rect',
          'circle',
          'g',
          'text',
        ],
        allowedAttributes: {
          '*': ['id', 'class', 'style', 'lang', 'dir', 'epub:type', 'xml:lang'],
          html: ['xmlns', 'xmlns:epub'],
          a: ['href', 'title'],
          img: ['src', 'alt', 'width', 'height'],
          svg: ['xmlns', 'xmlns:xlink', 'width', 'height', 'viewBox', 'viewbox', 'preserveAspectRatio'],
          image: ['href', 'xlink:href', 'width', 'height'],
          path: ['d', 'fill'],
          rect: ['x', 'y', 'width', 'height', 'fill'],
          circle: ['cx', 'cy', 'r', 'fill'],
          link: ['href', 'rel', 'type'],
          meta: ['charset', 'name', 'content'],
          td: ['colspan', 'rowspan'],
          th: ['colspan', 'rowspan'],
        },
        parser: { lowerCaseAttributeNames: false, lowerCaseTags: false, xmlMode: true },
        allowedSchemes: ['data'],
        allowVulnerableTags: true,
        transformTags: {
          a: (tagName, attributes) => ({
            tagName,
            attribs: {
              ...attributes,
              href: /^(https?:|javascript:|file:|\/\/)/i.test(attributes.href ?? '') ? '#' : attributes.href,
            },
          }),
        },
      })
      zip.file(name, clean)
    } else if (/\.css$/i.test(name)) {
      zip.file(
        name,
        Buffer.from(data)
          .toString('utf8')
          .replace(/@import[^;]+;/gi, '')
          .replace(/url\(\s*['"]?(?:https?:|file:|\/\/)[^)]*\)/gi, 'none'),
      )
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
