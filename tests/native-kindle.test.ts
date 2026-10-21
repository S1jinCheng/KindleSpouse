import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import nodemailer from 'nodemailer'
import { AppCore } from '../electron/core'
import { KindleMail } from '../electron/kindle-mail'
import { contentHash } from '../electron/books'
import { kindleModel, nativeCloudAvailable, KINDLE_MAIL_MAX_BYTES } from '../src/kindle-devices'
import type { KindleMailInput } from '../src/shared'
import { smtpFixture } from './smtp-fixture.mjs'

const input = (): KindleMailInput => ({ recipient: 'fixture@kindle.com', sender: 'fixture@example.org', host: 'smtp.example.org', port: 465, security: 'tls', password: randomUUID(), approvedSender: true })
const secretStore = () => { const values = new Map<string, string>(); return { values, get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value) } } }
async function epub(directory: string) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
  zip.file('book.opf', '<package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Native fixture</dc:title></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
  zip.file('chapter.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Native fixture</h1><p>Generated for acceptance testing.</p></body></html>')
  const filename = path.join(directory, 'fixture.epub')
  await writeFile(filename, await zip.generateAsync({ type: 'nodebuffer' }))
  return filename
}

test('model capability distinguishes stock cloud imports from KOReader automatic receiving', () => {
  for (const id of ['scribe-2022', 'scribe-2024', 'paperwhite-12', 'oasis', 'unknown']) assert.equal(kindleModel(id).nativeCloud, false)
  assert.equal(nativeCloudAvailable({ deviceModel: 'scribe-2025', kindleMode: 'native' }), true)
  assert.equal(nativeCloudAvailable({ deviceModel: 'scribe-2025', kindleMode: 'koreader' }), false)
})

test('new installs default to native browser mode; existing settings migrate without changing credentials or reader preferences', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-native-upgrade-'))
  const secrets = secretStore()
  const options = { directory, nativeDirectory: directory, secrets, openBrowser: async () => {}, readerAutostart: false }
  let core = new AppCore(options)
  try {
    assert.equal(core.snapshot().settings.kindleMode, 'native')
    assert.equal(core.snapshot().settings.readerEngine, 'browser')
    assert.equal(core.snapshot().settings.onboardingComplete, false)
    const previous = { ...core.snapshot().settings, kindleMode: undefined, onboardingComplete: undefined, readerEngine: 'koreader' as const, defaultCloudId: randomUUID() }
    core.store.put('settings', 'main', previous)
    secrets.set('preserved', randomUUID())
    const before = secrets.get('preserved')
    await core.close()
    core = new AppCore(options)
    assert.equal(core.snapshot().settings.kindleMode, 'koreader')
    assert.equal(core.snapshot().settings.onboardingComplete, true)
    assert.equal(core.snapshot().settings.defaultCloudId, previous.defaultCloudId)
    assert.equal(core.snapshot().settings.readerEngine, 'koreader')
    await core.saveSettings({ kindleMode: 'native', deviceModel: 'scribe-2022' })
    assert.equal(core.snapshot().settings.readerEngine, 'browser')
    assert.equal(secrets.get('preserved'), before)
    await assert.rejects(core.saveSettings({ onboardingComplete: true }), /发件邮箱/)
    core.store.remove('settings', 'main')
    const device = randomUUID()
    core.store.put('sync-devices', device, { id: device, accountId: randomUUID(), name: 'Legacy fixture', pairedAt: new Date().toISOString(), status: 'connected' })
    await core.close()
    core = new AppCore(options)
    assert.equal(core.snapshot().settings.kindleMode, 'koreader')
    assert.equal(core.snapshot().settings.onboardingComplete, true)
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})

test('mail credentials never appear in state, require encrypted TLS options and invalidate verification on configuration change', async () => {
  const secrets = secretStore(), configuration = input()
  let verified = 0
  const mail = new KindleMail(secrets, options => {
    assert.equal(options.requireTLS, true)
    assert.equal(options.secure, true)
    assert.equal(options.tls?.rejectUnauthorized, true)
    assert.equal(options.disableFileAccess, true)
    assert.equal(options.disableUrlAccess, true)
    return { verify: async () => { verified++ }, sendMail: async () => ({ accepted: [], rejected: [] }), close() {} }
  })
  mail.save(configuration)
  assert.equal(mail.state()?.configured, false)
  assert.equal(JSON.stringify(mail.state()).includes(configuration.password!), false)
  await mail.verify()
  assert.equal(verified, 1)
  assert.equal(mail.state()?.configured, true)
  assert.equal(mail.state()?.revision, mail.revision())
  mail.save({ ...configuration, password: undefined })
  assert.equal(mail.state()?.configured, true)
  mail.save({ ...configuration, recipient: 'other@kindle.com', password: undefined })
  assert.equal(mail.state()?.configured, false)
  assert.throws(() => mail.save({ ...configuration, host: 'other.example.org', password: undefined }), /重新填写/)
  for (const recipient of ['attacker@example.org', 'fixture@kindle.com\r\nBcc:x@example.org']) assert.throws(() => mail.save({ ...configuration, recipient }))
  assert.throws(() => mail.save({ ...configuration, port: 25 }))
  mail.clear()
  assert.equal(mail.state(), undefined)
})

