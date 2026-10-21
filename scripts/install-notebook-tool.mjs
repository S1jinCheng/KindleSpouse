import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import JSZip from 'jszip'
import { build } from 'esbuild'

const commit = '50da8be56403f04505ea08412d3dd0c57494350d'
const expected = 'a693d2f52f588db082d2aa2f31197376e3909fe03ce471881d2e97386ce1e055'
const directory = path.resolve('native/tools/notebook-converter')
await mkdir(directory, { recursive: true })
const response = await fetch(`https://codeload.github.com/sergazin/neo_scribe_to_pdf/zip/${commit}`)
if (!response.ok) throw new Error('Notebook converter source download failed')
const bytes = Buffer.from(await response.arrayBuffer())
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Notebook converter source checksum mismatch')
await writeFile(path.join(directory, 'upstream-source.zip'), bytes)
const license = await fetch('https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt')
if (!license.ok) throw new Error('Notebook converter license download failed')
await writeFile(path.join(directory, 'GPL-3.0.txt'), await license.text())
const zip = await JSZip.loadAsync(bytes)
for (const file of Object.values(zip.files)) {
  if (file.dir) continue
  const relative = file.name.split('/').slice(1).join('/')
  if (!relative || relative.includes('..') || !/^(src\/|LICENSE$|README.md$|package.json$|bun.lock$|tsconfig.json$)/.test(relative)) continue
  const target = path.join(directory, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, await file.async('nodebuffer'))
}
const upstream = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
const cliSource = path.join(directory, 'src', 'cli.ts')
const originalCli = await readFile(cliSource, 'utf8')
if (!originalCli.includes('.parseAsync();')) throw new Error('Notebook converter CLI entry has changed')
await writeFile(cliSource, originalCli.replace('.parseAsync();', '.parseAsync(process.argv, { from: "node" });'))
await writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...upstream, dependencies: { commander: '14.0.0', 'ion-js': '5.2.1', pdfkit: '0.17.2', 'sql.js': '1.13.0' }, devDependencies: {} }, null, 2))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this installer using npm run tools:notebooks')
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, windowsHide: true, stdio: 'inherit' })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error('Notebook converter dependency installation failed')))
})
await build({ entryPoints: [path.join(directory, 'src/cli.ts')], outfile: path.join(directory, 'cli.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', legalComments: 'external', banner: { js: '' } })
await writeFile(path.join(directory, 'BUILD.txt'), `Upstream: https://github.com/sergazin/neo_scribe_to_pdf\nCommit: ${commit}\nArchive SHA256: ${expected}\nLicense: GPL-3.0-only. Complete upstream source is included in upstream-source.zip, modified source is in src/.\nChanges: Commander parses process.argv explicitly in node mode for Electron's Node runtime; dependency versions are pinned.\nBuild: esbuild, bundled local TypeScript files, external npm packages; dependency versions pinned in package.json and package-lock.json.\n`)
console.log('Notebook converter installed with complete upstream source and license.')
await import('./build-notebook-inspector.mjs')
