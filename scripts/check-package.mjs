import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { publicationIssues, privatePublicationPath } from './publication-policy.mjs'

const roots = process.argv.slice(2)
const defaults = !roots.length
if (defaults) roots.push('dist', 'dist-electron', 'native', 'native/tools/koreader/squashfs-root/usr/lib/koreader')
const failures = []
let checked = 0
async function inspect(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name), relative = [prefix, entry.name].filter(Boolean).join('/')
    if (defaults && (relative === 'native/tools/koreader' || /^native\/tools\/companion\/(?:README\.html|rclone\.1)$/.test(relative))) continue
    if (entry.isSymbolicLink()) { failures.push(`${relative}: symbolic link`); continue }
    if (privatePublicationPath(relative, true)) { failures.push(`${relative}: private file or directory`); continue }
    if (entry.isDirectory()) await inspect(filename, relative)
    else if (entry.isFile()) {
      checked++
      const bytes = await readFile(filename)
      const issues = publicationIssues(relative, bytes, true)
      if (issues.length) failures.push(`${relative}: ${issues.join(', ')}`)
    }
  }
}
for (const root of roots) await inspect(path.resolve(root), path.basename(root))
if (failures.length) {
  console.error('Package blocked. Private content is not printed.\n' + failures.join('\n'))
  process.exitCode = 1
} else console.log(`Package privacy check passed: ${checked} files; no private paths or credential patterns detected.`)
