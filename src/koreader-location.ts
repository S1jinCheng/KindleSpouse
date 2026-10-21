export function koreaderLocation(position: string, domVersion?: number) {
  return typeof domVersion === 'number' && Number.isSafeInteger(domVersion) && domVersion > 0 ? `koreader:v1:${domVersion}:${position}` : `koreader:${position}`
}

export function parseKoreaderLocation(value: string) {
  const match = value.match(/^koreader:v1:(\d{1,10}):([\s\S]*)$/)
  return match ? { position: match[2], domVersion: Number(match[1]) } : { position: value.slice('koreader:'.length), domVersion: undefined }
}
