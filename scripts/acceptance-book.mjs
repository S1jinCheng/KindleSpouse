import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'

const chapters = [
  { title: '先读几页，再决定', paragraphs: ['KindleSpouse 使用指南', '下载的 EPUB 和 PDF 先进入试读区。书籍不会因为下载完成就被发送到设备。打开正文，检查目录、图片、字体和分页，再选择是否收藏或传书。', 'EPUB 可以调整字号、行距和边距；PDF 保持原始页面，并提供缩放。电脑中的排版是模拟结果，设备上的最终分页取决于 KOReader 的设置。', '使用目录可以跳到指定章节。左右方向键和屏幕下方的箭头都能翻页。阅读位置保存在这台电脑中，下次打开可以继续。'] },
  { title: '把确认过的书带走', paragraphs: ['选择 USB、网盘或无线取书，然后点击确认发送。确认窗口显示当前版本的内容指纹和目标位置。取消确认不会生成传输任务。', 'USB 会把原始 EPUB 或 PDF 送到 Books/Inbox，随后回读文件并比较 SHA-256。看到已发送，表示文件已经写入并通过校验。请先退出 KOReader，再连接 USB。', '网盘会上传到你选择的账号和目录，并重新下载远端文件验证内容。已存入网盘不等于 Kindle 已经收到。无线书目可以帮助 KOReader 获取这些已确认文件。'] },
  { title: '管理自己的书库', paragraphs: ['导入 Kindle 书库会把设备上的 documents 和 Books 目录复制到本机私有快照，再整理书名、作者和封面。原始格式与随附阅读资料都会保留。', '带有平台加密的电子书可以保留原始档案，但无法在当前电脑阅读器中试读。请使用你持有的可用文件。应用不会把不能阅读的文件标成试读成功。', '书籍、笔记、登录状态和账号令牌属于本机数据。源码仓库不包含这些资料。你可以在设置里打开数据目录，另行备份自己的书库。'] },
  { title: '连接 Google Drive 或 OneDrive', paragraphs: ['在书源与网盘页面选择提供商。应用会打开系统浏览器，请在服务商的授权页面选择账号并授权。授权完成后再回到应用。', '你可以浏览网盘文件夹，将 EPUB 或 PDF 下载到试读区。发送前仍然需要阅读并确认，不会把整个 Kindle 备份自动上传。', '无线书目需要电脑持续运行，并且电脑与 Kindle 的网络能够互通。在 KOReader 的 OPDS 书目中添加设置页显示的地址、用户名和专用密码。校园或公司网络如果隔离设备，可以改用个人热点。'] },
]

export async function getAcceptanceBook() {
  const directory = path.resolve('.test-data/fixtures')
  await mkdir(directory, { recursive: true })
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  const manifest = chapters.map((_, i) => `<item id="c${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  zip.file('OEBPS/book.opf', `<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:kindlespouse:guide:1</dc:identifier><dc:title>KindleSpouse 使用指南</dc:title><dc:creator>KindleSpouse</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-10-17T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`)
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${chapters.map((chapter, i) => `<li><a href="chapter${i}.xhtml">${chapter.title}</a></li>`).join('')}</ol></nav></body></html>`)
  chapters.forEach((chapter, i) => zip.file(`OEBPS/chapter${i}.xhtml`, `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${chapter.title}</title></head><body><h1>${chapter.title}</h1>${chapter.paragraphs.map(text => `<p>${text}</p>`).join('')}</body></html>`))
  const filename = path.join(directory, 'KindleSpouse Guide.epub')
  await writeFile(filename, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return filename
}

export async function getAcceptancePdf() {
  const filename = path.resolve('.test-data/fixtures/KindleSpouse Guide.pdf')
  await mkdir(path.dirname(filename), { recursive: true })
  const pages = [
    ['KindleSpouse Reading Guide', 'Preview the actual EPUB or PDF before confirming a transfer.', 'EPUB supports font size, line spacing and margin controls.', 'PDF keeps the original page layout. Use zoom to inspect details.', 'The preview is a simulation. KOReader determines final pagination.'],
    ['Transfer and Privacy', 'USB transfers are read back and verified with SHA-256.', 'Cloud uploads are downloaded again before being marked ready.', 'Cloud ready does not mean the Kindle has received the file.', 'Books, notes and account tokens stay outside the source repository.'],
  ]
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>']
  pages.forEach((lines, i) => {
    const content = `BT /F1 14 Tf 42 730 Td ${lines.map((line, n) => `${n ? '0 -34 Td ' : ''}(${line}) Tj`).join('\n')} ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  await writeFile(filename, pdf)
  return filename
}
