import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { verifyDistribution } from './verify-distribution.mjs'
import { mkdir, mkdtemp, cp, readFile, writeFile } from 'node:fs/promises'

await verifyDistribution(path.resolve('native'))

for (const check of ['check-publication.mjs', 'check-history.mjs', 'check-package.mjs'])
  execFileSync(process.execPath, [path.join('scripts', check)], { stdio: 'inherit' })

process.env.ELECTRON_BUILDER_CACHE ??= path.resolve('.test-data/builder-cache')
await mkdir('.test-data', { recursive: true })
const application = await mkdtemp(path.resolve('.test-data/package-app-'))
for (const directory of ['dist', 'dist-electron']) await cp(directory, path.join(application, directory), { recursive: true })
const project = JSON.parse(await readFile('package.json', 'utf8'))
const { name, version, author, license, description, type, main } = project
await writeFile(path.join(application, 'package.json'), JSON.stringify({ name, version, author, license, description, type, main, dependencies: {} }, null, 2))
await writeFile(path.join(application, 'package-lock.json'), JSON.stringify({ name, version, lockfileVersion: 3, packages: { '': { name, version } } }))
const configuration = {
  ...project.build,
  electronVersion: project.devDependencies.electron,
  directories: { output: path.resolve('release'), buildResources: path.resolve('build') },
  extraResources: project.build.extraResources.map(resource => ({ ...resource, from: path.resolve(resource.from) })),
  win: { ...project.build.win, icon: path.resolve(project.build.win.icon) },
  npmRebuild: false,
}
const { build, Platform, Arch } = await import('electron-builder')
await build({ projectDir: application, targets: Platform.WINDOWS.createTarget(process.argv.includes('--portable') ? 'portable' : 'nsis', Arch.x64), publish: 'never', config: configuration })
await verifyDistribution(path.resolve('release/win-unpacked/resources/native'))
