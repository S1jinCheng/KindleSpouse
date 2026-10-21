import { Download, Wifi } from 'lucide-react'
import type { AppState } from './shared'
import type { Run } from './ui'

export default function LocalProfileSettings({ state, run }: { state: AppState; run: Run }) {
  const enabled = Boolean(state.localProfiles?.enabled)
  const devices = state.sync.devices.filter(device => device.status !== 'revoked')
  return <section className="card settings-section local-profile-settings">
    <div className="section-heading"><div><h2>头像与封面直连</h2><p>局域网优先，网盘备用。</p></div><button className="button" onClick={() => run(() => window.kindlespouse.setLocalProfiles(!enabled))}><Wifi size={15} />{enabled ? '关闭直连' : '启用直连'}</button></div>
    <p>电脑与 Kindle 连接同一网络，保持此应用开启。在 KindleSpouse 菜单选择 <strong>Sync profile now</strong>，只更新头像、昵称和休眠封面设置。</p>
    <p className="field-hint">直连失败时自动使用网盘；照片不需要等待书籍与笔记备份。</p>
    {state.localProfiles?.error && <p className="error-text">{state.localProfiles.error}</p>}
    {enabled && <div className="local-profile-pairing"><span className="field-hint">首次使用需安装直连配置与新版设备组件，原有网盘授权保留。</span>{devices.map(device => <button className="button" key={device.id} onClick={() => run(() => window.kindlespouse.exportLocalProfilePairing(device.id))}><Download size={15} />保存 {device.name} 连接包</button>)}{!devices.length && <p className="field-hint">先在设备页面配对 Kindle。</p>}</div>}
  </section>
}
