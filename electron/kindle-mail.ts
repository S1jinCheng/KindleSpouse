import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { SendMailOptions } from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import type { SecretStore } from './cloud'
import type { KindleMailInput, KindleMailState } from '../src/shared'
import { KINDLE_MAIL_MAX_BYTES, kindleMailFormat } from '../src/kindle-devices'

interface Credentials extends KindleMailInput { password: string; revision: string; verifiedAt?: string; testSubmittedAt?: string }
interface MailConnection {
  verify(): Promise<unknown>
  sendMail(message: SendMailOptions): Promise<{ accepted: unknown[]; rejected: unknown[] }>
  close(): void
}
type MailFactory = (options: SMTPTransport.Options) => MailConnection
export class KindleMailError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message) }
}
function safeMailError(error: unknown, sending: boolean) {
  const detail = error as { code?: string; command?: string; responseCode?: number }
  if (detail.code === 'EAUTH') return new KindleMailError('发件邮箱认证失败。请检查 SMTP 授权码或应用专用密码。')
  if (detail.code === 'EENVELOPE' || detail.responseCode && detail.responseCode >= 500) return new KindleMailError('邮件服务拒绝了发送。请检查邮箱地址、发送额度和附件限制。')
  if (['ETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(detail.code ?? '')) return new KindleMailError('邮件加密连接未通过验证，请检查服务器地址和 TLS 设置。')
  if (sending && ['DATA', 'CONN'].includes(detail.command ?? '') && ['ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(detail.code ?? '')) return new KindleMailError('连接中断，无法确定邮件是否已提交。请先查看 Kindle 和发件记录，再决定是否重新发送。', true)
  return new KindleMailError('无法连接邮件服务。请检查服务器、端口、网络和 SMTP 是否已开启。')
}

export class KindleMail {
  private readonly key = 'kindle-mail-v1'
  constructor(private secrets: SecretStore, private createTransport: MailFactory = options => nodemailer.createTransport(options)) {}

  private credentials() {
    const value = this.secrets.get(this.key)
    return value ? JSON.parse(value) as Credentials : undefined
  }

  state(): KindleMailState | undefined {
    const value = this.credentials()
    if (!value) return undefined
    const { password, revision, ...publicValue } = value
    return { ...publicValue, revision, hasPassword: Boolean(password), configured: Boolean(password && value.verifiedAt && value.approvedSender) }
  }

  save(input: KindleMailInput) {
    const sender = input.sender.trim(), recipient = input.recipient.trim().toLowerCase(), host = input.host.trim().toLowerCase()
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@kindle\.(com|cn)$/i.test(recipient)) throw new Error('请填写设备设置中显示的 Send to Kindle 邮箱（@kindle.com 或 @kindle.cn）。')
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(sender) || sender.length > 254) throw new Error('请填写有效的发件邮箱。')
    if (host.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host)) throw new Error('请填写邮件服务商提供的 SMTP 服务器域名。')
    if (!Number.isInteger(input.port) || ![465, 587].includes(input.port) || input.security !== (input.port === 465 ? 'tls' : 'starttls')) throw new Error('请选择 465（TLS）或 587（STARTTLS）加密端口。')
    const previous = this.credentials()
    const sameServer = previous?.sender === sender && previous.host === host && previous.port === input.port && previous.security === input.security
    const password = input.password || (sameServer ? previous?.password : undefined)
    if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new Error('请输入发件邮箱的 SMTP 授权码或应用专用密码。更换邮箱或服务器后需要重新填写。')
    const unchanged = sameServer && previous?.password === password && previous.recipient === recipient && previous.approvedSender === input.approvedSender
    this.secrets.set(this.key, JSON.stringify({ recipient, sender, host, port: input.port, security: input.security, approvedSender: input.approvedSender, password, revision: unchanged ? previous.revision : randomUUID(), verifiedAt: unchanged ? previous.verifiedAt : undefined, testSubmittedAt: unchanged ? previous.testSubmittedAt : undefined } satisfies Credentials))
  }

  clear() { this.secrets.set(this.key, '') }
  revision() { return this.credentials()?.revision }

  private transport(value: Credentials) {
    return this.createTransport({ host: value.host, port: value.port, secure: value.security === 'tls', requireTLS: true, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, auth: { user: value.sender, pass: value.password }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 120000, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false, name: 'kindlespouse.local' })
  }

  async verify() {
    const value = this.credentials()
    if (!value) throw new Error('请先保存发件邮箱设置。')
    const transport = this.transport(value)
    try {
      await transport.verify()
      if (this.revision() === value.revision) this.secrets.set(this.key, JSON.stringify({ ...value, verifiedAt: new Date().toISOString() }))
    } catch (error) { throw safeMailError(error, false) }
    finally { transport.close() }
  }

  async send(book: { title: string; format: string; bytes: Buffer }, revision: string, recipient: string, messageId: string) {
    const value = this.credentials()
    if (!value || !value.verifiedAt || !value.approvedSender) throw new Error('请先完成发件邮箱连接测试，并确认已在 Amazon 添加认可发件地址。')
    if (value.revision !== revision || value.recipient !== recipient) throw new Error('发件设置已改变。请取消旧任务，按新设置重新确认发送。')
    if (!kindleMailFormat(book.format)) throw new Error('Send to Kindle 不支持这个格式。请选用 EPUB、PDF、TXT 或其他受支持的版本。')
    if (!book.bytes.length || book.bytes.length > KINDLE_MAIL_MAX_BYTES) throw new Error('邮件传书目前支持 25 MiB 以内的单本文件；更大文件请使用官方网页上传。')
    const transport = this.transport(value)
    try {
      const extension = book.format === 'epub3' ? 'epub' : book.format
      const title = book.title.replace(/[\r\n\0<>:"/\\|?*]/g, ' ').slice(0, 100).trim() || 'Book'
      const result = await transport.sendMail({ from: value.sender, to: value.recipient, envelope: { from: value.sender, to: [value.recipient] }, subject: title, messageId: `<${messageId}@kindlespouse.local>`, text: 'Sent with KindleSpouse. Amazon processes the attached personal document.', attachments: [{ filename: title + '.' + extension, content: book.bytes }], disableFileAccess: true, disableUrlAccess: true })
      if (!result.accepted.some(address => String(address).toLowerCase() === value.recipient) || result.rejected.length) throw new KindleMailError('邮件服务未接受 Kindle 收件地址，请核对设置后重试。')
    } catch (error) { if (error instanceof KindleMailError) throw error; throw safeMailError(error, true) }
    finally { transport.close() }
  }

  async sendTest() {
    const value = this.credentials()
    if (!value) throw new Error('请先保存发件邮箱设置。')
    await this.send({ title: 'KindleSpouse connection test', format: 'txt', bytes: Buffer.from('KindleSpouse\n\nYour Send to Kindle connection is working.\nThis is a generated test document, not a personal book.\n') }, value.revision, value.recipient, randomUUID())
    if (this.revision() === value.revision) this.secrets.set(this.key, JSON.stringify({ ...value, testSubmittedAt: new Date().toISOString() }))
  }
}
