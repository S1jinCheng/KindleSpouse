import { existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

export function canonicalProfile(directory: string) {
  const database = path.join(directory, 'kindlespouse.sqlite')
  return existsSync(database) ? path.dirname(realpathSync.native(database)) : path.resolve(directory)
}

export function rememberedProfile(directory: string) {
  try {
    const value = JSON.parse(readFileSync(path.join(directory, 'profile-choice.json'), 'utf8'))
    if (value.version === 1 && typeof value.directory === 'string' && path.isAbsolute(value.directory) && existsSync(path.join(value.directory, 'kindlespouse.sqlite'))) return canonicalProfile(value.directory)
  } catch {}
}

export async function rememberProfile(directory: string, selected: string) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'profile-choice.json'), JSON.stringify({ version: 1, directory: selected }), { mode: 0o600 })
}

function profileWeight(directory: string) {
  const filename = path.join(directory, 'kindlespouse.sqlite')
  if (!existsSync(filename)) return 0
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(filename, { readOnly: true })
    const row = database.prepare("SELECT COUNT(*) AS total FROM records WHERE namespace IN ('candidates','clouds','sync-devices')").get()
    return Number(row?.total ?? 0)
  } catch { return 0 } finally { database?.close() }
}

export function legacyProfiles(directory: string, localAppData: string | undefined) {
  if (!localAppData || profileWeight(directory)) return []
  const packages = path.join(localAppData, 'Packages')
  if (!existsSync(packages)) return []
  const current = canonicalProfile(directory).toLowerCase()
  const profiles = new Map<string, string>()
  for (const item of readdirSync(packages, { withFileTypes: true })) {
    if (!item.isDirectory() || !item.name.startsWith('OpenAI.Codex_')) continue
    const candidate = path.join(packages, item.name, 'LocalCache/Roaming/KindleSpouse')
    if (!profileWeight(candidate)) continue
    const resolved = canonicalProfile(candidate)
    if (resolved.toLowerCase() !== current) profiles.set(resolved.toLowerCase(), resolved)
  }
  return [...profiles.values()]
}

export async function migrateProfilePaths(directory: string, aliases: string[]) {
  const filename = path.join(directory, 'kindlespouse.sqlite')
  if (!existsSync(filename)) return 0
  const roots = aliases.map(alias => path.resolve(alias)).filter(alias => alias.toLowerCase() !== directory.toLowerCase())
  if (!roots.length) return 0
  const database = new DatabaseSync(filename)
  try {
    const rows = database.prepare("SELECT namespace,id,payload FROM records WHERE namespace IN ('candidates','notebooks','device-snapshots')").all()
    const updates: { namespace: string; id: string; payload: string }[] = []
    for (const row of rows) {
      const value = JSON.parse(String(row.payload))
      let changed = false
      for (const key of ['path', 'previewPath', 'pdfPath', 'thumbnailPath', 'directory']) {
        if (typeof value[key] !== 'string') continue
        const previous = path.resolve(value[key])
        const alias = roots.find(root => previous.toLowerCase().startsWith(root.toLowerCase() + path.sep))
        if (!alias) continue
        const replacement = path.join(directory, path.relative(alias, previous))
        if (!existsSync(replacement)) continue
        value[key] = replacement
        changed = true
      }
      if (changed) updates.push({ namespace: String(row.namespace), id: String(row.id), payload: JSON.stringify(value) })
    }
    if (!updates.length) return 0
    const destination = path.join(directory, 'migration-backups')
    await mkdir(destination, { recursive: true })
    await backup(database, path.join(destination, `before-canonical-paths-${Date.now()}.sqlite`))
    database.exec('BEGIN IMMEDIATE')
    try {
      const update = database.prepare('UPDATE records SET payload=? WHERE namespace=? AND id=?')
      for (const row of updates) update.run(row.payload, row.namespace, row.id)
      database.exec('COMMIT')
    } catch (error) { database.exec('ROLLBACK'); throw error }
    return updates.length
  } finally { database.close() }
}
