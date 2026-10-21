const { nativeImage } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const image = nativeImage.createFromPath(path.join(root, 'public/brand/icon.png'))
if (image.isEmpty()) throw new Error('Brand icon is missing or invalid')
const { width, height } = image.getSize()
if (width !== height || width < 256) throw new Error('Brand icon must be square and at least 256 pixels')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG())
const header = Buffer.alloc(6 + frames.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(frames.length, 4)
let offset = header.length
for (const [index, frame] of frames.entries()) {
  const entry = 6 + index * 16
  header[entry] = sizes[index] === 256 ? 0 : sizes[index]
  header[entry + 1] = header[entry]
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(frame.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += frame.length
}
mkdirSync(path.join(root, 'build'), { recursive: true })
writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...frames]))
console.log(`Windows icon exported: ${sizes.join(', ')} px`)
process.exit(0)
