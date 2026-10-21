import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { SourceHealth, SourceAccount } from './shared'

export function SourceAccountStatus({ account, onCheck }: { account: SourceAccount; onCheck: () => void }) {
  const labels = { signed_out: '尚未登录 Zlib', unverified: '登录待验证', verifying: '正在验证 Zlib 登录', connected: 'Zlib 已连接', expired: 'Zlib 登录已失效', unavailable: '暂时无法验证 Zlib 登录' }
  return <div className="source-account-status" role="status">
    <span>{account.status === 'verifying' && <LoaderCircle size={14} className="spin" />}{labels[account.status]}{account.status === 'connected' && account.remaining !== undefined ? ` · 今日剩余 ${account.remaining} 次下载` : ''}</span>
    {account.error && <p>{account.error}</p>}
    {account.status !== 'signed_out' && <button className="text-button" disabled={account.status === 'verifying'} onClick={onCheck}>验证登录</button>}
  </div>
}

const labels = {
  unknown: '等待检查',
  checking: '正在检测',
  online: '接口可用',
  offline: '连接失败',
  blocked: '暂不可用',
}
export default function SourceStatus({ health, onRefresh }: { health: SourceHealth; onRefresh: () => void }) {
  const usable = health.entries.filter((entry) => entry.status === 'online').length
  return (
    <div className="source-health">
      <div className="section-heading">
        <div>
          <strong>{health.checking ? '正在检查书源连接' : `${usable} 个接口入口可用`}</strong>
          <p>
            {health.activeOrigin
              ? `当前使用 ${new URL(health.activeOrigin).hostname}`
              : '自动检查连接，按可用状态选择入口'}
            {health.checkedAt
              ? ` · ${new Date(health.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 检查`
              : ''}
          </p>
        </div>
        <button className="text-button" disabled={health.checking} onClick={onRefresh}>
          {health.checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}重新检测
        </button>
      </div>
      <div className="source-endpoints">
        {health.entries.map((entry) => (
          <div key={entry.origin} className={`source-endpoint ${entry.status}`} title={entry.detail}>
            <i />
            <span>{new URL(entry.origin).hostname}</span>
            <small>
              {labels[entry.status]}
              {entry.status === 'online' && entry.latencyMs !== undefined ? ` · ${entry.latencyMs} ms` : ''}
            </small>
          </div>
        ))}
      </div>
      <p className="field-hint">
        应用运行时每两分钟检查，搜索或下载前刷新过期结果。连接失败时尝试备用入口；账号失效或额度用尽会直接提示。
      </p>
    </div>
  )
}
