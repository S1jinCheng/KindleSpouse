export const KINDLE_MODELS = [
  { id: 'scribe-2022', name: 'Kindle Scribe 第一代（2022）', nativeCloud: false },
  { id: 'scribe-2024', name: 'Kindle Scribe 第二代（2024）', nativeCloud: false },
  { id: 'scribe-2025', name: 'Kindle Scribe 第三代／无前光款（2025）', nativeCloud: true },
  { id: 'scribe-colorsoft', name: 'Kindle Scribe Colorsoft', nativeCloud: true },
  { id: 'paperwhite-12', name: 'Kindle Paperwhite 第十二代（2024）', nativeCloud: false },
  { id: 'paperwhite-11', name: 'Kindle Paperwhite 第十一代（2021）', nativeCloud: false },
  { id: 'paperwhite-older', name: 'Kindle Paperwhite 其他型号', nativeCloud: false },
  { id: 'kindle', name: 'Kindle 基础款', nativeCloud: false },
  { id: 'colorsoft', name: 'Kindle Colorsoft', nativeCloud: false },
  { id: 'oasis', name: 'Kindle Oasis', nativeCloud: false },
  { id: 'other', name: '其他／暂不确定型号', nativeCloud: false },
] as const

export type KindleMode = 'native' | 'koreader'
export function kindleModel(id?: string) { return KINDLE_MODELS.find(model => model.id === id) ?? KINDLE_MODELS.at(-1)! }
export function kindleMode(settings: { kindleMode?: KindleMode }) { return settings.kindleMode ?? 'koreader' }
export function nativeCloudAvailable(settings: { kindleMode?: KindleMode; deviceModel?: string }) { return kindleMode(settings) === 'native' && kindleModel(settings.deviceModel).nativeCloud }
export function nativeDelivery(settings: { kindleMode?: KindleMode; deviceModel?: string; nativeDelivery?: 'kindle-email' | 'native-cloud' }) { return settings.nativeDelivery === 'native-cloud' && nativeCloudAvailable(settings) ? 'native-cloud' : 'kindle-email' }
export const KINDLE_MAIL_FORMATS = ['epub', 'epub3', 'pdf', 'txt', 'html', 'htm', 'rtf', 'jpg', 'jpeg', 'png', 'gif', 'bmp']
export const KINDLE_MAIL_MAX_BYTES = 25 * 1024 * 1024
export function kindleMailFormat(format?: string) { return Boolean(format && KINDLE_MAIL_FORMATS.includes(format.toLowerCase())) }
