import { build } from 'esbuild'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const directory = path.resolve('native/tools/notebook-converter')
await copyFile('native/InspectNotebook.mjs', path.join(directory, 'InspectNotebook.mjs'))
const source = (await readFile('native/InspectNotebook.mjs', 'utf8')).replace(
  './tools/notebook-converter/src/nbk.ts',
  './src/nbk.ts',
)
await writeFile(path.join(directory, 'InspectNotebook.mjs'), source)
await build({
  entryPoints: [path.join(directory, 'InspectNotebook.mjs')],
  outfile: path.join(directory, 'inspect.mjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'external',
})
