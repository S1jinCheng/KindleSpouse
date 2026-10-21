import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../electron/store'
import { annotationJob, editNote, mergeNote, restoreNote } from '../electron/annotation-edits'
import type { ReadingNote } from '../src/shared'

test('cloud annotation edits preserve manual edition links, reject concurrent edits and reconcile source changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-note-edit-'))
  const store = new Store(directory)
  try {
    const original: ReadingNote = { id: 'a'.repeat(64), bookTitle: 'Original', text: 'A unique quotation', kind: 'highlight', note: 'Original note', addedAt: '2026-10-19 10:00:00', source: 'koreader', anchor: { format: 'epub', sourcePosition: '/body/p[1]', endPosition: '/body/p[2]' } }
    const relative = 'Books/Inbox/Original.sdr/metadata.epub.lua'
    const deviceId = 'd97c4d6e-1b81-4db8-86fd-d9d5d97900df'
    const id = mergeNote(store, original, relative, deviceId)
    const read = () => store.get<ReadingNote>('reading-notes', id)!
    store.put('reading-notes', id, { ...read(), bookId: 'chosen-edition', bookHash: 'b'.repeat(64) })
    editNote(store, id, 'Edited on desktop', false)
    assert.equal(read().edit?.status, 'queued')
    assert.throws(() => editNote(store, id, 'Concurrent edit', true), /等待设备/)
    mergeNote(store, original, relative, deviceId)
    assert.equal(read().edit?.note, 'Edited on desktop')
    assert.equal(read().bookId, 'chosen-edition')
    const job = annotationJob(read())
    assert.equal(job.bookRelative, 'Books/Inbox/Original.epub')
    assert.equal(job.expected.note, 'Original note')
    assert.equal(job.note, 'Edited on desktop')
    mergeNote(store, { ...original, note: 'Edited on Kindle' }, relative, deviceId)
    assert.equal(read().edit?.status, 'conflict')
    assert.equal(read().note, 'Edited on Kindle')
    assert.equal(read().edit?.note, 'Edited on desktop')
    restoreNote(store, id)
    assert.equal(read().edit, undefined)
    editNote(store, id, 'New agreed note', false)
    mergeNote(store, { ...original, note: 'New agreed note' }, relative, deviceId)
    assert.equal(read().edit?.status, 'applied')
    assert.equal(store.list('reading-notes').length, 1)
    assert.ok(store.list('annotation-history').length >= 3)
  } finally { store.close(); await rm(directory, { recursive: true, force: true }) }
})

test('native Kindle edits are reversible local overlays and never become writeback jobs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-native-note-'))
  const store = new Store(directory)
  try {
    const original: ReadingNote = { id: 'c'.repeat(64), bookTitle: 'Original', text: 'Quote', kind: 'highlight', source: 'kindle' }
    const id = mergeNote(store, original, 'documents/My Clippings.txt')
    editNote(store, id, 'Local note', true)
    const note = store.get<ReadingNote>('reading-notes', id)!
    assert.equal(note.text, 'Quote')
    assert.equal(note.edit?.status, 'local')
    assert.equal(note.edit?.jobId, undefined)
    assert.throws(() => annotationJob(note))
    mergeNote(store, original, 'documents/My Clippings.txt')
    assert.equal(store.get<ReadingNote>('reading-notes', id)?.edit?.deleted, true)
    restoreNote(store, id)
    assert.equal(store.get<ReadingNote>('reading-notes', id)?.edit, undefined)
  } finally { store.close(); await rm(directory, { recursive: true, force: true }) }
})
