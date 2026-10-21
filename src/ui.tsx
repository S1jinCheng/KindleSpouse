import type { ReactNode } from 'react'
import { BookOpen, Check, Cloud, LoaderCircle, Mail, RefreshCw, Usb, Wifi, X } from 'lucide-react'
import type { Settings, TransferJob } from './shared'

export type Run = (task: () => Promise<unknown>, success?: string) => void
export const bytesLabel = (value: number) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(value / 1024))} KB`
export const minutesLabel = (seconds: number) =>
  seconds < 60
    ? `${Math.floor(seconds)} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
export function Avatar({ settings, large = false }: { settings: Settings; large?: boolean }) {
  const initial = [...new Intl.Segmenter().segment(settings.displayName || '我')][0]?.segment ?? '我'
  return <span className={`avatar avatar-tone-${settings.avatarTone ?? 'sand'}${large ? ' large' : ''}`}>{settings.avatarImage ? <img src={settings.avatarImage} alt="个人头像" /> : settings.avatar || initial}</span>
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <BookOpen size={35} strokeWidth={1.3} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}
export function JobRow({ job, run }: { job: TransferJob; run: Run }) {
  const active = ['importing', 'transferring', 'verifying'].includes(job.status)
  const labels: Record<string, string> = {
    queued: '等待处理',
    waiting_device: '等待 USB',
    importing: '正在入库',
    transferring: '正在传输',
    verifying: '正在校验',
    sent: '设备已校验',
    cloud_ready: '已上传到网盘 · 等待 Kindle 同步下载',
    published: '无线书目已发布',
    email_submitted: '已交给邮件服务 · 等待 Amazon 处理',
    delivery_unknown: '发送结果待确认 · 请先检查 Kindle',
    native_cloud_ready: '已上传网盘 · 请在 Kindle Connections 手动导入',
    failed: '传输失败',
    cancelled: '已取消',
  }
  return (
    <article className="job-row">
      <div className="job-icon">
        {active ? (
          <LoaderCircle className="spin" size={18} />
        ) : job.deviceReceivedAt || job.status === 'sent' ? (
          <Check size={18} />
        ) : job.method === 'kindle-email' ? (
          <Mail size={18} />
        ) : job.method === 'cloud' || job.method === 'native-cloud' ? (
          <Cloud size={18} />
        ) : job.method === 'usb' ? (
          <Usb size={18} />
        ) : (
          <Wifi size={18} />
        )}
      </div>
      <div className="job-copy">
        <strong>{job.title}</strong>
        <p>{job.error ?? (job.deviceReceivedAt ? 'Kindle 已下载并校验' : labels[job.status])}</p>
        {active && <progress value={job.progress} max={1} />}
      </div>
      {(['failed', 'waiting_device', 'delivery_unknown'].includes(job.status) || job.method === 'kindle-email' && job.status === 'email_submitted') && (
        <button
          className="icon-button"
          aria-label={`${job.status === 'email_submitted' ? '再次发送' : '重试'} ${job.title}`}
          onClick={() => { if (!['delivery_unknown', 'email_submitted'].includes(job.status) || window.confirm('邮件可能已经提交，再次发送可能产生重复书籍。确认重新发送？')) run(() => window.kindlespouse.retry(job.id)) }}
        >
          <RefreshCw size={16} />
        </button>
      )}
      {['queued', 'failed', 'waiting_device', 'delivery_unknown'].includes(job.status) && (
        <button
          className="icon-button"
          aria-label={`取消 ${job.title}`}
          onClick={() => run(() => window.kindlespouse.cancel(job.id))}
        >
          <X size={16} />
        </button>
      )}
    </article>
  )
}
