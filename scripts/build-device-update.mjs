import { createHash } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { companionPackage } from '../electron/device-package.ts'

const zip = await companionPackage(path.resolve('native'))
zip.file('kindlespouse/UPDATE.txt', 'KindleSpouse overlay for KOReader v2026.07.1 on ARMv7 Kindle. Exit KOReader before copying to the USB root. Existing books, config.json, rclone.conf and pause.requested are preserved. First-time users should use the Windows setup wizard to authorize, install and verify connectivity. This public package contains no cloud credentials. Use KindleSpouse > Use KindleSpouse home to return to the original file browser.\n')
await mkdir('artifacts', { recursive: true })
const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' })
const filename = 'artifacts/KindleSpouse-Device-Update.zip'
await writeFile(filename, bytes)
await writeFile(filename + '.sha256', createHash('sha256').update(bytes).digest('hex') + '\n')
console.log(JSON.stringify({ file: filename, bytes: bytes.length, containsCredentials: false }))