import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicationIssues } from '../scripts/publication-policy.mjs'

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url))
const secret = 'synthetic-' + 'x'.repeat(48)
const run = (name, directory, args = []) => spawnSync(process.execPath, [path.join(scripts, name), ...args], { cwd: directory, encoding: 'utf8' })
async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'KS-publication-'))
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.name', 'Publication Test'])
  git(['config', 'user.email', 'publication@example.invalid'])
  const save = async (name, content) => { await mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await writeFile(path.join(directory, name), content) }
  const close = async () => { assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }) }
  return { directory, git, save, close }
}

test('publication blocks ebooks, notebooks, photos, browser sessions and encrypted credential stores', () => {
  for (const name of ['book.epub', 'note.nbk', 'avatar.webp', 'private/kindlespouse.sqlite', 'Partitions/source/Network/Cookies', 'local-profile-identity/private-key.pem', 'KindleSpouse-Private-Pairing.zip', 'rclone.conf', 'profile.json', '.env.local'])
    assert.ok(publicationIssues(name, Buffer.from('private content')).length, name)
  assert.deepEqual(publicationIssues('src/network/client.ts', Buffer.from('export const ready = true')), [])
  assert.deepEqual(publicationIssues('.env.example', Buffer.from('CLOUD_CLIENT_ID=')), [])
})

test('credential values are detected in JSON, source, environment assignments and saved photos', () => {
  const bodies = [JSON.stringify({ access_token: secret }), `refresh_token: '${secret}'`, `CLOUD_REFRESH_TOKEN=${secret}`, 'ya29.' + 'a'.repeat(40), '1//' + 'b'.repeat(40), 'ghp_' + 'c'.repeat(40), JSON.stringify({ avatarImage: 'data:image/png;base64,' + 'a'.repeat(80) })]
  for (const body of bodies) assert.ok(publicationIssues('settings.json', Buffer.from(body)).length)
  assert.deepEqual(publicationIssues('src/cloud.ts', Buffer.from('const token = JSON.stringify(credential.token)')), [])
})

test('a deleted secret still blocks publication through reachable history without printing its value', async () => {
  const env = await workspace()
  try {
    await env.save('README.md', 'Public source')
    await env.save('settings.json', JSON.stringify({ refresh_token: secret }))
    env.git(['add', '.'])
    env.git(['commit', '-qm', 'Initial fixture'])
    env.git(['rm', '-q', 'settings.json'])
    env.git(['commit', '-qm', 'Remove private fixture'])
    assert.equal(run('check-publication.mjs', env.directory).status, 0)
    const result = run('check-history.mjs', env.directory)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /History publication blocked/)
    assert.equal((result.stdout + result.stderr).includes(secret), false)
  } finally { await env.close() }
})

test('history scans non-default remote branches and accepts a clean history', async () => {
  const env = await workspace()
  try {
    await env.save('README.md', 'Public source')
    env.git(['add', '.'])
    env.git(['commit', '-qm', 'Clean fixture'])
    assert.equal(run('check-history.mjs', env.directory).status, 0)
    const clean = env.git(['rev-parse', 'HEAD']).trim()
    await env.save('old.nbk', 'private notebook')
    env.git(['add', '.'])
    env.git(['commit', '-qm', 'Private branch fixture'])
    env.git(['update-ref', 'refs/remotes/origin/old-feature', 'HEAD'])
    env.git(['checkout', '--detach', clean])
    assert.equal(run('check-publication.mjs', env.directory).status, 0)
    assert.equal(run('check-history.mjs', env.directory).status, 1)
  } finally { await env.close() }
})

test('package scans include ignored runtime files and reject credentials inside native resources', async () => {
  const env = await workspace()
  try {
    await env.save('bundle/native/tools/helper.txt', 'Public helper')
    assert.equal(run('check-package.mjs', env.directory, ['bundle']).status, 0)
    await env.save('bundle/native/tools/settings.json', JSON.stringify({ access_token: secret }))
    const result = run('check-package.mjs', env.directory, ['bundle'])
    assert.equal(result.status, 1)
    assert.equal((result.stdout + result.stderr).includes(secret), false)
  } finally { await env.close() }
})

test('history rejects a private filename even when its content shares a public blob', async () => {
  const env = await workspace()
  try {
    await env.save('README.md', 'Shared content')
    env.git(['add', '.'])
    env.git(['commit', '-qm', 'Public fixture'])
    await env.save('book.epub', 'Shared content')
    env.git(['add', '.'])
    env.git(['commit', '-qm', 'Private path with reused content'])
    env.git(['rm', '-q', 'book.epub'])
    env.git(['commit', '-qm', 'Remove private path'])
    assert.equal(run('check-history.mjs', env.directory).status, 1)
  } finally { await env.close() }
})
