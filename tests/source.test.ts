import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SourcePool } from '../electron/source-pool'
import { ZlibSource, sourceError } from '../electron/source'
import type { runProcess } from '../electron/process'
import { CloudBridge } from '../electron/cloud'

const domain = 'https://zlib.bz'
const profile = JSON.stringify({ daily_remaining: 8, daily_allowed: 10 })
async function setup(execute: typeof runProcess) {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-source-check-'))
  const values = new Map<string, string>()
  const pool = new SourcePool(() => {}, async input => new Response(JSON.stringify(String(input).startsWith(domain + '/') ? { success: 1, domains: [] } : { success: 0 })))
  const source = new ZlibSource('zlib.exe', directory, { get: key => values.get(key), set: (key, value) => { values.set(key, value) } }, () => {}, pool, execute)
  source.saveSession(domain, { remix_userid: '123', remix_userkey: 'private-test-key' })
  return { source, values, directory, cleanup: async () => { await source.close(); await rm(directory, { recursive: true, force: true }) } }
}

test('browser cookies require a real account and a verified profile before reporting connected', async () => {
  let calls = 0, temporary = ''
  const env = await setup(async (_executable, args, options) => {
    calls++
    assert.deepEqual(args, ['profile', '--json'])
    temporary = options!.cwd!
    assert.equal(options!.env!.USERPROFILE, temporary)
    assert.equal(options!.env!.HOME, temporary)
    const session = JSON.parse(await readFile(path.join(temporary, '.config/zlib/session.json'), 'utf8'))
    assert.equal(session.cookies.remix_userkey, 'private-test-key')
    assert.equal(args.join(' ').includes('private-test-key'), false)
    return profile
  })
  try {
    assert.equal(env.source.account(domain).status, 'unverified')
    assert.equal(env.source.connected(domain), false)
    assert.equal(env.source.saveSession(domain, { remix_userid: '0', remix_userkey: 'guest' }), false)
    const first = env.source.verify(domain)
    assert.equal(env.source.verify(domain), first)
    await first
    assert.equal(env.source.connected(domain), true)
    assert.equal(env.source.account(domain).remaining, 8)
    assert.equal(env.source.account(domain).dailyLimit, 10)
    assert.equal(env.source.saveSession(domain, { remix_userid: '123', remix_userkey: 'private-test-key' }), false)
    await env.source.verify(domain)
    assert.equal(calls, 1)
    await assert.rejects(stat(temporary), { code: 'ENOENT' })
  } finally { await env.cleanup() }
})

test('invalid saved JSON and anonymous cookies never crash the application or count as signed in', async () => {
  const env = await setup(async () => profile)
  try {
    for (const value of ['{invalid', 'null', '{}', JSON.stringify({ domain, cookies: { remix_userid: '0', remix_userkey: 'guest' } })]) {
      env.values.set('zlib-session', value)
      assert.equal(env.source.connected(domain), false)
      assert.equal(env.source.hasSession(domain), false)
      assert.equal(env.source.account(domain).status, 'signed_out')
    }
  } finally { await env.cleanup() }
})

test('expired authentication clears connected state while quota exhaustion preserves a valid login', async () => {
  let failure = ''
  const env = await setup(async (_exe, args) => {
    if (args[0] === 'profile') return profile
    throw new Error(failure)
  })
  try {
    await env.source.verify(domain)
    failure = 'daily download limit reached'
    await assert.rejects(env.source.search('public domain', domain), /额度/)
    assert.equal(env.source.connected(domain), true)
    failure = 'zlibrary: EAPI search failed: not authorized'
    await assert.rejects(env.source.search('public domain', domain), /登录已失效/)
    assert.equal(env.source.connected(domain), false)
    assert.equal(env.source.hasSession(domain), false)
    assert.equal(env.source.account(domain).status, 'expired')
    assert.equal(env.source.account(domain).error?.includes('private-test-key'), false)
  } finally { await env.cleanup() }
})

test('unrecognized or malformed profile responses do not turn cookies into a verified login', async () => {
  const env = await setup(async () => JSON.stringify({ success: 1 }))
  try {
    await assert.rejects(env.source.verify(domain), /未返回有效结果/)
    assert.equal(env.source.connected(domain), false)
    assert.equal(env.source.account(domain).status, 'unavailable')
  } finally { await env.cleanup() }
})

test('a slow validation cannot replace a newly signed-in account', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const env = await setup(async () => { await held; return profile })
  try {
    const validation = env.source.verify(domain)
    env.source.saveSession(domain, { remix_userid: '456', remix_userkey: 'new-test-key' })
    release()
    await validation
    const saved = JSON.parse(env.values.get('zlib-session')!)
    assert.equal(saved.cookies.remix_userid, '456')
    assert.equal(saved.cookies.remix_userkey, 'new-test-key')
    assert.equal(env.source.connected(domain), false)
  } finally { release(); await env.cleanup() }
})