test('preview then approve sends unchanged bytes through real local SMTP once and never claims device receipt', async () => {
  const smtp = await smtpFixture(), directory = await mkdtemp(path.join(tmpdir(), 'KS-native-send-')), secrets = secretStore()
  const mail = new KindleMail(secrets, () => nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, ignoreTLS: true, allowInternalNetworkInterfaces: true }))
  const core = new AppCore({ directory: path.join(directory, 'data'), nativeDirectory: directory, secrets, kindleMail: mail, openBrowser: async () => {}, readerAutostart: false })
  try {
    await core.saveKindleMail(input())
    await core.verifyKindleMail()
    const filename = await epub(directory), id = await core.importFile(filename), book = core.book(id)
    const approval = { candidateId: id, sha256: book.sha256, method: 'kindle-email' as const }
    await assert.rejects(core.approve(approval), /先打开/)
    await core.preview(id)
    assert.equal(smtp.messages.length, 0)
    const [a, b] = await Promise.all([core.approve(approval), core.approve(approval)])
    assert.equal(a, b)
    await core.processJobs()
    assert.equal(smtp.messages.length, 1)
    const job = core.snapshot().jobs[0]
    assert.equal(job.status, 'email_submitted')
    assert.equal(job.deviceReceivedAt, undefined)
    assert.equal(job.verifiedAt, undefined)
    assert.equal(smtp.messages[0].recipient, 'fixture@kindle.com')
    const encoded = smtp.messages[0].data.match(/Content-Transfer-Encoding: base64\r\n[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/)
    assert.ok(encoded)
    assert.deepEqual(Buffer.from(encoded[1].replace(/\s/g, ''), 'base64'), await readFile(filename))
    assert.equal(contentHash(await readFile(core.book(id).path)), book.sha256)
    assert.equal(core.book(id).library, true)
  } finally { await core.close(); await smtp.close(); await rm(directory, { recursive: true, force: true }) }
})

test('rejections are redacted, uncertain SMTP completion stays pending explicit retry, and unsupported files never reach transport', async () => {
  const secrets = secretStore(), configuration = input()
  let sends = 0
  const mail = new KindleMail(secrets, () => ({ verify: async () => {}, sendMail: async () => { sends++; throw Object.assign(new Error(configuration.password), { code: 'ETIMEDOUT', command: 'DATA' }) }, close() {} }))
  mail.save(configuration)
  await mail.verify()
  const revision = mail.revision()!
  await assert.rejects(mail.send({ title: 'Test', format: 'mobi', bytes: Buffer.from('fixture') }, revision, configuration.recipient, randomUUID()), /不支持/)
  await assert.rejects(mail.send({ title: 'Test', format: 'pdf', bytes: Buffer.alloc(KINDLE_MAIL_MAX_BYTES + 1) }, revision, configuration.recipient, randomUUID()), /25 MiB/)
  assert.equal(sends, 0)
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-native-unknown-'))
  const core = new AppCore({ directory: path.join(directory, 'data'), nativeDirectory: directory, secrets, kindleMail: mail, openBrowser: async () => {} })
  try {
    const id = await core.importFile(await epub(directory))
    await core.preview(id)
    await core.approve({ candidateId: id, sha256: core.book(id).sha256, method: 'kindle-email' })
    await core.processJobs()
    assert.equal(core.snapshot().jobs[0].status, 'delivery_unknown')
    assert.equal(JSON.stringify(core.snapshot()).includes(configuration.password!), false)
    assert.equal(sends, 1)
    await core.processJobs()
    assert.equal(sends, 1)
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})

test('stock cloud upload validates model capability and does not publish a KOReader receiving task', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-native-cloud-')), secrets = secretStore()
  const core = new AppCore({ directory: path.join(directory, 'data'), nativeDirectory: directory, secrets, openBrowser: async () => {} })
  try {
    const id = await core.importFile(await epub(directory)), account = randomUUID()
    await core.preview(id)
    core.store.put('clouds', account, { id: account, provider: 'drive', name: 'Fixture', connected: true })
    const approval = { candidateId: id, sha256: core.book(id).sha256, method: 'native-cloud' as const, cloudAccountId: account }
    await core.saveSettings({ deviceModel: 'scribe-2022' })
    await assert.rejects(core.approve(approval), /未确认支持/)
    await core.saveSettings({ deviceModel: 'scribe-2025' })
    let uploads = 0
    core.cloud.uploadAndVerify = async () => { uploads++ }
    core.sync.publishBook = async () => { throw new Error('Stock mode must not publish companion tasks') }
    await core.approve(approval)
    await core.processJobs()
    assert.equal(uploads, 1)
    assert.equal(core.snapshot().jobs[0].status, 'native_cloud_ready')
    assert.equal(core.snapshot().jobs[0].deviceReceivedAt, undefined)
    await core.saveSettings({ nativeDelivery: 'native-cloud', defaultCloudId: account, onboardingComplete: true })
    assert.equal(core.snapshot().settings.nativeDelivery, 'native-cloud')
    await core.saveSettings({ cloudFolder: 'KindleSpouse/Alternate' })
    await core.approve(approval)
    await core.processJobs()
    assert.equal(uploads, 2)
    assert.equal(core.snapshot().jobs.length, 2)
    await core.saveSettings({ deviceModel: 'scribe-2022' })
    assert.equal(core.snapshot().settings.nativeDelivery, 'kindle-email')
  } finally { await core.close(); await rm(directory, { recursive: true, force: true }) }
})


