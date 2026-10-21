import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, symlink, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import { AppCore } from '../electron/core'
import { contentHash } from '../electron/books'
import { koreaderLocation } from '../src/koreader-location'
import { getAcceptanceFormats } from '../scripts/acceptance-formats.mjs'
import { getAcceptancePdf } from '../scripts/acceptance-book.mjs'

await mkdir('.test-data', { recursive: true })
const directory = await mkdtemp(path.join(path.resolve('.test-data'), 'formats-native-'))
const runtime = path.join(directory, 'native')
await mkdir(path.join(runtime, 'reader'), { recursive: true })
await symlink(path.resolve('native/tools'), path.join(runtime, 'tools'), 'junction')
await copyFile('native/reader/bridge.lua', path.join(runtime, 'reader/bridge.lua'))
await copyFile('native/reader/annotations.lua', path.join(runtime, 'reader/annotations.lua'))
const core = new AppCore({ directory: path.join(directory, 'data'), nativeDirectory: runtime, secrets: { get: () => undefined, set: () => {} }, openBrowser: async () => {} })
const verified: string[] = []
try {
  console.log('Generating original native document formats.')
  let files = [...await getAcceptanceFormats(path.join(directory, 'books')), await getAcceptancePdf()]
  if (process.env.KINDLESPOUSE_FORMAT_ONLY) files = files.filter(filename => filename.endsWith('.' + process.env.KINDLESPOUSE_FORMAT_ONLY))
  let firstImage: Uint8Array | undefined, secondImage: Uint8Array | undefined
  const resume: { id: string; page: number }[] = []
  for (const filename of files) {
    const original = await readFile(filename)
    const id = await core.importFile(filename)
    const first = await core.openKoreader(id)
    assert.ok(first.pages > 1)
    assert.ok(Array.isArray(first.toc))
    const same = await core.openKoreader(id)
    assert.equal(same.sessionId, first.sessionId)
    const next = await core.koreader.command(first.sessionId, core.book(id).format === 'pdf' ? { action: 'page', page: 2 } : { action: 'next' })
    assert.equal(next.page, first.page + 1)
    await core.saveReading(id, koreaderLocation(next.location, next.domVersion), next.page / next.pages)
    if (['mobi', 'fb2.zip'].includes(core.book(id).format)) resume.push({ id, page: next.page })
    assert.notEqual(contentHash(next.image), contentHash(first.image))
    assert.equal(core.book(id).sha256, contentHash(original))
    assert.deepEqual(await readFile(core.book(id).path), original)
    if (!firstImage) { firstImage = first.image; secondImage = next.image }
    if (core.book(id).format === 'mobi') {
      await mkdir('artifacts', { recursive: true })
      await writeFile('artifacts/native_mobi_page.png', next.image)
      await core.catalog.start('127.0.0.1')
      await core.approve({ candidateId: id, sha256: core.book(id).sha256, method: 'opds' })
      for (let attempt = 0; attempt < 200 && core.snapshot().jobs[0].status !== 'published'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(core.snapshot().jobs[0].status, 'published')
      const info = core.catalog.info!
      const headers = { Authorization: 'Basic ' + Buffer.from(info.username + ':' + info.password).toString('base64') }
      const feed = await (await fetch(info.address, { headers })).text()
      assert.ok(feed.includes('application/x-mobipocket-ebook'))
      const target = feed.match(/href="(\/books\/[^" ]+)"/)![1]
      assert.deepEqual(Buffer.from(await (await fetch(new URL(target, info.address), { headers })).arrayBuffer()), original)
    }
    verified.push(core.book(id).format)
    console.log(JSON.stringify({ nativeFormat: core.book(id).format, pages: first.pages, nextPage: next.page, domVersion: next.domVersion, originalPreserved: true }))
  }
  if (!process.env.KINDLESPOUSE_FORMAT_ONLY) {
    const imageFile = path.join(directory, 'Original.png')
    await writeFile(imageFile, firstImage!)
    const image = await core.openKoreader(await core.importFile(imageFile))
    assert.equal(image.pages, 1)
    verified.push('png')
    const comicFile = path.join(directory, 'Original.cbz')
    await writeFile(comicFile, await new JSZip().file('01.png', firstImage!).file('02.png', secondImage!).generateAsync({ type: 'nodebuffer' }))
    const comic = await core.openKoreader(await core.importFile(comicFile))
    assert.equal(comic.pages, 2)
    const next = await core.koreader.command(comic.sessionId, { action: 'page', page: 2 })
    assert.equal(next.page, 2)
    verified.push('cbz')
  }
  for (const saved of resume) {
    const restored = await core.openKoreader(saved.id)
    console.log(JSON.stringify({ resumed: core.book(saved.id).format, page: restored.page, pages: restored.pages, domVersion: restored.domVersion }))
    assert.equal(restored.page, saved.page)
    const reloaded = await core.openKoreader(saved.id, true)
    assert.notEqual(reloaded.sessionId, restored.sessionId)
    assert.equal(reloaded.page, saved.page)
    assert.equal(reloaded.pages, restored.pages)
  }
  await writeFile(process.env.KINDLESPOUSE_FORMAT_ONLY ? '.test-data/native-format-targeted.json' : '.test-data/native-formats-verified.json', JSON.stringify({ verified, realEngine: true, sameFileDelivery: true, noConversionAtPreview: true }))
  console.log(JSON.stringify({ passed: true, verified }))
} catch (error) {
  const detail = await readFile(path.join(directory, 'data/reader-last-error.log'), 'utf8').catch(() => '')
  await writeFile('.test-data/native-format-error.log', detail)
  console.error(detail.slice(-5000))
  throw error
} finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
