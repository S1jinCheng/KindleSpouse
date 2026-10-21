import { DatabaseSync } from 'node:sqlite'

export function notebookIdentity(value: string) {
  const normalized = value.trim().toLowerCase()
  const identities = normalized.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g)
  return identities?.length === 1 ? identities[0] : normalized.replace(/!!(?:pdoc|ebok)!!notebook$/, '')
}

export function readNotebookTitles(filename: string) {
  const database = new DatabaseSync(filename, { readOnly: true })
  const candidates = new Map<string, Set<string>>()
  try {
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const table = String(row.name)
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) continue
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map((column) => String(column.name))
      const title = ['title', 'display_title', 'displayTitle', 'p_title', 'p_titles_0_nominal', 'title_collation'].map((name) => columns.find((column) => column.toLowerCase() === name.toLowerCase())).find(Boolean)
      const identities = columns.filter((column) => /^(?:p_)?(?:uuid|guid|id|cdeKey|asin|location|contentId)$/i.test(column))
      const kind = columns.find((column) => column.toLowerCase() === 'node_type')
      if (!title || !identities.length) continue
      const fields = [...new Set([title, ...identities, ...(kind ? [kind] : [])])]
      for (const record of database.prepare(`SELECT ${fields.map((column) => `"${column}"`).join(',')} FROM "${table}" LIMIT 20000`).all()) {
        if (kind && /FOLDER|COLLECTION|ROOT/i.test(String(record[kind]))) continue
        if (typeof record[title] !== 'string' || !String(record[title]).trim()) continue
        for (const identity of identities) {
          if (typeof record[identity] !== 'string' || !String(record[identity]).trim()) continue
          const key = notebookIdentity(String(record[identity]))
          const values = candidates.get(key) ?? new Set<string>()
          values.add(String(record[title]).trim())
          candidates.set(key, values)
        }
      }
    }
    return new Map([...candidates].filter(([, values]) => values.size === 1).map(([identity, values]) => [identity, [...values][0]]))
  } finally { database.close() }
}
