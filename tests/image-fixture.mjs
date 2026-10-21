import { crc32, deflateSync } from 'node:zlib'

export function avatarPng(size = 256) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length)
    type.copy(result, 4)
    bytes.copy(result, 8)
    result.writeUInt32BE(crc32(Buffer.concat([type, bytes])), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4)
  header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (size * 3 + 1) + 1 + x * 3
    const sun = (x - size * .68) ** 2 + (y - size * .29) ** 2 < (size * .12) ** 2
    const hill = y > size * .65 + Math.sin(x / size * 5) * size * .12
    pixels[offset] = sun ? 239 : hill ? 74 : 183
    pixels[offset + 1] = sun ? 210 : hill ? 91 : 191
    pixels[offset + 2] = sun ? 148 : hill ? 84 : 177
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
