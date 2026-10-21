import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { AppState, CompanionSetupState } from './shared'
import type { Run } from './ui'

export default function EnhancedSetup({ state, run, name, onReady }: { state: AppState; run: Run; name: string; onReady: (ready: boolean) => void }) {
  const [setup, setSetup] = useState<CompanionSetupState>()
  const [deviceId, setDeviceId] = useState('')
  const [accountId, setAccountId] = useState(state.settings.defaultCloudId ?? '')
  const [working, setWorking] = useState(false)
  const verifying = useRef(false)
  const alive = useRef(true)
  const account = state.clouds.find(cloud => cloud.id === accountId && cloud.connected)
  const busy = working || Boolean(setup && ['checking', 'authorizing', 'preparing', 'installing'].includes(setup.stage))
  const installed = setup?.usbDeviceId === deviceId && setup?.accountId === accountId && Boolean(setup.installedAt)
  const ready = Boolean(installed && setup?.stage === 'ready')
  useEffect(() => { onReady(ready) }, [ready, onReady])
  useEffect(() => {
    if (!deviceId && state.devices.length === 1) setDeviceId(state.devices[0].id)
    if (!accountId) setAccountId(state.clouds.find(cloud => cloud.connected)?.id ?? '')
  }, [state.devices, state.clouds, deviceId, accountId])
  useEffect(() => {
    alive.current = true
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        const result = await window.kindlespouse.companionSetup()
        if (alive.current) {
          setSetup(result)
          if (result.usbDeviceId) setDeviceId(current => current || result.usbDeviceId!)
          if (result.accountId) setAccountId(current => current || result.accountId!)
        }
      } catch {} finally { polling = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    return () => { alive.current = false; clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (setup?.stage !== 'awaiting_device') return
    const verify = async () => {
      if (verifying.current) return
      verifying.current = true
      try { const result = await window.kindlespouse.verifyCompanion(); if (alive.current) setSetup(result) }
      catch {} finally { verifying.current = false }
    }
    void verify()
    const timer = setInterval(() => void verify(), 15000)
    return () => clearInterval(timer)
  }, [setup?.stage])
  const operation = (task: () => Promise<CompanionSetupState>) => run(async () => {
    setWorking(true)
    try { const result = await task(); if (alive.current) setSetup(result) } finally { if (alive.current) setWorking(false) }
  })
  const checked = setup?.usbDeviceId === deviceId && setup.inspection?.readerInstalled
  return <div className="enhanced-setup-flow">
    <section className="enhanced-step"><span className="enhanced-step-number">1</span><div><h3>准备 Kindle 上的 KOReader</h3><p>需要已经越狱的设备和 KOReader v2026.07.1。越狱兼容性还取决于固件；选择型号不能自动判断。没有这些条件时，可以返回使用原生模式。</p><details><summary>如何安装基础 KOReader</summary><p>较新的越狱工具提供 KPM。在 Kindle 首页搜索栏依次输入以下命令，每次等待完成：</p><pre>;kpm update{'\n'};kpm upgrade{'\n'};kpm install koreader</pre><p>KPM 安装的是上游当前版本。请核对为 v2026.07.1；不一致时按官方说明选择该版本的正确设备安装包。没有 KPM 的设备需使用官方对应的手动安装方法。</p><button className="text-button" onClick={() => run(() => window.kindlespouse.openCompanionHelp())}>查看官方设备安装说明</button><button className="text-button" onClick={() => run(() => window.kindlespouse.openCompanionHelp('release'))}>下载配套版本</button></details><p className="field-hint">定制首页、中文字体、同步与休眠封面由下一步统一安装。现阶段自动安装面向 ARMv7 Kindle；更早的机型可先使用原生模式。</p></div></section>
    <section className={`enhanced-step${checked ? ' done' : ''}`}><span className="enhanced-step-number">{checked ? <Check size={14} /> : 2}</span><div><h3>退出 KOReader，连接 USB</h3><p>请先保存并退出设备上的 KOReader，再接线。只检查和安装组件，不会清空书库或笔记。</p><div className="setup-actions"><select aria-label="安装组件的 Kindle" value={deviceId} disabled={busy} onChange={event => setDeviceId(event.target.value)}><option value="">请选择已连接的 Kindle</option>{state.devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}{deviceId && !state.devices.some(device => device.id === deviceId) && <option value={deviceId}>上次设置的 Kindle</option>}</select><button className="button" disabled={busy} onClick={() => run(() => window.kindlespouse.refreshDevices())}>检查 USB 连接</button><button className="button" disabled={busy || !deviceId} onClick={() => operation(() => window.kindlespouse.inspectCompanion(deviceId))}>检查设备组件</button></div>{setup?.inspection && setup.usbDeviceId === deviceId && <p className="field-hint">{checked ? `检测到 ${setup.inspection.readerVersion ?? '未知版本'}${setup.inspection.hasCredential ? ' · 已有网盘授权，将保留' : ''}` : '设备尚未安装 KOReader，请先完成上一步。'}</p>}</div></section>
    <section className={`enhanced-step${installed ? ' done' : ''}`}><span className="enhanced-step-number">{installed ? <Check size={14} /> : 3}</span><div><h3>连接网盘并安装定制组件</h3><p>电脑上传图书到 {state.settings.cloudFolder}，Kindle 从这里自动收书。首次配对会额外打开一次设备专用授权，请选择同一账号。</p><div className="setup-actions"><button className="button" disabled={busy || Boolean(state.cloudConnecting)} onClick={() => run(() => window.kindlespouse.connectCloud('drive'))}>连接 Google Drive</button><button className="button" disabled={busy || Boolean(state.cloudConnecting)} onClick={() => run(() => window.kindlespouse.connectCloud('onedrive'))}>连接 OneDrive</button></div><label className="setup-model-label">用于同步的网盘<select aria-label="设备同步网盘" disabled={busy} value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">请选择已连接的网盘</option>{state.clouds.filter(cloud => cloud.connected).map(cloud => <option key={cloud.id} value={cloud.id}>{cloud.name}</option>)}</select></label><label className="setup-checkbox"><input type="checkbox" checked={Boolean(state.settings.localProfileEnabled)} disabled={busy} onChange={event => run(() => window.kindlespouse.setLocalProfiles(event.target.checked))} />优先通过局域网同步头像与休眠封面</label><p className="field-hint">电脑与 Kindle 需在同一网络；连接失败会回退到网盘。笔记和收书仍通过网盘。</p><div className="setup-actions"><button className="button primary" disabled={busy || !checked || !account} onClick={() => operation(async () => { await window.kindlespouse.saveSettings({ defaultCloudId: accountId }); return window.kindlespouse.installCompanion(deviceId, accountId, name) })}>{busy ? <><LoaderCircle size={15} className="spin" />正在设置…</> : installed ? '重新安装／更新组件' : '授权并自动安装'}</button></div>{setup?.stage === 'installing' && <progress aria-label="组件安装进度" value={setup.files ?? 0} max={setup.total || 1} />}</div></section>
    <section className={`enhanced-step${ready ? ' done' : ''}`}><span className="enhanced-step-number">{ready ? <Check size={14} /> : 4}</span><div><h3>拔线，联网确认</h3><p>{installed ? '现在可以拔掉 USB。让 Kindle 连上 Wi-Fi 并打开 KOReader，保持唤醒，向导会每 15 秒检查一次回执。如果原来暂停过同步，请在 KindleSpouse 菜单选择 Resume sync。' : 'USB 安装校验通过后，再拔线打开 KOReader。向导会验证这次安装与网盘通信成功。'}</p><p role="status" className="enhanced-status">{setup?.message ?? '等待开始检查。'}</p>{setup?.error && <p role="alert" className="setup-error">{setup.error}</p>}<button className="button" disabled={!installed || busy || verifying.current} onClick={() => operation(() => window.kindlespouse.verifyCompanion())}>检查联网结果</button></div></section>
    <details className="enhanced-desktop"><summary>电脑上的 KOReader 试读环境</summary><p>设备连通后即可传书。要在 Windows 预览完全相同的 KOReader 排版，还需 WSL Ubuntu；没有 WSL 时仍可使用 EPUB/PDF 浏览器预览。</p><button className="button" onClick={() => run(() => window.kindlespouse.prepareKoreader(), '电脑 KOReader 已就绪')}>检测并启动电脑阅读器</button><button className="text-button" onClick={() => run(() => window.kindlespouse.openCompanionHelp('wsl'))}>安装 WSL Ubuntu 的官方说明</button></details>
  </div>
}
