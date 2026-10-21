import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { publicationIssues } from './publication-policy.mjs'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const failures = []
for (const filename of files) {
  const issues = publicationIssues(filename, await readFile(filename))
  if (issues.length) failures.push(`${filename}: ${issues.join(', ')}`)
}
if (failures.length) {
  console.error('Publication blocked. Private content is not printed.\n' + failures.join('\n'))
  process.exitCode = 1
} else console.log(`Publication check passed: ${files.length} tracked files; private files and credential patterns excluded.`)