async function waitForInitialImport(core: AppCore, status: string) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (core.snapshot().initialImport?.status === status) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(JSON.stringify(core.snapshot().initialImport))
}

async function initialImportFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-initial-import-'))
  const book = await readFile(await epub(directory))
  let connected = false, exports = 0, failNotes = false, lists = 0
  const secrets = secretStore()
  const mail = new KindleMail(secrets, () => ({ verify: async () => {}, sendMail: async () => ({ accepted: ['fixture@kindle.com'], rejected: [] }), close() {} }))
  mail.save(input())
  await mail.verify()
  const options = {
    directory: path.join(directory, 'data'), nativeDirectory: directory, secrets, kindleMail: mail, openBrowser: async () => {}, readerAutostart: false,
    transport: {
      list: async () => { lists++; return connected ? [{ id: 'fixture-device', name: 'Fixture Kindle' }] : [] },
      upload: async () => { assert.fail('Import must not write to Kindle') },
      export: async () => { assert.fail('Full import must collect books and notes together'); return { files: 0, directory: '' } },
      exportNotes: async (_id: string, destination: string) => {
        exports++
        const files = [
          { relative: 'Books/Fixture.epub', bytes: book },
          { relative: '.notebooks/Fixture/Notes.pdf', bytes: Buffer.from('%PDF-1.4\nGenerated notebook fixture') },
          { relative: '.notebooks/Fixture/page.png', bytes: Buffer.from('Generated notebook image fixture') },
          { relative: 'documents/My Clippings.txt', bytes: Buffer.from('Native fixture (Author)\n- Your Highlight on page 1 | Location 1-2 | Added on Monday, October 19, 2026 10:00:00 AM\n\nGenerated highlight.\n==========\n') },
        ]
        for (const file of files) { const target = path.join(destination, file.relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.bytes) }
        await writeFile(path.join(destination, 'snapshot-manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files: files.map(file => ({ relative: file.relative, bytes: file.bytes.length, sha256: contentHash(file.bytes) })) }))
        return { files: files.length, directory: destination }
      },
    },
  }
  const create = () => {
    const core = new AppCore(options)
    core.cloud.writeBytes = async () => { assert.fail('Initial import must stay local') }
    const read = core.notebookLibrary.importSnapshot.bind(core.notebookLibrary)
    core.notebookLibrary.importSnapshot = async snapshot => { if (failNotes) { failNotes = false; throw new Error('Fixture disconnected while indexing notes') } return read(snapshot) }
    return core
  }
  return { directory, create, connect: () => { connected = true }, failNotes: () => { failNotes = true }, counts: () => ({ exports, lists }) }
}

test('setup completion automatically waits for USB, imports books and notes once, and preserves that decision across restart', async () => {
  const fixture = await initialImportFixture()
  let core = fixture.create()
  try {
    core.startInitialImport()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.counts().lists, 0)
    await core.saveSettings({ kindleMode: 'native', deviceModel: 'scribe-2022', onboardingComplete: true })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(core.snapshot().initialImport?.status, 'waiting_device')
    assert.match(core.snapshot().initialImport!.message, /邮件传书无法读取/)
    assert.equal(core.snapshot().candidates.length, 0)
    await core.close()
    core = fixture.create()
    core.startInitialImport()
    fixture.connect()
    await core.refreshDevices()
    await waitForInitialImport(core, 'complete')
    const state = core.snapshot()
    assert.equal(fixture.counts().exports, 1)
    assert.equal(state.candidates.length, 1)
    assert.equal(state.candidates[0].format, 'epub')
    assert.equal(state.candidates[0].library, true)
    assert.equal(state.candidates[0].fromDevice, true)
    assert.equal(state.notebooks.filter(book => book.classification === 'notebook').length, 1)
    assert.equal(state.readingNotes.length, 1)
    assert.equal(state.initialImport?.books, 1)
    assert.equal(state.initialImport?.annotations, 1)
    assert.equal(state.jobs.length, 0)
    await core.close()
    core = fixture.create()
    core.startInitialImport()
    await core.refreshDevices()
    await core.saveSettings({ onboardingComplete: true })
    assert.equal(fixture.counts().exports, 1)
    assert.equal(core.snapshot().initialImport?.status, 'complete')
    assert.equal(core.snapshot().candidates.length, 1)
  } finally { await core.close(); await rm(fixture.directory, { recursive: true, force: true }) }
})

