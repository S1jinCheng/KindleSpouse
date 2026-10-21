import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronRight, LoaderCircle, Mail, X } from 'lucide-react'
import type { AppState, KindleMailInput } from './shared'
import type { Run } from './ui'
import { KINDLE_MODELS, kindleMode, kindleModel, nativeDelivery } from './kindle-devices'
import './device-setup.css'
import EnhancedSetup from './EnhancedSetup'

export function SetupNotice({ state, run, onSetup }: { state: AppState; run: Run; onSetup: () => void }) {
  const [dismissed, setDismissed] = useState(false)
  const imported = state.initialImport
  if (!state.settings.onboardingComplete) return <section className="setup-notice" aria-label="设备设置提醒"><div><strong>先完成设备设置，再开始传书</strong><p>选择 Kindle 型号与使用方式，配置传书通道。你可以先浏览书库和试读。</p></div><button className="button primary" onClick={onSetup}>继续设置</button></section>
  if (!imported || imported.status === 'complete' && dismissed) return null
  const reading = imported.status === 'reading'
  const complete = imported.status === 'complete'
  return <section className={`setup-notice initial-import ${complete ? 'complete' : ''}`} aria-label="Kindle 首次导入"><div><strong>{reading && <LoaderCircle size={15} className="spin" />}{complete ? '首次导入已完成' : reading ? '正在导入 Kindle 文件' : imported.status === 'failed' ? '首次导入需要检查连接' : '设置已完成 · 等待 Kindle 文件'}</strong><p role="status">{reading ? state.deviceImport?.stage ?? imported.message : imported.message}</p>{reading && <small>{state.deviceImport?.files ?? 0} 份文件 · 已新增 {state.deviceImport?.imported ?? 0} 本书</small>}{complete && <small>新增 {imported.books} 本书 · {imported.notebooks} 本笔记 · {imported.annotations} 条标注{imported.unreadable ? ` · ${imported.unreadable} 份资料暂时无法解析，原件已保留` : ''}</small>}{imported.error && <small className="setup-error">{imported.error}</small>}</div>{complete ? <button className="text-button" aria-label="关闭首次导入提示" onClick={() => setDismissed(true)}><X size={17} /></button> : !reading && <button className="button" onClick={() => run(() => window.kindlespouse.refreshDevices(), '已检查设备连接')}>{imported.status === 'failed' ? '重试导入' : '检查连接'}</button>}</section>
}

