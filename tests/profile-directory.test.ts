import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../electron/store'
import { canonicalProfile, legacyProfiles, migrateProfilePaths, rememberedProfile, rememberProfile } from '../electron/profile-directory'

test('profile migration backs up first, rebases only existing private file paths and preserves account and title data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-profile-'))
  const actual = path.join(root, 'actual'), alias = path.join(root, 'logical')
  await mkdir(actual)
  await writeFile(path.join(actual, 'book.epub'), 'generated book')
  const original = new Store(actual)
  original.put('candidates', 'book', { id: 'book', path: path.join(alias, 'book.epub'), title: 'Original title' })
  original.put('notebooks', 'missing', { id: 'missing', path: path.join(alias, 'missing.nbk'), title: 'Keep title' })
  original.put('settings', 'main', { displayName: 'Fixture reader' })
  original.put('clouds', 'account', { id: 'account', connected: true })
  original.close()
  try {
    assert.equal(canonicalProfile(actual), actual)
    assert.equal(await migrateProfilePaths(actual, [alias]), 1)
    const result = new Store(actual)
    assert.equal(result.get<{ path: string }>('candidates', 'book')!.path, path.join(actual, 'book.epub'))
    assert.equal(result.get<{ path: string }>('notebooks', 'missing')!.path, path.join(alias, 'missing.nbk'))
    assert.deepEqual(result.get('settings', 'main'), { displayName: 'Fixture reader' })
    assert.deepEqual(result.get('clouds', 'account'), { id: 'account', connected: true })
    result.close()
    assert.equal((await readdir(path.join(actual, 'migration-backups'))).length, 1)
    assert.equal(await migrateProfilePaths(actual, [alias]), 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('isolated legacy profiles are discovered only when current profile has no book or cloud state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'KS-discovery-'))
  const current = path.join(root, 'current'), local = path.join(root, 'local')
  const legacy = path.join(local, 'Packages/OpenAI.Codex_fixture/LocalCache/Roaming/KindleSpouse')
  const store = new Store(legacy)
  store.put('candidates', 'book', { id: 'book' })
  store.close()
  try {
    assert.deepEqual(legacyProfiles(current, local), [legacy])
    const active = new Store(current)
    active.put('clouds', 'account', { id: 'account' })
    active.close()
    assert.deepEqual(legacyProfiles(current, local), [])
    assert.equal(rememberedProfile(current), undefined)
    await rememberProfile(current, legacy)
    assert.equal(rememberedProfile(current), legacy)
  } finally { await rm(root, { recursive: true, force: true }) }
})
