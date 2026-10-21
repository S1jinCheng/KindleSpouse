import { useEffect, useState } from 'react'
import { BookOpen, Eye, X } from 'lucide-react'
import type { AppState } from './shared'
import type { Run } from './ui'
import { isKoreaderFormat } from './book-formats'
import ProfileSyncStatus from './ProfileSyncStatus'

export default function SleepCoverSettings({ state, run, readingBookId }: { state: AppState; run: Run; readingBookId?: string }) {
  const books = state.candidates.filter(book => isKoreaderFormat(book.format))
  const reading = books.find(book => book.id === readingBookId) ?? books.find(book => book.location) ?? books.find(book => book.library) ?? books[0]
  const [example, setExample] = useState('')
  const book = books.find(book => book.id === example) ?? reading
  const [open, setOpen] = useState(false), [image, setImage] = useState(''), [busy, setBusy] = useState(false)
  const [renderedKey, setRenderedKey] = useState('')
  const key = JSON.stringify([book?.sha256, book?.location, state.settings.avatarImage, state.settings.avatar, state.settings.displayName, state.stats.todaySeconds, state.sync.lastSuccess])
  useEffect(() => () => { if (image) URL.revokeObjectURL(image) }, [image])
  const preview = () => {
    setOpen(true)
    if (!book || busy || renderedKey === key && image) return
    run(async () => {
      setBusy(true)
      try {
        const bytes = await window.kindlespouse.previewSleepCover(book.id)
        setImage(URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })))
        setRenderedKey(key)
      } finally { setBusy(false) }
    })
  }
  return <section className="card settings-section sleep-settings">
    <div className="section-heading"><div><h2>Kindle 休眠封面</h2><p>合上这一页，阅读仍在继续。</p></div>
      <label className="sleep-toggle"><input type="checkbox" aria-label="启用休眠封面" checked={state.settings.sleepCoverEnabled ?? true} onChange={event => run(() => window.kindlespouse.saveSettings({ sleepCoverEnabled: event.target.checked }))} /><span /></label>
    </div>
    <div className="sleep-cover-overview">
      <button className="sleep-cover-thumbnail" aria-label="查看休眠封面样式" onClick={preview} disabled={!book || busy}>
        {image && renderedKey === key ? <img src={image} alt="已生成的休眠封面" /> : <div className="sleep-thumbnail-book">{book?.cover ? <img src={book.cover} alt="" /> : <BookOpen size={30} />}<span>CURRENTLY READING</span></div>}
      </button>
      <div className="sleep-cover-description"><span className="eyebrow">自动跟随当前阅读</span><h3>你的书，你的阅读记录</h3>
        <p>书籍封面、书名与作者，搭配阅读进度、个人头像、今日时长和连续阅读天数。</p>
        <p className="sleep-local-hint">Kindle 提前准备封面与头像，休眠时更新本机阅读数据。离线也可使用。</p>
        <button className="text-button" onClick={preview} disabled={!book || busy}><Eye size={15} />{busy ? '正在生成预览…' : '查看封面样式'}</button>
      </div>
    </div>
    <div className="sleep-settings-footer"><ProfileSyncStatus state={state} run={run} /><span>{state.localProfiles?.enabled ? 'Kindle 选择 Sync profile now，优先直连此电脑；连接失败时使用网盘。' : '修改资料后自动上传；设备在下次网盘同步时接收。'}</span></div>
    {open && <div className="modal-backdrop" onClick={() => setOpen(false)}><section className="sleep-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="sleep-preview-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
      <div className="section-heading"><div><h2 id="sleep-preview-title">休眠封面预览</h2><p>KOReader 实际渲染 · 英文样式</p></div><button autoFocus className="icon-button" aria-label="关闭封面预览" onClick={() => setOpen(false)}><X size={18} /></button></div>
      <div className="sleep-preview-stage" aria-busy={busy}>{busy ? <p>正在生成预览…</p> : image && renderedKey === key ? <img src={image} alt="KOReader 实际渲染的英文休眠封面" /> : <p>选择书籍后生成预览</p>}</div>
      <details className="sleep-preview-example"><summary>更换示例书籍</summary><div><select aria-label="封面预览书籍" value={book?.id ?? ''} onChange={event => setExample(event.target.value)}>{books.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select><button className="button" disabled={!book || busy} onClick={preview}>更新预览</button></div></details>
      <p className="field-hint">这里只选择电脑预览的示例。Kindle 始终显示正在阅读的书，时长与进度以设备本地最新记录为准。</p>
    </section></div>}
  </section>
}