export function KindleMailSettings({ state, run }: { state: AppState; run: Run }) {
  const account = state.kindleMail
  const [form, setForm] = useState<KindleMailInput>(() => ({ recipient: account?.recipient ?? '', sender: account?.sender ?? '', host: account?.host ?? 'smtp.gmail.com', port: account?.port ?? 465, security: account?.security ?? 'tls', approvedSender: account?.approvedSender ?? false }))
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const dirty = Boolean(password) || (['recipient', 'sender', 'host', 'port', 'security', 'approvedSender'] as const).some(key => form[key] !== account?.[key])
  const patch = (fields: Partial<KindleMailInput>) => setForm(current => ({ ...current, ...fields }))
  const operation = (task: () => Promise<unknown>, message?: string) => run(async () => { setWorking(true); try { return await task() } finally { setWorking(false) } }, message)
  return <div className="kindle-mail-settings">
    <div className="setup-intro"><Mail size={22} /><div><h3>Send to Kindle</h3><p>试读后发送原文件，由 Amazon 转换并投递到你的 Kindle。</p></div></div>
    <form onSubmit={event => { event.preventDefault(); operation(async () => { await window.kindlespouse.saveKindleMail({ ...form, password: password || undefined }); setPassword(''); await window.kindlespouse.verifyKindleMail() }, '发件邮箱连接测试通过') }}>
      <div className="setup-form-grid">
        <label>Kindle 收件邮箱<input required type="email" aria-label="Kindle 收件邮箱" placeholder="name@kindle.com" value={form.recipient} onChange={event => patch({ recipient: event.target.value })} /></label>
        <label>发件邮箱<input required type="email" aria-label="发件邮箱" placeholder="你的个人邮箱" value={form.sender} onChange={event => patch({ sender: event.target.value })} /></label>
        <label>邮件服务<select aria-label="邮件服务" value={['smtp.gmail.com', 'smtp.qq.com', 'smtp.163.com'].includes(form.host) ? form.host : 'custom'} onChange={event => patch({ host: event.target.value === 'custom' ? '' : event.target.value, port: 465, security: 'tls' })}><option value="smtp.gmail.com">Gmail</option><option value="smtp.qq.com">QQ 邮箱</option><option value="smtp.163.com">网易 163</option><option value="custom">自定义 SMTP</option></select></label>
        <label>SMTP 授权码／应用专用密码<input type="password" aria-label="邮件授权码" autoComplete="new-password" required={!account?.hasPassword} value={password} placeholder={account?.hasPassword ? '已加密保存；留空保留' : '由邮箱服务商生成'} onChange={event => setPassword(event.target.value)} /></label>
        <details className="setup-smtp-details" open={!['smtp.gmail.com', 'smtp.qq.com', 'smtp.163.com'].includes(form.host)}><summary>邮件服务器设置</summary><div className="setup-form-grid"><label>SMTP 服务器<input required aria-label="SMTP 服务器" value={form.host} placeholder="smtp.example.com" onChange={event => patch({ host: event.target.value })} /></label><label>加密连接<select aria-label="邮件加密连接" value={form.port} onChange={event => patch({ port: Number(event.target.value), security: event.target.value === '465' ? 'tls' : 'starttls' })}><option value={465}>TLS · 465</option><option value={587}>STARTTLS · 587</option></select></label></div></details>
      </div>
      <p className="field-hint">Kindle 邮箱在设备的「Your Account → Send-to-Kindle Email」查看。发件邮箱需开启 SMTP；部分账号需要先开启两步验证才能生成应用专用密码。</p>
      <div className="setup-help-links"><button type="button" className="text-button" onClick={() => run(() => window.kindlespouse.openKindleHelp('email'))}>查找 Kindle 邮箱</button><button type="button" className="text-button" onClick={() => run(() => window.kindlespouse.openKindleHelp('approved'))}>设置 Amazon 认可发件地址</button></div>
      <label className="setup-checkbox"><input type="checkbox" checked={form.approvedSender} onChange={event => patch({ approvedSender: event.target.checked })} />我已将上面的发件邮箱加入 Amazon 的认可发件地址列表</label>
      <div className="setup-actions"><button className="button primary" disabled={working}>{working ? '正在连接…' : '保存并测试连接'}</button><button type="button" className="button" disabled={working || dirty || !account?.configured} onClick={() => operation(() => window.kindlespouse.sendKindleTest(), '测试文档已交给邮件服务，请在 Kindle 确认收书')}>发送测试文档</button></div>
    </form>
    <p className={`setup-connection-status${account?.configured && !dirty ? ' connected' : ''}`}>{dirty ? '有尚未保存的设置' : account?.configured ? '发件连接已验证 · 已确认认可发件地址' : account?.verifiedAt ? '连接已验证，请确认认可发件地址后再次保存' : '尚未完成邮件连接测试'}{account?.testSubmittedAt && !dirty && ' · 测试已提交，设备收书仍需本人确认'}</p>
    <p className="field-hint">授权码仅保存在当前 Windows 用户的加密凭据区，不上传网盘。连接测试只验证邮件服务；Amazon 可能要求额外确认，邮件已提交不代表设备已收到。邮件附件目前限 25 MiB。</p>
    <div className="setup-help-links"><button className="text-button" onClick={() => run(() => window.kindlespouse.openKindleHelp('web'))}>打开官方网页上传</button>{account && <button className="text-button" disabled={working} onClick={() => operation(async () => { await window.kindlespouse.clearKindleMail(); setPassword('') }, '已移除本机邮件凭据')}>移除邮件连接</button>}</div>
  </div>
}