test('downloads retain the version hash, report file bytes and reject incomplete or ambiguous results', async () => {
  let files = ['book.epub']
  const env = await setup(async (_exe, args) => {
    if (args[0] === 'profile') return profile
    assert.equal(args[args.length - 1], '123:abc')
    const destination = args[args.indexOf('--dir') + 1]
    for (const name of files) await writeFile(path.join(destination, name), 'downloaded fixture')
    return ''
  })
  try {
    const progress: number[] = []
    const saved = await env.source.download('123:abc', 'abc', domain, path.join(env.directory, 'valid'), bytes => progress.push(bytes))
    assert.equal(path.basename(saved), 'book.epub')
    assert.equal(progress.at(-1), 18)
    files = ['book.epub.partial']
    await assert.rejects(env.source.download('123', 'abc', domain, path.join(env.directory, 'incomplete')))
    files = ['a.epub', 'b.epub']
    await assert.rejects(env.source.download('123', 'abc', domain, path.join(env.directory, 'ambiguous')))
  } finally { await env.cleanup() }
})

test('raw upstream errors and credential values are never exposed in user-facing errors', () => {
  assert.equal(sourceError(new Error('network request timed out private-test-key')).message.includes('private-test-key'), false)
  assert.match(sourceError(new Error('HTTP 517')).message, /网页验证/)
  assert.match(sourceError(new Error('not logged in')).message, /登录已失效/)
})

test('empty cloud upload folders yield no file results while authorization failures remain visible', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-source-cloud-'))
  let message = 'directory not found'
  const values = new Map([['cloud:test', JSON.stringify({ provider: 'drive', token: {} })]])
  const cloud = new CloudBridge('unused', directory, { get: key => values.get(key), set: (key, value) => { values.set(key, value) } }, async () => {}, async (_exe, args) => {
    assert.ok(args.includes('remote:KindleSpouse/Inbox'))
    throw new Error(message)
  })
  try {
    assert.deepEqual(await cloud.search('test', 'public domain'), [])
    message = 'invalid_grant'
    await assert.rejects(cloud.search('test', 'public domain'), /invalid_grant/)
  } finally { await cloud.close(); await rm(directory, { recursive: true, force: true }) }
})

test('source result validation drops invalid identities and non-book payloads before rendering or downloading', async () => {
  const env = await setup(async (_exe, args) => args[0] === 'profile' ? profile : JSON.stringify({ books: [
    { id: '123:abc', hash: 'abc', name: 'Valid book', authors: ['Original author'], extension: 'EPUB', publisher: 'Test press' },
    { id: '124:def', hash: 'def', name: 'Original MOBI', extension: 'MOBI' },
    { id: '125:ghi', hash: 'ghi', name: 'Original FB2', extension: 'FB2.ZIP' },
    { id: '--flag', name: { unsafe: true }, extension: 'epub' },
    { id: '123:abc', hash: 'other', name: 'Wrong version', extension: 'epub' },
    { id: '456', name: 'Bad author', authors: [{}], extension: 'pdf' },
    { id: '789', name: 'Unsupported format', extension: 'exe' },
  ] }))
  try {
    const books = await env.source.search('Valid', domain)
    assert.equal(books.length, 3)
    assert.equal(books[0].extension, 'epub')
    assert.equal(books[0].publisher, 'Test press')
    assert.equal(books[1].extension, 'mobi')
    assert.equal(books[2].extension, 'fb2.zip')
  } finally { await env.cleanup() }
})

test('login validation proceeds when one endpoint is healthy without waiting for every slow endpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-source-fast-'))
  const values = new Map<string, string>()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const pool = new SourcePool(() => {}, async input => {
    if (!String(input).startsWith(domain + '/')) await held
    return new Response(JSON.stringify({ success: 1, domains: [] }))
  })
  const source = new ZlibSource('unused', directory, { get: key => values.get(key), set: (key, value) => { values.set(key, value) } }, () => {}, pool, async () => profile)
  try {
    source.saveSession(domain, { remix_userid: '123', remix_userkey: 'test-key' })
    await Promise.race([source.verify(domain), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Validation waited for unrelated endpoints')), 2000); timer.unref() })])
    assert.equal(source.connected(domain), true)
    assert.equal(pool.snapshot().checking, true)
  } finally { release(); await source.close(); await rm(directory, { recursive: true, force: true }) }
})