test('failed initial note indexing resumes the verified full snapshot without recopying books or mixing notebook assets into library', async () => {
  const fixture = await initialImportFixture(), core = fixture.create()
  try {
    fixture.connect()
    fixture.failNotes()
    core.startInitialImport()
    await core.saveSettings({ kindleMode: 'native', deviceModel: 'scribe-2022', onboardingComplete: true })
    await waitForInitialImport(core, 'failed')
    assert.equal(core.snapshot().candidates.length, 1)
    assert.match(core.snapshot().initialImport!.error!, /disconnected/)
    await core.refreshDevices()
    await waitForInitialImport(core, 'complete')
    assert.equal(fixture.counts().exports, 1)
    assert.equal(core.snapshot().candidates.length, 1)
    assert.equal(core.snapshot().notebooks.filter(book => book.classification === 'notebook').length, 1)
    assert.equal(core.snapshot().readingNotes.length, 1)
    assert.equal(core.snapshot().initialImport?.error, undefined)
    assert.equal(core.snapshot().initialImport?.books, 1)
  } finally { await core.close(); await rm(fixture.directory, { recursive: true, force: true }) }
})

test('initial import interrupted by app exit resumes and never marks an unconnected native mailbox as imported', async () => {
  const fixture = await initialImportFixture()
  let core = fixture.create()
  try {
    await core.saveSettings({ deviceModel: 'scribe-2022', onboardingComplete: true })
    assert.equal(fixture.counts().exports, 0)
    core.store.put('initial-import', 'main', { ...core.snapshot().initialImport!, status: 'reading' })
    await core.close()
    core = fixture.create()
    assert.equal(core.snapshot().initialImport?.status, 'waiting_device')
    core.startInitialImport()
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(core.snapshot().initialImport?.status, 'waiting_device')
    fixture.connect()
    await core.refreshDevices()
    await waitForInitialImport(core, 'complete')
    assert.equal(fixture.counts().exports, 1)
  } finally { await core.close(); await rm(fixture.directory, { recursive: true, force: true }) }
})


test('pending initial import detects a later USB connection automatically without a refresh click', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = await initialImportFixture(), core = fixture.create()
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    core.startInitialImport()
    await core.saveSettings({ deviceModel: 'scribe-2022', onboardingComplete: true })
    for (let turn = 0; turn < 10; turn++) await settle()
    assert.equal(core.snapshot().initialImport?.status, 'waiting_device')
    fixture.connect()
    context.mock.timers.tick(15000)
    const deadline = Date.now() + 10000
    while (core.snapshot().initialImport?.status !== 'complete' && Date.now() < deadline) await settle()
    assert.equal(core.snapshot().initialImport?.status, 'complete')
    assert.equal(fixture.counts().exports, 1)
    assert.equal(core.snapshot().candidates.length, 1)
  } finally { await core.close(); await rm(fixture.directory, { recursive: true, force: true }) }
})
