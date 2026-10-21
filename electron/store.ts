import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export class Store {
  private db: DatabaseSync

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(path.join(directory, 'kindlespouse.sqlite'))
    this.db.exec(
      'PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace,id))',
    )
  }

  list<T>(namespace: string): T[] {
    return this.db
      .prepare('SELECT payload FROM records WHERE namespace = ?')
      .all(namespace)
      .map((row) => JSON.parse(String(row.payload)) as T)
  }

  get<T>(namespace: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM records WHERE namespace = ? AND id = ?').get(namespace, id)
    return row ? (JSON.parse(String(row.payload)) as T) : undefined
  }

  put(namespace: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO records(namespace,id,payload) VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload',
      )
      .run(namespace, id, JSON.stringify(value))
  }

  remove(namespace: string, id: string) {
    this.db.prepare('DELETE FROM records WHERE namespace = ? AND id = ?').run(namespace, id)
  }

  close() {
    this.db.close()
  }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
