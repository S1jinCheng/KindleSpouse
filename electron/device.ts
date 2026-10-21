import path from 'node:path'
import { runProcess } from './process'
import type { CompanionInspection, DeviceInfo } from '../src/shared'

export class DeviceBridge {
  constructor(private nativeDirectory: string) {}

  private async request(payload: Record<string, unknown>, progress?: (files: number, total: number) => void) {
    if (process.platform !== 'win32') throw new Error('这一版 USB 连接目前支持 Windows。')
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    let pending = ''
    const output = await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(this.nativeDirectory, 'DeviceBridge.ps1'),
        '-Request',
        encoded,
      ],
      { timeout: String(payload.action).startsWith('export') || payload.action === 'install-companion' ? 1200000 : 180000,
        onOutput: chunk => {
          pending += chunk
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const line of lines) {
            try { const value = JSON.parse(line); if (Number.isInteger(value.progress) && Number.isInteger(value.total)) progress?.(value.progress, value.total) } catch {}
          }
        },
      },
    )
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1)!)
    if (result.error) throw new Error(result.error)
    return result
  }

  async list(): Promise<DeviceInfo[]> {
    const result = await this.request({ action: 'list' })
    return result.devices ?? []
  }

  async inspectCompanion(deviceId: string): Promise<CompanionInspection> {
    return this.request({ action: 'inspect-companion', deviceId })
  }

  async installCompanion(deviceId: string, directory: string, manifest: string, backup: string, progress?: (files: number, total: number) => void) {
    return this.request({ action: 'install-companion', deviceId, directory, manifest, backup }, progress) as Promise<{ verified: boolean; files: number }>
  }

  async upload(deviceId: string, source: string, filename: string, sha256: string) {
    await this.request({ action: 'upload', deviceId, source, filename, sha256 })
  }

  async export(deviceId: string, destination: string): Promise<{ files: number; directory: string }> {
    return this.request({ action: 'export', deviceId, destination })
  }

  async exportNotes(deviceId: string, destination: string): Promise<{ files: number; directory: string }> {
    return this.request({ action: 'export-notes', deviceId, destination })
  }

  async exportTitles(deviceId: string, destination: string): Promise<{ files: number; directory: string }> {
    return this.request({ action: 'export-titles', deviceId, destination })
  }
}
