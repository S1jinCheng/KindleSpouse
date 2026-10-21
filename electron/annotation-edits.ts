import { randomUUID } from 'node:crypto'
import { contentHash } from './books'
import type { Store } from './store'
import type { ReadingNote } from '../src/shared'

export const noteRevision = (note: ReadingNote) => contentHash(Buffer.from(JSON.stringify([note.text, note.note ?? '', note.anchor?.sourcePosition ?? '', note.anchor?.endPosition ?? '', note.anchor?.page ?? null, note.addedAt ?? ''])))
export function mergeNote(store: Store, incoming: ReadingNote, relative: string, deviceId?: string) {
  const identity = contentHash(Buffer.from(JSON.stringify([deviceId ?? '', relative, incoming.kind, incoming.addedAt ?? '', incoming.anchor?.sourcePosition ?? incoming.location ?? '', incoming.anchor?.endPosition ?? incoming.text])))
  const prior = store.list<ReadingNote>('reading-notes').find(note => note.origin?.identity === identity) ?? store.get<ReadingNote>('reading-notes', incoming.id)
  const revision = noteRevision(incoming)
  const edit = prior?.edit && { ...prior.edit }
  if (edit && prior?.origin?.revision !== revision && prior?.origin && !['applied', 'local'].includes(edit.status)) {
    if (incoming.note === edit.note && !edit.deleted) edit.status = 'applied'
    else { edit.status = 'conflict'; edit.error = '设备标注已修改，请核对设备版本后重新编辑。' }
  }
  const note: ReadingNote = { ...incoming, id: prior?.id ?? identity, bookId: prior?.bookId ?? incoming.bookId, bookHash: prior?.bookHash ?? incoming.bookHash,
    origin: { relative, deviceId, identity, revision, text: incoming.text, note: incoming.note }, edit }
  store.put('reading-notes', note.id, note)
  return note.id
}

export function editNote(store: Store, id: string, text: string, deleted: boolean) {
  const note = store.get<ReadingNote>('reading-notes', id)
  if (!note) throw new Error('找不到这条标注。')
  if (note.edit && ['queued', 'uploaded'].includes(note.edit.status)) throw new Error('这条标注仍在等待设备回执，请同步后再修改。')
  const portable = note.source === 'koreader' && note.origin?.deviceId && note.bookHash && note.origin.relative.includes('.sdr/') && !note.origin.deleted
  const edit: NonNullable<ReadingNote['edit']> = { note: text, deleted, updatedAt: new Date().toISOString(), status: portable ? 'queued' : 'local', jobId: portable ? randomUUID() : undefined }
  store.put('annotation-history', randomUUID(), { noteId: id, savedAt: edit.updatedAt, value: note })
  store.put('reading-notes', id, { ...note, edit })
}

export function restoreNote(store: Store, id: string) {
  const note = store.get<ReadingNote>('reading-notes', id)
  if (!note) throw new Error('找不到这条标注。')
  if (note.edit && ['uploaded', 'queued'].includes(note.edit.status)) throw new Error('请等待设备回执后再修改。')
  if (note.edit?.status === 'applied') throw new Error('设备已应用修改。请从网盘更新后重新编辑，历史版本仍保留。')
  store.put('annotation-history', randomUUID(), { noteId: id, savedAt: new Date().toISOString(), value: note })
  store.put('reading-notes', id, { ...note, edit: undefined })
}

export function annotationJob(note: ReadingNote) {
  if (!note.origin || !note.edit?.jobId || !note.bookHash) throw new Error('缺少设备标注身份。')
  const relative = note.origin.relative
  const bookRelative = relative.replace(/\.sdr\/metadata\.([^/]+)\.lua$/i, '.$1')
  if (bookRelative === relative || !/^(Books|documents)\//.test(relative) || relative.split('/').some(part => !part || part === '..' || part === '.') || /[\\:\x00-\x1f]/.test(relative)) throw new Error('设备标注路径无效。')
  return { version: 1, jobId: note.edit.jobId, deviceId: note.origin.deviceId, noteId: note.id, bookHash: note.bookHash, bookRelative, relative,
    expected: { text: note.origin.text, note: note.origin.note ?? '', datetime: note.addedAt ?? '', pos0: note.anchor?.sourcePosition ?? '', pos1: note.anchor?.endPosition ?? '', page: note.anchor?.sourcePosition ? undefined : note.anchor?.page },
    operation: note.edit.deleted ? 'delete' : 'edit', note: note.edit.note }
}
