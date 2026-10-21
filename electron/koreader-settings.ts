import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { contentHash } from './books'
import { koreaderData } from './notes'

export function layoutSettings(source: string) {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('阅读设置超过读取上限。')
  const data = koreaderData(source) ?? {}
  return Object.fromEntries(Object.entries(data).filter(([key, value]) => value !== undefined && /^(copt_|kopt_|cre_|font_|hyph_|highlight_|embedded_|last_xpointer$|last_page$|gamma_index$|line_space$|word_spacing$|word_expansion$|text_lang$|doc_lang$|cre_dom_version$|render_dpi$|view_mode$|visible_pages$|css$|css_fb2$|style_tweaks$|footer$|reader_footer_mode$|screen_dpi$|rotation_mode$|night_mode$)/.test(key)))
}

export function luaData(value: unknown, depth = 0): string {
  if (depth > 30) throw new Error('阅读设置嵌套过深。')
  if (typeof value === 'string') return '"' + value.replace(/[\\"\x00-\x1f]/g, character => character === '\\' ? '\\\\' : character === '"' ? '\\"' : '\\' + character.charCodeAt(0).toString().padStart(3, '0')) + '"'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'nil'
  if (typeof value !== 'object') throw new Error('阅读设置含有不支持的数据。')
  return '{' + Object.entries(value).filter(([, value]) => value !== undefined).map(([key, value]) => `[${/^(0|[1-9]\d{0,5})$/.test(key) ? key : luaData(key)}]=${luaData(value, depth + 1)}`).join(',') + '}'
}

export async function syncedLayout(directory: string, bookHash: string, format: string) {
  const root = path.join(directory, 'cloud-snapshots')
  const snapshots: { directory: string; createdAt: string; files: { relative: string; sha256: string }[] }[] = []
  for (const device of await readdir(root).catch(() => [])) {
    if (!/^[a-f0-9-]{36}$/.test(device)) continue
    for (const hash of await readdir(path.join(root, device)).catch(() => [])) {
      if (!/^[a-f0-9]{64}$/.test(hash)) continue
      const snapshot = path.join(root, device, hash)
      try {
        const manifest = JSON.parse(await readFile(path.join(snapshot, 'snapshot-manifest.json'), 'utf8'))
        if (!Array.isArray(manifest.files) || typeof manifest.createdAt !== 'string') continue
        snapshots.push({ directory: snapshot, createdAt: manifest.createdAt, files: manifest.files })
      } catch {}
    }
  }
  for (const snapshot of snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    for (const file of snapshot.files) {
      if (typeof file.relative !== 'string' || !file.relative.split('/').some(part => part.startsWith(bookHash.slice(0, 12) + '-') && part.endsWith('.sdr')) || !file.relative.endsWith(`/metadata.${format.split('.').pop()}.lua`)) continue
      const filename = path.resolve(snapshot.directory, file.relative)
      if (!filename.startsWith(snapshot.directory + path.sep)) continue
      const bytes = await readFile(filename).catch(() => undefined)
      if (!bytes || contentHash(bytes) !== file.sha256) continue
      return { settings: layoutSettings(bytes.toString('utf8')), syncedAt: snapshot.createdAt, exactBook: true }
    }
  }
  return undefined
}
