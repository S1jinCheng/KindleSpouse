import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
const destination = 'dist-electron/licenses'
await mkdir(destination, { recursive: true })
const index = []
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory.startsWith('node_modules/') || info.dev) continue
  const packageFile = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8').catch(() => '{}'))
  if (!packageFile.name) continue
  const files = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\..*)?$/i.test(name))
  index.push(`${packageFile.name}@${packageFile.version} — ${info.license ?? packageFile.license ?? 'See upstream license'}`)
  for (const filename of files) {
    const content = await readFile(path.join(directory, filename), 'utf8').catch(() => undefined)
    if (content) await writeFile(path.join(destination, packageFile.name.replaceAll('/', '_').replaceAll('@', '') + '-' + filename + '.txt'), content)
  }
}
await writeFile(path.join(destination, 'INDEX.txt'), index.sort().join('\n') + '\n')
