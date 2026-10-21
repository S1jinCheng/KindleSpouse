import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { Store } from '../electron/store'
import { CompanionSetup, componentPath } from '../electron/companion-setup'
import { companionPackage } from '../electron/device-package'
import type { CompanionInspection } from '../src/shared'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-setup-'))
  const store = new Store(path.join(root, 'profile'))
  const native = path.join(root, 'native')
  for (const folder of ['tools/companion', 'tools/sleep-screen', 'companion/plugin', 'tools/reader-fonts']) await mkdir(path.join(native, folder), { recursive: true })
  for (const file of ['kindlespouse-sync', 'rclone', 'ca.pem', 'Go-LICENSE.txt', 'rclone-LICENSE.txt', 'CA-MPL-2.0.txt']) await writeFile(path.join(native, 'tools/companion', file), 'public fixture')
  for (const file of ['catalog.sh', 'sync.sh', 'plugin/main.lua', 'plugin/LICENSE']) await writeFile(path.join(native, 'companion', file), 'public fixture')
  for (const file of ['spouse_preset.lua', 'upstream-source.zip']) await writeFile(path.join(native, 'tools/sleep-screen', file), 'public fixture')
  await writeFile(path.join(native, 'reader-fonts.json'), JSON.stringify({ assets: [] }))
  const pairedDeviceId = randomUUID(), accountId = randomUUID(), usbDeviceId = 'fixture-usb'
  let inspection: CompanionInspection = { readerInstalled: true, readerVersion: 'v2026.07.1', hasCredential: false }
  let authorizations = 0, installs = 0, fail = false, receipt: Record<string, unknown> | undefined
  const transferred: string[][] = []
  const options = {
    store, directory: path.join(root, 'profile'), nativeDirectory: native, protect: async () => {},
    transport: {
      inspectCompanion: async () => inspection,
      installCompanion: async (_id: string, directory: string, manifest: string, _backup: string, progress?: (files: number, total: number) => void) => {
        installs++
        const plan = JSON.parse(await readFile(manifest, 'utf8'))
        transferred.push(plan.files.map((file: { relative: string }) => file.relative))
        const component = JSON.parse(await readFile(path.join(directory, 'kindlespouse/component-manifest.json'), 'utf8'))
        receipt = { version: 1, protocol: 1, deviceId: pairedDeviceId, installationId: component.installationId, revision: component.revision, checkedAt: new Date().toISOString() }
        progress?.(plan.files.length, plan.files.length)
        if (fail) throw new Error('USB disconnected')
        return { verified: true, files: plan.files.length }
      },
    },
    pair: async (_account: string, _name: string, destination: string) => {
      authorizations++
      const zip = await companionPackage(native)
      zip.file('kindlespouse/config.json', JSON.stringify({ deviceId: pairedDeviceId }))
      zip.file('kindlespouse/rclone.conf', 'synthetic private grant')
      await writeFile(destination, await zip.generateAsync({ type: 'nodebuffer' }))
      store.put('sync-devices', pairedDeviceId, { id: pairedDeviceId, accountId, status: 'awaiting_pairing' })
    },
    readReceipt: async () => { if (!receipt) throw new Error('not yet'); return Buffer.from(JSON.stringify(receipt)) },
  }
  return {
    root, store, options, pairedDeviceId, accountId, usbDeviceId, transferred,
    setup: () => new CompanionSetup(options),
    inspect: (value: CompanionInspection) => { inspection = value },
    receipt: () => receipt!, setReceipt: (value: Record<string, unknown> | undefined) => { receipt = value },
    fail: (value: boolean) => { fail = value }, calls: () => ({ authorizations, installs }),
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('component destinations exclude books, preferences, pause files and traversal', () => {
  for (const relative of ['documents/book.epub', '.notebooks/nbk', 'koreader/settings.reader.lua', 'kindlespouse/pause.requested', '../kindlespouse/rclone', 'koreader/fonts/kindlespouse/../book', 'kindlespouse\\rclone', 'koreader/plugins/other.koplugin/main.lua']) assert.equal(componentPath(relative, true), false, relative)
  assert.equal(componentPath('kindlespouse/rclone.conf'), false)
  assert.equal(componentPath('kindlespouse/rclone.conf', true), true)
  assert.equal(componentPath('kindlespouse/lan.json'), false)
  assert.equal(componentPath('kindlespouse/lan.json', true), true)
  assert.equal(componentPath('koreader/plugins/kindlespouse.koplugin/LICENSE'), true)
})

test('fresh install is not ready until its own revision and installation receipt arrive; private staging is removed', async () => {
  const f = await fixture()
  try {
    const setup = f.setup()
    const installed = await setup.install(f.usbDeviceId, f.accountId, 'Fixture Kindle')
    assert.equal(installed.stage, 'awaiting_device')
    assert.equal(f.transferred[0].at(-1), 'kindlespouse/component-manifest.json')
    const receipt = f.receipt()
    f.setReceipt(undefined)
    assert.equal((await setup.verify()).stage, 'awaiting_device')
    f.setReceipt({ ...receipt, installationId: randomUUID() })
    assert.equal((await setup.verify()).stage, 'awaiting_device')
    f.setReceipt({ ...receipt, revision: '0'.repeat(64) })
    assert.equal((await setup.verify()).stage, 'awaiting_device')
    f.setReceipt(receipt)
    assert.equal((await setup.verify()).stage, 'ready')
    assert.equal(f.setup().snapshot().stage, 'ready')
    assert.deepEqual(await readdir(path.join(f.root, 'profile/private/device-install')), [])
    assert.equal(f.store.list('companion-pending').length, 0)
    assert.deepEqual(f.calls(), { authorizations: 1, installs: 1 })
  } finally { await f.close() }
})

test('interrupted installs reuse device authorization after restart and updates exclude credentials', async () => {
  const f = await fixture()
  try {
    f.fail(true)
    assert.equal((await f.setup().install(f.usbDeviceId, f.accountId, 'Fixture')).stage, 'error')
    assert.equal(f.store.list('companion-pending').length, 1)
    f.fail(false)
    f.inspect({ readerInstalled: true, readerVersion: 'v2026.07.1', hasCredential: true })
    assert.equal((await f.setup().install(f.usbDeviceId, f.accountId, 'Fixture')).stage, 'awaiting_device')
    assert.equal(f.calls().authorizations, 1)
    f.inspect({ readerInstalled: true, readerVersion: 'v2026.07.1', pairedDeviceId: f.pairedDeviceId, hasCredential: true })
    assert.equal((await f.setup().install(f.usbDeviceId, f.accountId, 'Fixture')).stage, 'awaiting_device')
    assert.ok(!f.transferred.at(-1)!.includes('kindlespouse/rclone.conf'))
    assert.ok(!f.transferred.at(-1)!.includes('kindlespouse/config.json'))
    assert.equal(f.calls().authorizations, 1)
  } finally { await f.close() }
})

test('missing reader, incompatible version and unrelated existing pairing never write device files', async () => {
  const f = await fixture()
  try {
    for (const inspection of [
      { readerInstalled: false, hasCredential: false },
      { readerInstalled: true, readerVersion: 'v2025.01', hasCredential: false },
      { readerInstalled: true, readerVersion: 'v2026.07.1', pairedDeviceId: randomUUID(), hasCredential: true },
    ]) {
      f.inspect(inspection)
      assert.equal((await f.setup().install(f.usbDeviceId, f.accountId, 'Fixture')).stage, 'error')
    }
    assert.deepEqual(f.calls(), { authorizations: 0, installs: 0 })
  } finally { await f.close() }
})

test('public overlay shares exact component revision with pairing bundles and never includes credentials', async () => {
  const f = await fixture()
  try {
    const first = await companionPackage(f.options.nativeDirectory), second = await companionPackage(f.options.nativeDirectory)
    const one = JSON.parse(await first.file('kindlespouse/component-manifest.json')!.async('string'))
    const two = JSON.parse(await second.file('kindlespouse/component-manifest.json')!.async('string'))
    assert.equal(one.revision, two.revision)
    assert.equal(first.file('kindlespouse/rclone.conf'), null)
    assert.equal(first.file('kindlespouse/config.json'), null)
    assert.ok(one.files.every((file: { relative: string }) => componentPath(file.relative)))
    assert.ok(one.files.some((file: { relative: string }) => file.relative.endsWith('/LICENSE')))
    const encoded = await first.generateAsync({ type: 'nodebuffer' })
    assert.ok(await JSZip.loadAsync(encoded))
  } finally { await f.close() }
})

test('optional LAN pairing is generated locally for the same paired device and excluded from the public overlay', async () => {
  const f = await fixture()
  try {
    const setup = new CompanionSetup({ ...f.options, localProfile: async deviceId => {
      assert.equal(deviceId, f.pairedDeviceId)
      return Buffer.from(JSON.stringify({ deviceId, urls: ['https://192.168.0.2:8443'], token: randomUUID() }))
    } })
    assert.equal((await setup.install(f.usbDeviceId, f.accountId, 'Fixture')).stage, 'awaiting_device')
    assert.ok(f.transferred[0].includes('kindlespouse/lan.json'))
    assert.equal((await companionPackage(f.options.nativeDirectory)).file('kindlespouse/lan.json'), null)
  } finally { await f.close() }
})
