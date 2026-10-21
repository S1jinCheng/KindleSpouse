import { spawn } from 'node:child_process'
import { createServer } from 'vite'

await import('./build-electron.mjs')
const server = await createServer()
await server.listen()
const electron = spawn(process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/.bin/electron', ['.'], { stdio: 'inherit', env: { ...process.env, KINDLESPOUSE_DEV_URL: 'http://127.0.0.1:5173' } })
electron.on('close', async code => { await server.close(); process.exit(code ?? 0) })
