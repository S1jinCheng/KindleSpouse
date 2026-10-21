import { useState } from 'react'
import { Cloud, FolderOpen, Plus, RefreshCw, Usb, Wifi } from 'lucide-react'
import SourceStatus, { SourceAccountStatus } from './SourceStatus'
import type { AppState, PreviewProfile } from './shared'
import type { Run } from './ui'
import SleepCoverSettings from './SleepCoverSettings'
import LocalProfileSettings from './LocalProfileSettings'
import { DeviceSettings, KindleMailSettings } from './DeviceSetup'

export function ProfileControls({
  profile,
  onChange,
}: {
  profile: PreviewProfile
  onChange: (profile: PreviewProfile) => void
}) {
  return (
    <div className="profile-controls">
      <label>
        字体
        <select
          aria-label="阅读字体"
          value={profile.font}
          onChange={(event) => onChange({ ...profile, font: event.target.value as PreviewProfile['font'] })}
        >
          <option value="song">宋体</option>
          <option value="serif">衬线</option>
          <option value="sans">无衬线</option>
        </select>
      </label>
      <label>
        字号<span>{profile.fontSize}</span>
        <input
          aria-label="预览字号"
          type="range"
          min="12"
          max="30"
          value={profile.fontSize}
          onChange={(event) => onChange({ ...profile, fontSize: Number(event.target.value) })}
        />
      </label>
      <label>
        行距<span>{profile.lineHeight.toFixed(2)}</span>
        <input
          aria-label="预览行距"
          type="range"
          min="1.2"
          max="2.4"
          step=".05"
          value={profile.lineHeight}
          onChange={(event) => onChange({ ...profile, lineHeight: Number(event.target.value) })}
        />
      </label>
      <label>
        边距<span>{profile.margin}</span>
        <input
          aria-label="预览边距"
          type="range"
          min="8"
          max="40"
          value={profile.margin}
          onChange={(event) => onChange({ ...profile, margin: Number(event.target.value) })}
        />
      </label>
      <label>
        纸张
        <select
          value={profile.paper}
          onChange={(event) => onChange({ ...profile, paper: event.target.value as PreviewProfile['paper'] })}
        >
          <option value="warm">暖白</option>
          <option value="white">纯白</option>
        </select>
      </label>
    </div>
  )
}
export default function SettingsPanel({ state, run, readingBookId, onSetup }: { state: AppState; run: Run; readingBookId?: string; onSetup: () => void }) {
  const [source, setSource] = useState(state.settings.sourceUrl)
  const [folder, setFolder] = useState(state.settings.cloudFolder)
  const nativeMode = state.settings.kindleMode === 'native'
  return (
    <div className="page-stack settings-page">
      <header className="page-heading">
        <div>
          <h1>设置与设备</h1>
        </div>
      </header>
      <DeviceSettings state={state} onSetup={onSetup} />
      {nativeMode && <section className="card settings-section"><KindleMailSettings state={state} run={run} /></section>}
      <section className="card settings-section"><h2>应用外观</h2><p>标题和书名采用 Noto Serif SC 宋体，菜单与操作采用 Noto Sans SC 黑体。KOReader 沿用设备同步的书内字体与排版。</p></section>
      <section className="card settings-section"><h2>电脑阅读器</h2>{nativeMode ? <p>使用无需 WSL 的电脑预览。Amazon 转换后可能改变字体、换行和分页，预览仅供参考。</p> : <><label>预览方式<select aria-label="预览方式" value={state.settings.readerEngine ?? 'koreader'} onChange={event => run(() => window.kindlespouse.saveSettings({ readerEngine: event.target.value as 'koreader' | 'browser' }))}><option value="koreader">KOReader 原生排版</option><option value="browser">浏览器近似预览</option></select></label><p className="field-hint">KOReader 模式使用与设备同版的阅读器，需要 WSL Ubuntu。浏览器预览不保证相同的换行与分页。</p></>}</section>
      {!nativeMode && <SleepCoverSettings state={state} run={run} readingBookId={readingBookId} />}
      {!nativeMode && <LocalProfileSettings state={state} run={run} />}
      <section className="card settings-section">
        <h2>默认网盘</h2>
        {!nativeMode && <><label><input type="checkbox" checked={state.settings.autoCloudSync !== false} onChange={event => run(() => window.kindlespouse.saveSettings({ autoCloudSync: event.target.checked }))} /> 自动更新笔记、标注与阅读记录</label><p className="field-hint">应用打开时每分钟检查网盘更新，并发送待处理的标注修改。Kindle 开启自动同步后，有变化才上传；休眠不唤醒，联网后继续。</p></>}
        <div className="settings-form">
          <label>
            发送到
            <select
              aria-label="默认网盘"
              value={state.settings.defaultCloudId ?? state.clouds[0]?.id ?? ''}
              onChange={(event) => run(() => window.kindlespouse.saveSettings({ defaultCloudId: event.target.value }))}
            >
              {!state.clouds.length && <option value="">尚未连接</option>}
              {state.clouds.map((cloud) => (
                <option key={cloud.id} value={cloud.id}>
                  {cloud.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button"
            disabled={Boolean(state.cloudConnecting)}
            onClick={() => run(() => window.kindlespouse.connectCloud('drive'))}
          >
            <Plus size={15} />
            Google Drive
          </button>
          <button
            className="button"
            disabled={Boolean(state.cloudConnecting)}
            onClick={() => run(() => window.kindlespouse.connectCloud('onedrive'))}
          >
            <Plus size={15} />
            OneDrive
          </button>
        </div>
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            run(() => window.kindlespouse.saveSettings({ cloudFolder: folder }), '传书目录已保存')
          }}
        >
          <label>
            Kindle 书籍目录
            <input aria-label="网盘传书目录" value={folder} onChange={(event) => setFolder(event.target.value)} />
          </label>
          <button className="button">保存目录</button>
        </form>
        <p className="field-hint">{nativeMode ? '网盘用于电脑书库和文件管理。支持官方网盘的 Scribe 需要在设备 Connections 中手动导入，其他型号使用 Send to Kindle。' : '默认专用书籍目录：KindleSpouse / Inbox。应用会自动创建，Kindle 自动补收缺少的书。笔记与回执使用独立的 KindleSpouse / Sync 目录。'}</p>
      </section>
      <section className="card settings-section">
        <div className="section-heading">
          <h2>设备</h2>
          <button
            className="icon-button"
            aria-label="刷新设备"
            onClick={() => run(() => window.kindlespouse.refreshDevices())}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {state.devices.map((device) => (
          <div className="device-row" key={device.id}>
            <Usb size={20} />
            <strong>{device.name}</strong>
            <span>USB 可访问</span>
          </div>
        ))}
        {!state.devices.length && <p className="field-hint">{nativeMode ? '当前没有 USB 设备。原生无线传书使用上方的 Kindle 邮箱。' : '当前没有 USB 设备。已配对的设备可以通过网盘同步。'}</p>}
        <button className="button" onClick={() => run(() => window.kindlespouse.importDevice(), '设备书库已读取')}>
          <Usb size={16} />
          读取设备书库
        </button>
        <p className="field-hint">{nativeMode ? '通过 USB 读取可访问的书籍与资料；原生笔记的完整标题和格式支持受设备开放范围限制。' : '日常笔记同步请使用网盘。USB 读取作为备份入口，需先保存并退出 KOReader。'}</p>
      </section>
      <section className="card settings-section">
        <h2>书源</h2>
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault()
            run(() => window.kindlespouse.saveSettings({ sourceUrl: source }))
          }}
        >
          <label>
            自定义入口
            <input aria-label="书源网址" value={source} onChange={(event) => setSource(event.target.value)} />
          </label>
          <button className="button">保存</button>
          <button className="button" type="button" onClick={() => run(() => window.kindlespouse.openSource())}>
            连接并登录
          </button>
        </form>
        <SourceAccountStatus account={state.sourceAccount} onCheck={() => run(() => window.kindlespouse.checkSourceSession())} />
        <SourceStatus health={state.sourceHealth} onRefresh={() => run(() => window.kindlespouse.checkSources())} />
      </section>
      <section className="card settings-section enhanced-opds" hidden={nativeMode}>
        <div className="section-heading">
          <h2>无线书目 OPDS</h2>
          <button
            className="button"
            onClick={() =>
              run(() => (state.opds ? window.kindlespouse.disableOpds() : window.kindlespouse.enableOpds()))
            }
          >
            <Wifi size={16} />
            {state.opds ? '关闭' : '开启'}
          </button>
        </div>
        {state.opds ? (
          <div className="opds-credentials">
            <label>
              地址<code>{state.opds.address}</code>
            </label>
            <label>
              用户名<code>{state.opds.username}</code>
            </label>
            <label>
              专用密码<code>{state.opds.password}</code>
            </label>
          </div>
        ) : (
          <p className="field-hint">可选的局域网取书方式，使用时电脑需要运行。</p>
        )}
      </section>
      <section className="card settings-section">
        <div className="section-heading">
          <div>
            <h2>Calibre</h2>
            <p>{state.tools.calibre ? '书库引擎已就绪' : '尚未配置'}</p>
          </div>
          <button className="button" onClick={() => run(() => window.kindlespouse.chooseCalibre())}>
            <FolderOpen size={16} />
            选择程序目录
          </button>
        </div>
        <p className="settings-path">{state.settings.calibreDirectory}</p>
      </section>
      <section className="card settings-section">
        <div className="section-heading">
          <div>
            <h2>本机数据</h2>
            <p>书籍、笔记和账号均保存在当前用户目录。</p>
          </div>
          <button className="button" onClick={() => run(() => window.kindlespouse.openDataFolder())}>
            <FolderOpen size={16} />
            打开目录
          </button>
        </div>
        <button
          className="button"
          disabled={state.recovery?.working}
          onClick={() => run(() => window.kindlespouse.recoverLibrary(), '书库索引已恢复')}
        >
          <RefreshCw size={16} />
          恢复书库索引
        </button>
      </section>
    </div>
  )
}
