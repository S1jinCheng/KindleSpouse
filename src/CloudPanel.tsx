import { useEffect, useState } from 'react'
import {
  ChevronRight,
  Cloud,
  Download,
  Edit3,
  Folder,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { AppState, CloudEntry, CloudMutation } from './shared'
import { isKoreaderFilename } from './book-formats'
import { bytesLabel, Empty, type Run } from './ui'
import { kindleMode, kindleModel } from './kindle-devices'

export default function CloudPanel({
  state,
  run,
  onOpen,
}: {
  state: AppState
  run: Run
  onOpen: (id: string) => void
}) {
  const [accountId, setAccountId] = useState(state.settings.defaultCloudId ?? state.clouds[0]?.id ?? '')
  const [folder, setFolder] = useState(''),
    [entries, setEntries] = useState<CloudEntry[]>([]),
    [loading, setLoading] = useState(false),
    [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<CloudEntry>(),
    [action, setAction] = useState<CloudMutation['action'] | 'edit'>(),
    [value, setValue] = useState(''),
    [text, setText] = useState(''),
    [hash, setHash] = useState('')
  const account = state.clouds.find((item) => item.id === accountId)
  const native = kindleMode(state.settings) === 'native'
  useEffect(() => {
    if (!accountId && state.clouds[0]) setAccountId(state.clouds[0].id)
  }, [accountId, state.clouds])
  const list = async (target = folder) => {
    setLoading(true)
    try {
      const items = await window.kindlespouse.listCloud(accountId, target)
      setEntries(items)
      setFolder(target)
      setLoaded(true)
    } finally {
      setLoading(false)
    }
  }
  const close = () => {
    setSelected(undefined)
    setAction(undefined)
    setValue('')
    setText('')
    setHash('')
  }
  const mutation = async () => {
    if (!action) return
    await window.kindlespouse.cloudMutate(accountId, {
      action: action === 'edit' ? 'write' : action,
      path: action === 'mkdir' ? [folder, value].filter(Boolean).join('/') : selected!.path,
      destination: action === 'move' ? value : undefined,
      text: action === 'edit' ? text : undefined,
      expectedHash: hash || undefined,
    })
    close()
    await list()
  }
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <h1>网盘</h1>
          <p>管理文件、收发书籍与笔记</p>
        </div>
        <div className="button-group">
          <button
            className="button"
            disabled={Boolean(state.cloudConnecting || state.sync.pairing)}
            onClick={() => run(() => window.kindlespouse.connectCloud('drive'))}
          >
            <Plus size={15} />
            Google Drive
          </button>
          <button
            className="button"
            disabled={Boolean(state.cloudConnecting || state.sync.pairing)}
            onClick={() => run(() => window.kindlespouse.connectCloud('onedrive'))}
          >
            <Plus size={15} />
            OneDrive
          </button>
        </div>
      </header>
      {state.cloudConnecting && (
        <p className="status-line">
          <LoaderCircle className="spin" size={15} />
          请在浏览器完成授权，成功后自动返回。
        </p>
      )}
      {state.sync.pairing && (
        <p className="status-line">
          <LoaderCircle className="spin" size={15} />
          请在新打开的浏览器页面完成设备专用授权，使用同一个网盘账号。可等待 30 分钟；完成后安装包自动保存到“文档”，并打开所在文件夹。
        </p>
      )}
      {state.clouds.length ? (
        <>
          <div className="cloud-toolbar">
            <select
              aria-label="选择网盘账号"
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value)
                setFolder('')
                setEntries([])
                setLoaded(false)
              }}
            >
              {state.clouds.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.connected ? '' : ' · 需检查授权'}
                </option>
              ))}
            </select>
            <button
              className="button"
              disabled={loading}
              onClick={() =>
                run(async () => {
                  await window.kindlespouse.checkCloud(accountId)
                  await list()
                })
              }
            >
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
              读取目录
            </button>
            <div className="toolbar-spacer" />
            <button
              className="button"
              onClick={() => {
                setAction('mkdir')
                setValue('')
              }}
            >
              <FolderPlus size={16} />
              新建文件夹
            </button>
            <button
              className="button"
              onClick={() =>
                run(async () => {
                  await window.kindlespouse.cloudUpload(accountId, folder)
                  await list()
                })
              }
            >
              <Upload size={16} />
              上传文件到网盘
            </button>
          </div>
          <nav className="cloud-breadcrumb" aria-label="网盘路径">
            <button onClick={() => run(() => list(''))}>全部文件</button>
            {folder
              .split('/')
              .filter(Boolean)
              .map((part, index, parts) => (
                <span key={index}>
                  <ChevronRight size={13} />
                  <button onClick={() => run(() => list(parts.slice(0, index + 1).join('/')))}>{part}</button>
                </span>
              ))}
          </nav>
          {account?.error && <p className="error-text">{account.error}</p>}
          <section className="cloud-table card">
            <div className="cloud-table-heading">
              <span>名称</span>
              <span>大小</span>
              <span>操作</span>
            </div>
            {entries.map((entry) => (
              <div className="cloud-file-row" key={entry.path}>
                <button
                  className="cloud-file-name"
                  onClick={() =>
                    entry.isDir
                      ? run(() => list(entry.path))
                      : isKoreaderFilename(entry.path)
                        ? run(async () => onOpen(await window.kindlespouse.downloadCloud(accountId, entry.path)))
                        : /\.(txt|md|markdown|csv|json)$/i.test(entry.path)
                          ? run(async () => {
                              const value = await window.kindlespouse.cloudReadText(accountId, entry.path)
                              setSelected(entry)
                              setText(value.text)
                              setHash(value.hash)
                              setAction('edit')
                            })
                          : setSelected(entry)
                  }
                >
                  {entry.isDir ? <Folder size={20} /> : <Cloud size={20} />}
                  <span>{entry.name}</span>
                </button>
                <small>{entry.isDir ? '文件夹' : bytesLabel(entry.size)}</small>
                <div className="button-group">
                  {!entry.isDir && (
                    <button
                      className="icon-button"
                      aria-label={`下载 ${entry.name}`}
                      onClick={() => run(() => window.kindlespouse.cloudSaveFile(accountId, entry.path))}
                    >
                      <Download size={16} />
                    </button>
                  )}
                  <button className="icon-button" aria-label={`管理 ${entry.name}`} onClick={() => setSelected(entry)}>
                    <MoreHorizontal size={18} />
                  </button>
                </div>
              </div>
            ))}
            {loaded && !entries.length && <Empty title="这个文件夹是空的" />}
            {!loaded && <Empty title="选择账号，读取网盘目录">应用会在你打开目录时检查连接。</Empty>}
          </section>
          {native ? <section className="card connection-summary"><div><h2>原生 Kindle 与网盘</h2><p>{kindleModel(state.settings.deviceModel).nativeCloud ? '此型号支持官方网盘手动导入与导出' : '当前型号使用 Send to Kindle 无线传书'}</p><small>这里管理的是电脑连接的网盘。上传文件不会自动触发原生 Kindle 收书，也不会同步原生阅读时长。支持的设备需在 Connections 中授权并手动导入。</small></div>{kindleModel(state.settings.deviceModel).nativeCloud && <button className="button" onClick={() => run(() => window.kindlespouse.openKindleHelp('connections'))}>打开 Kindle Connections</button>}</section> : <><section className="card connection-summary">
            <div>
              <h2>Kindle 与网盘</h2>
              <p>
                {state.sync.devices.filter((device) => device.status === 'connected').length
                  ? '已收到 Kindle 的网盘备份'
                  : '需要为 Kindle 安装专用配套组件'}
              </p>
              <small>电脑上传书籍到网盘；Kindle 联网且 KOReader 运行时自动收书，并定时上传笔记、标注与阅读记录。电脑开启自动更新后每分钟读取网盘变化。</small>
            </div>
            <div className="button-group">
              <button
                className="button"
                disabled={state.sync.working}
                onClick={() => run(() => window.kindlespouse.syncCloud(accountId), '已读取网盘中的笔记和设备回执')}
              >
                {state.sync.working ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即更新
              </button>
              <button
                className="button"
                disabled={Boolean(state.sync.pairing || state.cloudConnecting)}
                onClick={() => run(() => window.kindlespouse.pairDevice(accountId, 'Kindle Scribe'))}
              >
                {state.sync.pairing ? '等待设备授权…' : '配对 Kindle'}
              </button>
            </div>
          </section>
          {state.sync.error && <p className="error-text">{state.sync.error}</p>}
          {state.sync.devices.map((device) => (
            <div className="device-row" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <p>
                  {device.status === 'connected'
                    ? `Kindle 最近上传 ${device.lastSeen ? new Date(device.lastSeen).toLocaleString() : ''}`
                    : device.status === 'revoked'
                      ? '配对已撤销'
                      : '安装包已生成 · 等待设备首次同步'}
                </p>
              </div>
              {device.status !== 'revoked' && (
                <button className="text-button" onClick={() => run(() => window.kindlespouse.revokeDevice(device.id))}>
                  撤销配对
                </button>
              )}
            </div>
          ))}
          <p className="field-hint">
            首次配置需要分别完成桌面和设备授权。安装包包含设备专用凭据，请私下保管。之后日常同步无需
            USB，电脑上传完成后可关闭。
          </p>
          </>}
        </>
      ) : (
        <Empty title="连接你的网盘">支持 Google Drive 和 OneDrive，账号授权由你本人完成。</Empty>
      )}
      {(selected || action) && (
        <div className="modal-backdrop" onClick={close}>
          <section
            className={`confirm-modal ${action === 'edit' ? 'text-editor-modal' : ''}`}
            role="dialog"
            aria-label="管理网盘文件"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <h2>
                {action === 'mkdir'
                  ? '新建文件夹'
                  : action === 'move'
                    ? '重命名或移动'
                    : action === 'trash'
                      ? '移入回收站'
                      : selected?.name}
              </h2>
              <button className="icon-button" aria-label="关闭文件操作" onClick={close}>
                <X size={17} />
              </button>
            </div>
            {!action ? (
              <div className="file-actions">
                <button
                  className="button"
                  onClick={() => {
                    setAction('move')
                    setValue(selected!.path)
                  }}
                >
                  <Edit3 size={16} />
                  重命名或移动
                </button>
                <button className="button" onClick={() => setAction('trash')}>
                  <Trash2 size={16} />
                  移入回收站
                </button>
                {selected && !selected.isDir && (
                  <button
                    className="button"
                    onClick={() => run(() => window.kindlespouse.cloudSaveFile(accountId, selected.path))}
                  >
                    <Download size={16} />
                    下载文件
                  </button>
                )}
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  run(mutation, '网盘文件已更新')
                }}
              >
                {action === 'edit' ? (
                  <textarea
                    aria-label="网盘文本内容"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    spellCheck={false}
                  />
                ) : action === 'trash' ? (
                  <p>将「{selected?.name}」移动到网盘的 .KindleSpouse-Trash 文件夹，原内容可找回。</p>
                ) : (
                  <label>
                    {action === 'mkdir' ? '名称' : '目标完整路径'}
                    <input
                      aria-label="网盘目标路径"
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      required
                    />
                  </label>
                )}
                <div className="modal-actions">
                  <button className="button" type="button" onClick={close}>
                    取消
                  </button>
                  <button className="button primary" type="submit">
                    {action === 'edit' ? '保存' : '确认'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
