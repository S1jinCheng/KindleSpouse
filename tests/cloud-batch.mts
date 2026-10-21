import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { CloudBridge } from '../electron/cloud'
import { contentHash } from '../electron/books'
import { runProcess } from '../electron/process'

await mkdir('.test-data', { recursive: true })
const root = await mkdtemp(path.resolve('.test-data/cloud-batch-runtime-'))
const executable = process.env.KINDLESPOUSE_TEST_RCLONE ?? path.resolve('native/tools/rclone.exe')
let calls = 0, verifies = 0
const cloud = new CloudBridge(executable, path.join(root, 'scratch'), { get: () => JSON.stringify({ provider: 'drive', token: {} }), set: () => {} }, async () => {}, async (exe, args, options) => {
  calls++
  const local = args.map(value => value.startsWith('remote:') ? path.join(root, 'remote', value.slice(7)) : value)
  return runProcess(exe, local, options)
})
try {
  await mkdir(path.join(root, 'originals'))
  const files = []
  for (const name of ['中文书籍：为什么？.txt', '标点＊与｜符号.txt', 'Emoji 📖 完整书籍.txt', '# leading character.txt']) {
    const source = path.join(root, 'originals', name), bytes = Buffer.from(`Complete book bytes for ${name}`)
    await writeFile(source, bytes)
    files.push({ source, name, sha256: contentHash(bytes) })
  }
  await cloud.uploadManyAndVerify('fixture', 'KindleSpouse/Inbox', files, () => { verifies++ })
  await cloud.uploadManyAndVerify('fixture', 'KindleSpouse/Inbox', files, () => { verifies++ })
  for (const file of files) assert.equal(contentHash(await readFile(path.join(root, 'remote/KindleSpouse/Inbox', file.name))), file.sha256)
  assert.equal(calls, 4)
  assert.equal(verifies, 2)
  const changed = path.join(root, 'remote/KindleSpouse/Inbox', files[0].name)
  const altered = Buffer.alloc((await readFile(changed)).length, 88)
  await writeFile(changed, altered)
  await assert.rejects(cloud.uploadManyAndVerify('fixture', 'KindleSpouse/Inbox', files, () => { throw new Error('A changed immutable object must not reach verification') }), /immutable/i)
  assert.deepEqual(await readFile(changed), altered)
  console.log(JSON.stringify({ passed: true, actualRclone: true, preservedChinesePunctuation: true, preservedEmojiAndLeadingHash: true, everyReturnedHashVerified: true, networkNotRequired: true }))
} finally {
  await cloud.close()
  assert.equal(path.dirname(root), path.resolve('.test-data'))
  await rm(root, { recursive: true, force: true })
}
