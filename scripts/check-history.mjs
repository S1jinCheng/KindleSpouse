import { execFileSync } from 'node:child_process'
import { publicationIssues, privatePublicationPath } from './publication-policy.mjs'

const git = (args, options = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options })
if (git(['rev-parse', '--is-shallow-repository']).trim() === 'true') throw new Error('History check requires a full clone. Fetch the complete history before publication.')
const objects = git(['rev-list', '--objects', 'HEAD', '--branches', '--remotes=origin', '--tags']).trim().split('\n').filter(Boolean).map(line => {
  const position = line.indexOf(' ')
  return { id: position < 0 ? line : line.slice(0, position), name: position < 0 ? '' : line.slice(position + 1) }
})
const names = new Map(objects.map(object => [object.id, object.name]))
const metadata = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: objects.map(object => object.id).join('\n') + '\n' }).trim().split('\n').map(line => {
  const [id, type, size] = line.split(' ')
  return { id, type, size: Number(size), name: names.get(id) }
}).filter(object => object.type === 'blob')
const content = git(['cat-file', '--batch'], { input: Buffer.from(metadata.map(object => object.id).join('\n') + '\n'), encoding: null })
const failures = []
const historicalNames = new Set(git(['log', '--format=', '--name-only', '-z', '--no-renames', '-m', 'HEAD', '--branches', '--remotes=origin', '--tags']).split('\0').map(name => name.trim()).filter(Boolean))
for (const name of historicalNames) if (privatePublicationPath(name)) failures.push(`${name}: private path in reachable history`)
let position = 0
for (const object of metadata) {
  const start = content.indexOf(10, position) + 1
  const bytes = content.subarray(start, start + object.size)
  position = start + object.size + 1
  const issues = publicationIssues(object.name, bytes)
  if (issues.length) failures.push(`${object.id.slice(0, 12)} ${object.name}: ${issues.join(', ')}`)
}
if (failures.length) {
  console.error('History publication blocked. Secret values are not printed.\n' + failures.join('\n'))
  process.exitCode = 1
} else console.log(`History check passed: ${metadata.length} reachable file versions and ${historicalNames.size} historical paths across local branches, origin and tags.`)
