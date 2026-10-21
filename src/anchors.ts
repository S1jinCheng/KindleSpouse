export function normalizeText(value: string) {
  let text = ''
  const positions: number[] = []
  let offset = 0
  for (const character of value) {
    const normalized = character.normalize('NFKC').toLowerCase().replace(/\s/g, '')
    for (let index = 0; index < normalized.length; index++) positions.push(offset)
    text += normalized
    offset += character.length
  }
  positions.push(value.length)
  return { text, positions }
}

export function quoteMatches(value: string, quote: string, prefix?: string, suffix?: string) {
  const normalized = normalizeText(value),
    target = normalizeText(quote).text
  if (!target || target.length < 2) return []
  const before = prefix ? normalizeText(prefix).text : '',
    after = suffix ? normalizeText(suffix).text : ''
  const matches: { start: number; end: number }[] = []
  let offset = 0
  while (offset <= normalized.text.length - target.length) {
    const index = normalized.text.indexOf(target, offset)
    if (index < 0) break
    const end = index + target.length
    if (
      (!before || normalized.text.slice(Math.max(0, index - before.length), index).endsWith(before)) &&
      (!after || normalized.text.slice(end, end + after.length).startsWith(after))
    )
      matches.push({ start: normalized.positions[index], end: normalized.positions[end] })
    offset = index + 1
    if (matches.length > 100) break
  }
  return matches
}
