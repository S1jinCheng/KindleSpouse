import { spawn } from 'node:child_process'

export function runProcess(
  executable: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    timeout?: number
    input?: string
    onOutput?: (chunk: string) => void
    signal?: AbortSignal
  } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    let output = ''
    let errorOutput = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('操作超时，请检查网络或设备后重试。'))
    }, options.timeout ?? 120000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      options.onOutput?.(chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString()
      options.onOutput?.(chunk.toString())
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0
        ? resolve(output)
        : reject(new Error(errorOutput.trim().slice(-1800) || output.trim().slice(-1800) || `操作失败 (${code})`))
    })
    child.stdin.end(options.input)
  })
}
