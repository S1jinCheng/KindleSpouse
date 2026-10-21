import { useMemo, useState } from 'react'
import { BookOpen, LoaderCircle, MapPin, Pencil, RefreshCw, X } from 'lucide-react'
import type { AppState } from './shared'
import { Avatar, Empty, minutesLabel, type Run } from './ui'
import AvatarUpload from './AvatarUpload'
import ProfileSyncStatus from './ProfileSyncStatus'

export default function ProfilePanel({ state, run }: { state: AppState; run: Run }) {
  const [name, setName] = useState(state.settings.displayName ?? '我的阅读空间')
  const [avatar, setAvatar] = useState(state.settings.avatar ?? '')
  const [avatarImage, setAvatarImage] = useState(state.settings.avatarImage ?? '')
  const [tone, setTone] = useState(state.settings.avatarTone ?? 'sand')
  const [bio, setBio] = useState(state.settings.bio ?? '')
  const [location, setLocation] = useState(state.settings.location ?? '')
  const [editing, setEditing] = useState(false)
  const [day, setDay] = useState('')
  const account = state.clouds.find(cloud => cloud.id === state.settings.defaultCloudId) ?? state.clouds[0]
  const edit = () => {
    setName(state.settings.displayName ?? '我的阅读空间')
    setAvatar(state.settings.avatar ?? '')
    setAvatarImage(state.settings.avatarImage ?? '')
    setTone(state.settings.avatarTone ?? 'sand')
    setBio(state.settings.bio ?? '')
    setLocation(state.settings.location ?? '')
    setEditing(true)
  }
  const days = useMemo(() => {
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const end = new Date(today)
    end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)))
    return Array.from({ length: 364 }, (_, index) => {
      const date = new Date(end)
      date.setDate(date.getDate() - 363 + index)
      const key = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date)
      const stat = state.stats.days.find((item) => item.date === key)
      const minutes = (stat?.seconds ?? 0) / 60
      return {
        key,
        future: date > today,
        seconds: stat?.seconds ?? 0,
        level: minutes >= 60 ? 4 : minutes >= 30 ? 3 : minutes >= 15 ? 2 : minutes > 0 ? 1 : 0,
        books: stat?.books ?? [],
      }
    })
  }, [state.stats.days])
  const selected = days.find((item) => item.key === day)
  return (
    <div className="page-stack profile-page">
      <header className="page-heading">
        <div className="profile-heading">
          <Avatar settings={state.settings} large />
          <div>
            <h1>{state.settings.displayName || '我的阅读空间'}</h1>
            <p>{state.settings.bio || '把时间留给阅读'}</p>
            {state.settings.location && <span className="profile-location"><MapPin size={13} />{state.settings.location}</span>}
          </div>
        </div>
        <button className="button" onClick={edit}><Pencil size={15} />编辑资料</button>
      </header>
      <ProfileSyncStatus state={state} run={run} />
      <div className="profile-reading-source"><div><strong>Kindle 阅读记录</strong><p>{state.settings.kindleMode === 'native' ? '原生 Kindle 阅读时长尚未接入。这里仅保留之前同步的 KOReader 记录，电脑试读不计入统计。' : '来自 Kindle 上的 KOReader，经网盘同步更新。原生 Kindle 阅读器的时长暂未接入。'}</p></div><button hidden={state.settings.kindleMode === 'native'} className="text-button" disabled={!account || state.sync.working} onClick={() => account && run(() => window.kindlespouse.syncCloud(account.id), '网盘记录已更新')}>{state.sync.working ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}更新记录</button></div>
      {state.sync.error && <p className="error-text">{state.sync.error}</p>}
      <section className="profile-metrics">
        <div>
          <span>今日阅读</span>
          <strong>{minutesLabel(state.stats.todaySeconds)}</strong>
        </div>
        <div>
          <span>累计阅读</span>
          <strong>{minutesLabel(state.stats.totalSeconds)}</strong>
        </div>
        <div>
          <span>读过的书</span>
          <strong>
            {state.stats.books.length}
            <small> 本</small>
          </strong>
        </div>
        <div>
          <span>阅读天数</span>
          <strong>
            {state.stats.days.filter(item => item.seconds > 0).length}
            <small> 天</small>
          </strong>
        </div>
      </section>
      <section className="card heatmap-card">
        <div className="section-heading">
          <h2>阅读日历</h2>
          <small>最近 52 周 · 按阅读分钟数</small>
        </div>
        <div className="heatmap" aria-label="每日阅读强度">
          {days.map((item) => (
            <button
              key={item.key}
              className={`heatmap-cell intensity-${item.level} ${item.future ? 'future' : ''} ${day === item.key ? 'selected' : ''}`}
              aria-label={`${item.key} 阅读 ${minutesLabel(item.seconds)}`}
              title={`${item.key} · ${minutesLabel(item.seconds)}`}
              disabled={item.future}
              onClick={() => setDay(item.key)}
            />
          ))}
        </div>
        <div className="heatmap-footer">
          <span>
            {selected
              ? `${selected.key} · ${minutesLabel(selected.seconds)}${selected.books.length ? ' · ' + selected.books.join('、') : ''}`
              : '点击日期查看阅读记录'}
          </span>
          <span>
            少
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} className={`intensity-${level}`} />
            ))}
            多
          </span>
        </div>
      </section>
      <section className="card profile-books">
        <h2>阅读的书籍</h2>
        {state.stats.books.length ? (
          state.stats.books.map((book) => (
            <div className="profile-book" key={book.title}>
              <BookOpen size={18} />
              <strong>{book.title}</strong>
              <span>{minutesLabel(book.seconds)}</span>
            </div>
          ))
        ) : (
          <Empty title="尚未收到 Kindle 阅读记录">在 Kindle 的 KOReader 阅读后运行 KindleSpouse 同步，再点击上方“更新记录”。请确认设备上的阅读统计插件已开启。</Empty>
        )}
      </section>
      {editing && <div className="modal-backdrop" onClick={() => setEditing(false)}><form className="confirm-modal profile-editor" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setEditing(false) }} onSubmit={event => { event.preventDefault(); run(async () => { await window.kindlespouse.saveSettings({ displayName: name.trim(), avatar: avatar.trim(), avatarImage, avatarTone: tone, bio: bio.trim(), location: location.trim() }); setEditing(false) }, '个人资料已保存') }}>
        <div className="section-heading"><h2 id="profile-editor-title">编辑个人资料</h2><button type="button" className="icon-button" aria-label="关闭资料编辑" onClick={() => setEditing(false)}><X size={17} /></button></div>
        <div className="profile-avatar-editor"><Avatar settings={{ ...state.settings, displayName: name, avatar, avatarImage, avatarTone: tone }} large /><div className="profile-avatar-caption"><strong>个人头像</strong><p>电脑显示彩色照片，Kindle 自动适配灰度。</p></div></div>
        <AvatarUpload image={avatarImage} onChange={setAvatarImage} />
        {!avatarImage && <><label>头像文字<input aria-label="头像文字" value={avatar} onChange={event => setAvatar(event.target.value)} maxLength={4} placeholder="未使用照片时显示" /></label><div className="avatar-tones" role="group" aria-label="头像颜色">{([['sand', '麦色'], ['clay', '陶色'], ['moss', '苔绿'], ['slate', '灰蓝'], ['plum', '烟紫']] as const).map(([value, label]) => <button type="button" key={value} className={`avatar-tone-${value}`} aria-label={`头像颜色：${label}`} aria-pressed={tone === value} onClick={() => setTone(value)}><span /></button>)}</div></>}
        <label>昵称<input aria-label="个人昵称" value={name} onChange={event => setName(event.target.value)} required maxLength={60} autoFocus /></label>
        <label>个人简介<textarea aria-label="个人简介" rows={3} value={bio} onChange={event => setBio(event.target.value)} maxLength={160} /></label>
        <label>所在地<input aria-label="所在地" value={location} onChange={event => setLocation(event.target.value)} maxLength={60} /></label>
        <div className="modal-actions"><button className="button" type="button" onClick={() => setEditing(false)}>取消</button><button className="button primary" type="submit" disabled={!name.trim()}>保存</button></div>
      </form></div>}
    </div>
  )
}
