import type { CloudAccount, ReadingStats, Settings } from './shared'

export function profileReading(stats: ReadingStats, now = Date.now()) {
  const asOf = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
  const first = new Date(Date.parse(asOf + 'T00:00:00Z') - 365 * 86400000).toISOString().slice(0, 10)
  const days = stats.days.filter(day => day.seconds > 0 && day.date <= asOf)
  return { asOf, totalSeconds: stats.totalSeconds, todaySeconds: days.find(day => day.date === asOf)?.seconds ?? 0,
    readingDays: days.length, bookCount: stats.books.length,
    days: days.filter(day => day.date >= first).map(({ date, seconds }) => ({ date, seconds })).sort((a, b) => a.date.localeCompare(b.date)) }
}

export function sleepProfile(settings: Settings, avatarHash?: string, accounts?: CloudAccount[], stats?: ReadingStats) {
  const clouds = accounts?.slice().sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20).map(account => ({
    id: account.id.slice(0, 100), name: account.name.slice(0, 80), provider: account.provider,
    connected: account.connected === true && !account.error,
  }))
  return { version: 1, enabled: settings.sleepCoverEnabled ?? true, displayName: settings.displayName?.trim() || 'Reader', avatar: settings.avatar?.trim() || settings.displayName?.trim().slice(0, 2).toUpperCase() || 'R', ...(avatarHash ? { avatarHash } : {}), ...(clouds ? { clouds } : {}), ...(stats ? { reading: profileReading(stats) } : {}) }
}
export function readingStreak(days: ReadingStats['days'], now = Date.now()) {
  const dates = new Set(days.filter(day => day.seconds > 0).map(day => day.date))
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now))
  let cursor = Date.parse(today + 'T12:00:00+08:00'), count = 0
  if (!dates.has(today)) cursor -= 86400000
  while (dates.has(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(cursor)))) { count++; cursor -= 86400000 }
  return count
}