export function DeviceSettings({ state, onSetup }: { state: AppState; onSetup: () => void }) {
  const model = kindleModel(state.settings.deviceModel), mode = kindleMode(state.settings)
  return <section className="card settings-section device-mode-summary"><div className="section-heading"><div><h2>我的 Kindle</h2><p>{state.settings.deviceModel ? model.name : '尚未选择型号'} · {mode === 'native' ? '原生模式' : 'KOReader 增强模式'}</p></div><button className="button" onClick={onSetup}>选择设备与使用方式</button></div><p className="field-hint">{mode === 'koreader' ? '通过配套插件自动收书、同步笔记与阅读记录。设备需已越狱并安装 KOReader。' : model.nativeCloud ? '支持 Send to Kindle。此型号也支持官方网盘手动导入与导出，不会自动同步。具体以设备 Connections 菜单及账号支持为准。' : '通过 Send to Kindle 无线传书；此型号未确认支持官方网盘直连，网盘仍可用作电脑端书库。'}</p></section>
}

function NativeConnection({ state, run, model, delivery, onChange }: { state: AppState; run: Run; model: string; delivery: 'kindle-email' | 'native-cloud'; onChange: (method: 'kindle-email' | 'native-cloud') => void }) {
  return <>{kindleModel(model).nativeCloud && <label className="setup-model-label">原生传书方式<select aria-label="原生传书方式" value={delivery} onChange={event => onChange(event.target.value as 'kindle-email' | 'native-cloud')}><option value="kindle-email">Send to Kindle · 邮件自动投递</option><option value="native-cloud">官方网盘 · 在 Kindle 手动导入</option></select></label>}{delivery === 'kindle-email' ? <KindleMailSettings state={state} run={run} /> : <div className="setup-capability"><strong>连接网盘后，从设备手动导入</strong><p>电脑上传到 {state.settings.cloudFolder}。请在 Kindle 的 Connections 中连接同一个网盘账号，再手动导入文件；这条路径没有自动收书和设备回执。</p><div className="setup-actions"><button className="button" disabled={Boolean(state.cloudConnecting)} onClick={() => run(() => window.kindlespouse.connectCloud('drive'))}>连接 Google Drive</button><button className="button" disabled={Boolean(state.cloudConnecting)} onClick={() => run(() => window.kindlespouse.connectCloud('onedrive'))}>连接 OneDrive</button><button className="text-button" onClick={() => run(() => window.kindlespouse.openKindleHelp('connections'))}>打开 Kindle Connections</button></div><label className="setup-model-label">默认网盘<select aria-label="原生模式默认网盘" value={state.settings.defaultCloudId ?? state.clouds.find(cloud => cloud.connected)?.id ?? ''} onChange={event => run(() => window.kindlespouse.saveSettings({ defaultCloudId: event.target.value }))}>{!state.clouds.some(cloud => cloud.connected) && <option value="">请先连接网盘</option>}{state.clouds.filter(cloud => cloud.connected).map(cloud => <option key={cloud.id} value={cloud.id}>{cloud.name}</option>)}</select></label></div>}</>
}

