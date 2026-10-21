import { createHash } from 'node:crypto'
import { Store } from './store'
import type { ReadingSession, ReadingStats } from '../src/shared'

const dayKey = (time: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(time))

export class ReadingHistory {
  private cached?: ReadingStats
  private cachedDay?: string
  constructor(private store: Store) {}
  record(session: ReadingSession) {
    const start = Date.parse(session.startedAt),
      end = Date.parse(session.endedAt)
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end > Date.now() + 300000 ||
      !Number.isFinite(session.seconds) ||
      session.seconds <= 0 ||
      session.seconds > (end - start) / 1000 + 1 ||
      end - start > 86400000
    )
      throw new Error('阅读记录的时间范围无效。')
    if (session.source === 'desktop' && end - start > 65000) throw new Error('电脑阅读记录需按活跃时间分段保存。')
    const id = createHash('sha256').update(`${session.deviceId}:${session.source}:${session.id}`).digest('hex')
    this.store.put('reading-sessions', id, { ...session, id, seconds: Math.min(session.seconds, (end - start) / 1000) })
    this.cached = undefined
  }
  stats(now = Date.now()): ReadingStats {
    if (this.cached && this.cachedDay === dayKey(now)) return this.cached
    const sessions = this.store
      .list<ReadingSession>('reading-sessions')
      .filter(session => session.source === 'koreader' && !['desktop', 'desktop-preview'].includes(session.deviceId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const intervals = new Map<string, number>()
    const days = new Map<string, { seconds: number; books: Set<string> }>()
    const books = new Map<string, number>()
    let totalSeconds = 0
    for (const session of sessions) {
      const start = Date.parse(session.startedAt),
        end = Date.parse(session.endedAt)
      const key = `${session.deviceId}:${session.source}`
      const covered = intervals.get(key) ?? 0
      const effectiveStart = Math.max(start, covered)
      intervals.set(key, Math.max(covered, end))
      if (effectiveStart >= end) continue
      const ratio = session.seconds / ((end - start) / 1000)
      let cursor = effectiveStart
      while (cursor < end) {
        const stop = Math.min(end, (Math.floor((cursor + 28800000) / 86400000) + 1) * 86400000 - 28800000)
        const seconds = ((stop - cursor) / 1000) * ratio
        const date = dayKey(cursor)
        const day = days.get(date) ?? { seconds: 0, books: new Set<string>() }
        day.seconds += seconds
        day.books.add(session.bookTitle)
        days.set(date, day)
        books.set(session.bookTitle, (books.get(session.bookTitle) ?? 0) + seconds)
        totalSeconds += seconds
        cursor = stop
      }
    }
    this.cachedDay = dayKey(now)
    this.cached = {
      todaySeconds: days.get(dayKey(now))?.seconds ?? 0,
      totalSeconds,
      days: [...days]
        .map(([date, value]) => ({ date, seconds: value.seconds, books: [...value.books] }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      books: [...books].map(([title, seconds]) => ({ title, seconds })).sort((a, b) => b.seconds - a.seconds),
    }
    return this.cached
  }
}
