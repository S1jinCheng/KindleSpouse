import type { AppState } from './shared'
import type { Run } from './ui'

export default function ProfileSyncStatus({ state, run }: { state: AppState; run: Run }) {
  const account = state.settings.defaultCloudId ?? state.clouds[0]?.id
  const devices = state.sync.devices.filter(device => device.status !== 'revoked' && device.accountId === account)
  if (!devices.length) return <span className="profile-sync-status">资料已保存在这台电脑</span>
  const preferences = state.sync.preferences
  const received = Boolean(preferences?.revision) && devices.every(device => device.profileRevision === preferences?.revision)
  const local = received && devices.every(device => device.profileRoute === 'lan')
  const photoUpdate = state.settings.avatarImage && devices.some(device => (device.profileVersion ?? 1) < 2)
  return <div className="profile-sync-status" role="status">
    <span>{received ? local ? 'Kindle 已通过局域网收到资料' : 'Kindle 已收到这份资料' : preferences?.state === 'pending' ? state.localProfiles?.enabled ? '资料已保存，可通过局域网同步' : '资料已保存，等待上传网盘' : preferences?.state === 'uploading' ? state.localProfiles?.enabled ? '直连资料已就绪，正在准备网盘备用副本…' : '正在上传个人资料…' : preferences?.state === 'error' ? preferences.error : preferences?.state === 'uploaded' ? '已上传网盘，Kindle 下次同步时接收' : '资料修改后会自动上传网盘'}</span>
    {preferences?.state === 'error' && <button className="text-button" onClick={() => run(() => window.kindlespouse.publishPreferences())}>重试上传</button>}
    {photoUpdate && <span className="profile-component-hint">照片头像需要先更新一次 Kindle 组件。</span>}
  </div>
}
