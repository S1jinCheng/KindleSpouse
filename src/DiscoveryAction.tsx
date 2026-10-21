import { Archive, BookOpen, Check, Cloud, Download, LoaderCircle, Mail, RotateCcw } from 'lucide-react'
import type { AppState, Candidate, DiscoveryResult } from './shared'
import { isKoreaderFormat } from './book-formats'
import { kindleMode, kindleMailFormat, nativeDelivery } from './kindle-devices'

export function discoveryFile(result: DiscoveryResult, state: AppState) {
  const binding = state.discoveryFiles?.find(item => item.id === result.id)
  return state.candidates.find(book => book.id === (result.bookId ?? binding?.candidateId) && (!binding || book.sha256 === binding.sha256))
}

export default function DiscoveryAction({ result, state, reviewed, working, onPreview, onDownload, onRetry }: {
  result: DiscoveryResult
  state: AppState
  reviewed: string[]
  working?: 'preview' | 'download'
  onPreview: () => void
  onDownload: (book: Candidate) => void
  onRetry: (id: string) => void
}) {
  const book = discoveryFile(result, state)
  const native = kindleMode(state.settings) === 'native'
  const nativeCloud = native && nativeDelivery(state.settings) === 'native-cloud'
  const account = state.clouds.find(account => account.id === state.settings.defaultCloudId) ?? state.clouds.find(account => account.connected)
  const job = book && state.jobs.find(job => job.candidateId === book.id && job.sha256 === book.sha256 && (nativeCloud ? job.method === 'native-cloud' && job.cloudAccountId === account?.id : native ? job.method === 'kindle-email' && job.target === state.kindleMail?.recipient && job.mailRevision === state.kindleMail?.revision : job.method === 'cloud' && job.cloudAccountId === account?.id) && job.status !== 'cancelled')
  const previewed = book && reviewed.includes(`${book.id}:${book.sha256}`)
  const receiving = job && ['queued', 'importing', 'transferring', 'verifying'].includes(job.status)
  const complete = job?.deviceReceivedAt
  const manualImport = job?.status === 'native_cloud_ready'
  const available = job?.status === 'cloud_ready' || manualImport
  const submitted = job?.status === 'email_submitted'
  const uncertain = job?.status === 'delivery_unknown'
  const failed = job?.status === 'failed' || uncertain
  const busy = Boolean(working || receiving)
  const protectedBook = book?.warnings.some(warning => /平台 DRM/.test(warning))
  const unsupportedMail = native && Boolean(previewed) && !kindleMailFormat(book?.format)
  const label = working === 'preview' ? '准备试读' : busy ? native && !nativeCloud ? '发送中' : job?.status === 'verifying' ? '校验中' : job?.status === 'transferring' ? '上传中' : '准备上传' : protectedBook ? '仅原件备份' : complete ? '已在 Kindle' : submitted ? '已提交' : manualImport ? '待手动导入' : available ? '待收书' : uncertain ? '确认后重发' : failed ? native ? '重试发送' : '重试下载' : previewed ? nativeCloud ? '上传到网盘' : native ? '发送到 Kindle' : '下载' : '试读'
  const hint = manualImport ? '网盘已保存，需在 Kindle 导入' : submitted ? '等待 Amazon 处理' : uncertain ? '结果待确认，重发可能重复' : unsupportedMail ? '请选 EPUB、PDF 等邮件支持格式' : protectedBook && !busy ? complete ? '原件已在 Kindle' : available ? '已备份网盘' : '受保护的原生文件' : !busy && !failed && book && !complete ? available ? '已上传网盘' : book.derivedFromHash ? 'Kindle 原件的阅读副本' : book.fromDevice ? '从 Kindle 导入' : previewed ? '仅本机试读' : '本机试读文件' : undefined
  const Icon = busy ? LoaderCircle : protectedBook ? Archive : complete ? Check : submitted ? Mail : available ? Cloud : failed ? RotateCcw : previewed ? native ? Mail : Download : BookOpen
  return <button className={`icon-button discovery-primary-action${complete ? ' received' : ''}`} aria-label={`${label} ${result.title}`} title={nativeCloud ? '上传已试读原件后，请在 Kindle Connections 中手动导入' : native ? submitted ? '邮件服务已接受，尚无设备收书回执' : '试读后通过 Send to Kindle 发送原文件' : protectedBook ? '原件已保留，受平台保护的文件无法在 KOReader 中试读' : available ? '已上传网盘，等待 Kindle 联网取书' : previewed && account ? `下载到 ${account.name}，由 Kindle 自动同步` : '在左侧 Kindle 试读这个版本'} disabled={busy || Boolean(protectedBook || available || complete || submitted || unsupportedMail) || !isKoreaderFormat(result.format)} onClick={() => {
    if (failed && job) { if (!uncertain || window.confirm('请先检查 Kindle 和发件记录。重新发送可能产生重复书籍，是否继续？')) onRetry(job.id) }
    else if (previewed && book) onDownload(book)
    else onPreview()
  }}><Icon className={busy ? 'spin' : undefined} size={19} /><span>{label}</span>{receiving && <small>{Math.round(job.progress * 100)}%</small>}{hint && <small>{hint}</small>}</button>
}
