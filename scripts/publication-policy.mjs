const privateDirectories = /(?:^|\/)(?:\.test-data|\.reader-private|device-backups|notes-backups|notebooks|\.notebooks|calibre-library|private|browser-downloads|scratch|cloud-snapshots|migration-backups|candidates|cloud-manifests|cloud-objects|notebook-catalogs|reader-sessions|reader-startup|sleep-previews|local-profile-identity)(?:\/|$)/i
const browserDirectories = /(?:^|\/)(?:Partitions|Local Storage|Session Storage|Network)(?:\/|$)/
const privateNames = /(?:^|\/)(?:rclone\.conf|credentials\.json|session\.json|source-session\.json|local-profile\.json|snapshot-manifest\.json|kindlespouse\.sqlite(?:-(?:wal|shm))?|Cookies(?:-journal)?|Login Data|Local State|Preferences|DevToolsActivePort|user-settings\.json|profile\.json|\.env(?:\..*)?)$/i
const privateExtensions = /\.(?:epub3?|pdf|azw\d?|mobi|kfx|prc|pdb|kpf|fb[23]|docx?|docm|odt|rtf|cb[rzt]|djvu?|xps|pptx|xlsx|chm|tcr|nbk|sdr|sqlite\d?|db|key|p12|pfx)(?:$|-)/i
const sourceOnly = /(?:^|\/)(?:node_modules|artifacts|release|native\/tools)(?:\/|$)|\.(?:pem|exe|zip|png|jpe?g|webp|gif|bmp|tiff?|avif|webm|mp4)$/i
const credentials = [
  ['credential value', /["']?(?:access[_-]?token|refresh[_-]?token|remix_userkey|id_token|client_secret|authorization)["']?\s*[:=]\s*["'][A-Za-z0-9._/+-]{20,}/i],
  ['environment credential', /(?:^|\n)\s*[A-Z0-9_]*(?:ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|REMIX_USERKEY)\s*=\s*[A-Za-z0-9._/+-]{20,}/i],
  ['Google access token', /\bya29\.[A-Za-z0-9_-]{30,}/],
  ['Google refresh token', /\b1\/\/[A-Za-z0-9_-]{30,}/],
  ['Google client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['personal Windows path', /C:[\\/]Users[\\/](?!Public\b|Default\b|USER\b)[^\s"'<>]+/i],
  ['saved photo', /["']?avatarImage["']?\s*[:=]\s*["']data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/]{32,}/i],
]
const brands = new Map([
  ['public/brand/icon.png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ['build/icon.ico', Buffer.from('00000100', 'hex')],
])

export function privatePublicationPath(filename, packaged = false) {
  const name = filename.replaceAll('\\', '/')
  if (name === '.env.example') return false
  return privateDirectories.test(name) || browserDirectories.test(name) || privateNames.test(name) || privateExtensions.test(name) || /(?:private[-_]?pairing|private[-_]?connection|private[-_]?profile)/i.test(name) || !packaged && sourceOnly.test(name) && !brands.has(name)
}

export function publicationIssues(filename, bytes, packaged = false) {
  const name = filename.replaceAll('\\', '/')
  if (privatePublicationPath(name, packaged)) return ['private or generated file']
  const signature = brands.get(name)
  if (signature) return bytes.length <= 4 * 1024 * 1024 && bytes.subarray(0, signature.length).equals(signature) ? [] : ['invalid brand asset']
  if (bytes.includes(0)) return packaged ? [] : ['unexpected binary']
  const text = bytes.toString('utf8')
  return credentials.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
}
