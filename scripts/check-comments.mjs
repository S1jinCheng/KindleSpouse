import { parse } from '@babel/parser'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseLua } from 'luaparse'

const roots = ['src', 'electron', 'scripts', 'native', 'tests', 'experiments', 'vite.config.ts', 'index.html']
const violations = new Set()
async function inspect(filename) {
  const entries = await readdir(filename, { withFileTypes: true }).catch(() => undefined)
  if (entries) {
    for (const entry of entries) if (entry.name !== 'tools') await inspect(path.join(filename, entry.name))
    return
  }
  const extension = path.extname(filename)
  const text = await readFile(filename, 'utf8')
  if (/\.([mc]?tsx?|m?js|cjs)$/.test(filename)) {
    const source = parse(text, { sourceType: 'module', plugins: filename.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] })
    if (source.comments?.length) violations.add(filename)
  } else if (extension === '.lua') { if (parseLua(text).comments?.length) violations.add(filename) }
  else if (extension === '.css' && /\/\*/.test(text) || extension === '.html' && /<!--/.test(text) || ['.py', '.ps1', '.cs', '.go'].includes(extension) && /^\s*(#|\/\/|\/\*)/m.test(text)) violations.add(filename)
}
for (const root of roots) await inspect(root)
if (violations.size) { console.error([...violations].join('\n')); process.exitCode = 1 }
else console.log('Authored source contains no comments.')
