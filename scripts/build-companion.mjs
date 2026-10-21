import { execFileSync } from 'node:child_process'
import { mkdir, copyFile } from 'node:fs/promises'
import path from 'node:path'

const go = process.env.KINDLESPOUSE_GO || path.resolve('.test-data/go-sdk/bin/go.exe')
const directory = path.resolve('native/tools/companion')
await mkdir(directory, { recursive: true })
const common = {
  ...process.env,
  CGO_ENABLED: '0',
  GOCACHE: path.resolve('.test-data/go-cache'),
  GOMODCACHE: path.resolve('.test-data/go-modules'),
}
execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(directory, 'kindlespouse-sync'), '.'], {
  cwd: 'native/companion',
  windowsHide: true,
  stdio: 'inherit',
  env: { ...common, GOOS: 'linux', GOARCH: 'arm', GOARM: '7' },
})
execFileSync(go, ['build', '-trimpath', '-o', path.resolve('.test-data/companion-test.exe'), '.'], {
  cwd: 'native/companion',
  windowsHide: true,
  stdio: 'inherit',
  env: { ...common, GOOS: 'windows', GOARCH: 'amd64' },
})
await copyFile(path.join(path.dirname(go), '..', 'LICENSE'), path.join(directory, 'Go-LICENSE.txt'))
execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(directory, 'kindlespouse-link.exe'), './cmd/lan-identity'], {
  cwd: 'native/companion', windowsHide: true, stdio: 'inherit',
  env: { ...common, GOOS: 'windows', GOARCH: 'amd64' },
})
await copyFile('native/tools/rclone-LICENSE.txt', path.join(directory, 'rclone-LICENSE.txt'))
const license = await fetch('https://raw.githubusercontent.com/spdx/license-list-data/main/text/MPL-2.0.txt')
if (!license.ok) throw new Error('CA bundle license download failed')
const { writeFile } = await import('node:fs/promises')
await writeFile(path.join(directory, 'CA-MPL-2.0.txt'), await license.text())
console.log('Built standalone ARMv7 companion and Windows acceptance binary.')