export default function DeviceSetup({ state, run, onClose }: { state: AppState; run: Run; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab' || !element) return
      const items = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')].filter(item => item.getClientRects().length)
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    element?.querySelector<HTMLElement>('select, button')?.focus()
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  const [step, setStep] = useState(0)
  const [model, setModel] = useState(state.settings.deviceModel ?? '')
  const [mode, setMode] = useState<'native' | 'koreader'>(state.settings.kindleMode ?? 'native')
  const [deliveryChoice, setDeliveryChoice] = useState<'kindle-email' | 'native-cloud'>(nativeDelivery(state.settings))
  const [working, setWorking] = useState(false)
  const selected = kindleModel(model)
  const [enhancedReady, setEnhancedReady] = useState(false)
  const delivery = selected.nativeCloud ? deliveryChoice : 'kindle-email'
  const account = state.clouds.find(cloud => cloud.id === state.settings.defaultCloudId && cloud.connected) ?? state.clouds.find(cloud => cloud.connected)
  const saveStep = () => run(async () => { setWorking(true); try { await window.kindlespouse.saveSettings({ deviceModel: model, kindleMode: mode, nativeDelivery: delivery }); setStep(2) } finally { setWorking(false) } })
  const finish = () => run(async () => { setWorking(true); try { await window.kindlespouse.saveSettings({ deviceModel: model, kindleMode: mode, nativeDelivery: delivery, ...(mode === 'native' && delivery === 'native-cloud' && account ? { defaultCloudId: account.id } : {}), onboardingComplete: true }); onClose() } finally { setWorking(false) } }, mode === 'koreader' ? '两端已连通，设备文件将按同步结果更新' : '设备设置已保存，将自动导入已连接 Kindle 的文件')
  return <div className="device-setup-backdrop"><section ref={dialog} className="device-setup-dialog" role="dialog" aria-modal="true" aria-label="Kindle 首次使用向导">
    <header className="setup-header"><span>KindleSpouse · 开始阅读</span><button className="icon-button" aria-label="稍后设置设备" onClick={onClose}><X size={20} /></button></header>
    <ol className="setup-steps">{['你的 Kindle', '阅读方式', '连接与发送'].map((name, index) => <li key={name} className={index === step ? 'active' : index < step ? 'done' : ''}><span>{index < step ? <Check size={13} /> : index + 1}</span>{name}</li>)}</ol>
    <div className="setup-content">
      {step === 0 ? <><h1>你正在使用哪一款 Kindle？</h1><p className="setup-lead">按型号显示可用的传书方式，之后随时可以在设置中更改。</p><label className="setup-model-label">设备型号<select aria-label="设备型号" value={model} onChange={event => setModel(event.target.value)}><option value="" disabled>请选择你的型号</option>{KINDLE_MODELS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{model && <div className="setup-capability"><strong>{selected.nativeCloud ? '支持官方网盘连接' : '原生无线传书使用 Send to Kindle'}</strong><p>{selected.nativeCloud ? '可在设备 Connections 中连接 Google Drive 或 OneDrive，手动导入图书和导出 PDF。是否可用仍以设备菜单、固件及账号为准，不等于自动收书。' : '此型号未确认支持官方网盘直连。电脑端仍能管理网盘；安装 KOReader 后可使用我们的自动同步。'}</p></div>}</> : step === 1 ? <><h1>你想怎样使用 Kindle？</h1><p className="setup-lead">{selected.name} · 选择与你设备当前状态相符的方式。</p><div className="setup-mode-options"><button className={`setup-mode-option${mode === 'native' ? ' selected' : ''}`} aria-pressed={mode === 'native'} onClick={() => setMode('native')}><strong>Kindle 原生模式 <small>无需越狱</small></strong><span>保留原生阅读体验。电脑找书和试读，再通过 Send to Kindle 发送。</span><span>EPUB/PDF 试读无需 WSL；不提供自动阅读统计、标注写回或自定义休眠封面。</span></button><button className={`setup-mode-option${mode === 'koreader' ? ' selected' : ''}`} aria-pressed={mode === 'koreader'} onClick={() => setMode('koreader')}><strong>KOReader 增强模式 <small>已有 KOReader</small></strong><span>保留自动网盘收书、笔记与标注同步、真实阅读记录和个性化休眠封面。</span><span>需要兼容且已越狱的设备。电脑原生排版试读需要 WSL Ubuntu；选择型号不会自动越狱。</span></button></div></> : <><h1>{mode === 'native' ? '设置你的传书方式' : '连接你的 KOReader'}</h1><p className="setup-lead">{mode === 'native' ? '首次配置完成后，从试读结果直接发送；官方网盘路径需要在设备手动导入。' : '按顺序检查设备、连接网盘、自动安装组件，并确认两端连通。'}</p>{mode === 'native' ? <NativeConnection state={state} run={run} model={model} delivery={delivery} onChange={setDeliveryChoice} /> : <EnhancedSetup state={state} run={run} name={selected.name} onReady={setEnhancedReady} />}</>}
    </div>
    <footer className="setup-footer"><button className="text-button" onClick={() => step > 0 ? setStep(step - 1) : onClose()}><ArrowLeft size={16} />{step ? '上一步' : '稍后设置'}</button>{step === 0 ? <button className="button primary" disabled={!model} onClick={() => setStep(1)}>继续<ChevronRight size={16} /></button> : step === 1 ? <button className="button primary" disabled={working} onClick={saveStep}>继续<ChevronRight size={16} /></button> : <button className="button primary" disabled={working || mode === 'koreader' && !enhancedReady || mode === 'native' && (delivery === 'native-cloud' ? !account?.connected : !state.kindleMail?.configured)} onClick={finish}>完成设置<Check size={16} /></button>}</footer>
  </section></div>
}
