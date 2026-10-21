import { contentHash } from './books'

export const MAX_AVATAR_BYTES = 512 * 1024
export function avatarBytes(data: string) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 750000) throw new Error('头像需要使用有效的 PNG 图片。')
  const bytes = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64')
  if (bytes.length < 33 || bytes.length > MAX_AVATAR_BYTES || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('头像图片无效或超过大小上限。')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 512 || height > 512 || width !== height || bytes[24] !== 8) throw new Error('请先将头像裁切为不超过 512 像素的正方形。')
  return bytes
}
export function avatarAsset(data?: string) {
  if (!data) return undefined
  const bytes = avatarBytes(data)
  return { bytes, hash: contentHash(bytes) }
}
