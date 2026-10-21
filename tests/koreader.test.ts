import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { layoutSettings, luaData, syncedLayout } from '../electron/koreader-settings'
import { linuxPath, readerRuntimeRoot } from '../electron/koreader'
import { contentHash } from '../electron/books'
import { readerErrorMessage } from '../src/reader-errors'

test('reader errors show the actionable message without Electron transport details', () => {
  assert.equal(readerErrorMessage(new Error("Error invoking remote method 'command-koreader': Error: 阅读会话已中断，请重新打开以继续阅读。")), '阅读会话已中断，请重新打开以继续阅读。')
  assert.equal(readerErrorMessage(new Error('电脑缺少设备使用的字体。')), '电脑缺少设备使用的字体。')
  assert.equal(readerErrorMessage(undefined), '阅读器暂时不可用，请重新打开。')
})

test('reading profiles parse literal data without executing Lua and omit annotations and account values', () => {
  const result = layoutSettings('os.execute("must never run") return { font_face="Noto Serif", copt_font_size=22, copt_h_page_margins={10,10}, annotations={{text="private"}}, password="secret", evil=function() return os.execute("never") end }')
  assert.equal(result.font_face, 'Noto Serif')
  assert.equal(result.copt_font_size, 22)
  assert.equal(result.annotations, undefined)
  assert.equal(result.password, undefined)
  assert.equal(result.evil, undefined)
  const restored = layoutSettings('return ' + luaData(result))
  assert.deepEqual(restored, result)
  assert.deepEqual(restored.copt_h_page_margins, Object.assign(Object.create(null), { 1: 10, 2: 10 }))
})

test('Lua serialization preserves Unicode and escapes quotes, slashes and control bytes as data', () => {
  const font = '中文字体 "书"\\font\n'
  assert.equal(layoutSettings('return ' + luaData({ font_face: font })).font_face, font)
  assert.throws(() => luaData(Number.POSITIVE_INFINITY))
  assert.throws(() => layoutSettings('x'.repeat(1024 * 1024 + 1)), /上限/)
})

test('Windows reader paths preserve spaces and Unicode while rejecting network and control-character paths', () => {
  assert.equal(linuxPath('D:\\Book Folder\\中文.epub'), '/mnt/d/Book Folder/中文.epub')
  assert.throws(() => linuxPath('\\\\server\\share\\book.epub'))
  assert.throws(() => linuxPath('D:\\book\n.epub'))
})

test('native runtime uses a per-profile temporary directory outside encrypted application data', () => {
  const first = path.join(tmpdir(), 'Encrypted-profile-a'), second = path.join(tmpdir(), 'Encrypted-profile-b')
  assert.notEqual(readerRuntimeRoot(first), readerRuntimeRoot(second))
  assert.equal(readerRuntimeRoot(first), readerRuntimeRoot(path.join(first, '.')))
  assert.ok(!readerRuntimeRoot(first).startsWith(first + path.sep))
  assert.ok(readerRuntimeRoot(first).startsWith(path.join(tmpdir(), 'KindleSpouse-reader') + path.sep))
})

test('device profiles match book identity and verified snapshot bytes rather than similar titles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-reader-settings-'))
  const sha256 = 'a'.repeat(64)
  const directory = path.join(root, 'cloud-snapshots', 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), 'b'.repeat(64))
  const relative = 'Books/Inbox/' + sha256.slice(0, 12) + '-Book.sdr/metadata.epub.lua'
  const source = Buffer.from('return {font_face="Noto Serif",copt_font_size=22}')
  try {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
    await writeFile(path.join(directory, relative), source)
    await writeFile(path.join(directory, 'snapshot-manifest.json'), JSON.stringify({ createdAt: '2026-10-18T00:00:00Z', files: [{ relative, sha256: contentHash(source) }] }))
    const found = await syncedLayout(root, sha256, 'epub')
    assert.equal(found?.exactBook, true)
    assert.equal(found?.settings.copt_font_size, 22)
    assert.equal(await syncedLayout(root, 'c'.repeat(64), 'epub'), undefined)
    await writeFile(path.join(directory, relative), 'return {font_face="Changed"}')
    assert.equal(await syncedLayout(root, sha256, 'epub'), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
