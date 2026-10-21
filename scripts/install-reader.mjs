import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const version = 'v2026.07.1'
const name = `koreader-${version}-x86_64.AppImage`
const expected = 'e60ed106cf4e824d50394a259b3aa6c46fb1daee189df73a1734e5732b5dc245'
if (process.platform !== 'win32') throw new Error('The bundled reader adapter currently supports Windows with Ubuntu on WSL.')
const directory = path.resolve('native/tools/koreader')
if (!/^[a-z]:[\\/]/i.test(directory)) throw new Error('Install the reader on a local Windows drive.')
await mkdir(directory, { recursive: true })
const temporary = await mkdtemp(path.join(tmpdir(), 'KS-reader-install-'))
try {
  const response = await fetch(`https://github.com/koreader/koreader/releases/download/${version}/${name}`, { signal: AbortSignal.timeout(180000) })
  if (!response.ok || Number(response.headers.get('content-length')) > 60 * 1024 * 1024) throw new Error('Could not download the pinned KOReader release.')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 60 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('KOReader release fingerprint mismatch.')
  const archive = path.join(temporary, name)
  await writeFile(archive, bytes)
  const linux = filename => { const normalized = filename.replaceAll('\\', '/'); return `/mnt/${normalized[0].toLowerCase()}/${normalized.slice(3)}` }
  const copy = path.join(directory, name)
  await writeFile(copy, await readFile(archive))
  try {
    const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--cd', linux(directory), '--exec', `./${name}`, '--appimage-extract'], { windowsHide: true, stdio: 'ignore', timeout: 180000 })
    if (result.error || result.status !== 0) throw new Error('Could not extract KOReader. Ensure Ubuntu is installed and starts successfully in WSL.')
    await writeFile(path.join(directory, 'release.json'), JSON.stringify({ version, archiveSha256: expected, source: 'https://github.com/koreader/koreader/tree/' + version }, null, 2))
    console.log(`KOReader ${version}: installed and verified.`)
  } finally { await rm(copy, { force: true }) }
} finally { await rm(temporary, { recursive: true, force: true }) }
