import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import type { KoreaderAction, KoreaderFrame } from './shared'
import type { ReaderHandle, ReaderProps } from './Reader'
import { readerErrorMessage } from './reader-errors'
import { koreaderLocation } from './koreader-location'
import NativePage, { type NativePageHandle } from './NativePage'
import type { PageTurnDirection } from './page-turn'
import { isRollingFormat } from './book-formats'

const KoreaderReader = forwardRef<ReaderHandle, ReaderProps>(function KoreaderReader(props, ref) {
  const [frame, setFrame] = useState<KoreaderFrame>()
  const [loading, setLoading] = useState(false)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const callbacks = useRef(props)
  callbacks.current = props
  const session = useRef('')
  const surface = useRef<NativePageHandle>(null)
  const visibleFrame = useRef<KoreaderFrame>(undefined)
  const gesture = useRef<{ id: number; x: number; y: number }>(undefined)
  const pending = useRef(false)
  const commands = useRef<Promise<unknown>>(Promise.resolve())
  const generation = useRef(0)
  const wasActive = useRef(props.active !== false)
  const apply = async (next: KoreaderFrame, current: number, direction: PageTurnDirection = 0) => {
    if (generation.current !== current) return false
    setSlow(false)
    const shown = await surface.current?.show(next, direction)
    if (!shown || generation.current !== current) return false
    visibleFrame.current = next
    setFrame(next)
    const { image: ignored, ...details } = next
    callbacks.current.onKoreader?.(details)
    callbacks.current.onChapters(next.toc.map(item => ({ label: item.label, href: `koreader:page:${item.page}` })))
    callbacks.current.onLocation(koreaderLocation(next.location, next.domVersion), next.page / Math.max(1, next.pages))
    return true
  }
  const command = (action: KoreaderAction): Promise<KoreaderFrame | undefined> => {
    const current = generation.current
    const operation = commands.current.catch(() => {}).then(async () => {
    if (!session.current || generation.current !== current) return
    pending.current = true
    setLoading(true)
    callbacks.current.onReady(false)
    let ready = false
    try {
      const before = visibleFrame.current
      const next = await window.kindlespouse.commandKoreader(session.current, action)
      if (generation.current === current) {
        setError('')
        const direction = before ? Math.sign(next.page - before.page) as PageTurnDirection : 0
        ready = await apply(next, current, direction)
        return next
      } else void window.kindlespouse.closeKoreader(next.sessionId).catch(() => {})
    }
    catch (error) { if (generation.current === current) setError(readerErrorMessage(error)) }
    finally { if (generation.current === current) { pending.current = false; setLoading(false); callbacks.current.onReady(ready) } }
    })
    commands.current = operation
    return operation
  }
  const turn = (direction: -1 | 1) => {
    const current = visibleFrame.current
    if (!current || pending.current || error || callbacks.current.active === false || (direction < 0 ? current.page <= 1 : current.page >= current.pages)) return
    pending.current = true
    void command(isRollingFormat(callbacks.current.book?.format ?? '') ? { action: direction > 0 ? 'next' : 'prev' } : { action: 'page', page: current.page + direction })
  }
  useImperativeHandle(ref, () => ({
    configure: () => setAttempt(value => value + 1),
    go: href => { const page = Number(href.replace('koreader:page:', '')); if (Number.isSafeInteger(page) && page > 0) void command({ action: 'page', page }) },
    locate: async anchor => {
      const next = await command({ action: 'locate', anchor })
      return next?.anchorResult ?? { found: false, message: '阅读器尚未就绪，请重试。' }
    },
  }))
  useEffect(() => {
    setSlow(false)
    if (!loading || !frame) return
    const timer = setTimeout(() => setSlow(true), 1200)
    return () => clearTimeout(timer)
  }, [loading, frame])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || callbacks.current.active === false) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      turn(event.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  useEffect(() => {
    const active = props.active !== false
    const returning = active && !wasActive.current
    wasActive.current = active
    if (!returning || !props.book || !session.current) return
    const current = generation.current
    pending.current = true
    setLoading(true)
    callbacks.current.onReady(false)
    let ready = false
    const operation = commands.current.catch(() => {}).then(async () => {
      if (generation.current !== current) return
      const next = await window.kindlespouse.openKoreader(props.book!.id)
      if (generation.current !== current) { void window.kindlespouse.closeKoreader(next.sessionId).catch(() => {}); return }
      session.current = next.sessionId
      setError('')
      ready = await apply(next, current)
    }).catch(error => { if (generation.current === current) setError(readerErrorMessage(error)) }).finally(() => {
      if (generation.current === current) { pending.current = false; setLoading(false); callbacks.current.onReady(ready) }
    })
    commands.current = operation
  }, [props.active, props.book?.id])
  useEffect(() => {
    generation.current++
    let disposed = false, id = ''
    pending.current = true
    setLoading(false)
    setFrame(undefined)
    visibleFrame.current = undefined
    gesture.current = undefined
    surface.current?.clear()
    setError('')
    callbacks.current.onReady(false)
    callbacks.current.onChapters([])
    callbacks.current.onKoreader?.(undefined)
    if (!props.book) { pending.current = false; return }
    setLoading(true)
    const current = generation.current
    void window.kindlespouse.openKoreader(props.book.id, attempt > 0).then(async next => {
      id = next.sessionId
      if (disposed) { void window.kindlespouse.closeKoreader(id).catch(() => {}); return }
      session.current = id
      const ready = await apply(next, current)
      if (!disposed) { pending.current = false; setLoading(false); callbacks.current.onReady(ready) }
    }).catch(error => { if (!disposed) { pending.current = false; setError(readerErrorMessage(error)); setLoading(false) } })
    return () => { disposed = true; generation.current++; surface.current?.clear(); const activeId = session.current || id; session.current = ''; if (activeId) void window.kindlespouse.closeKoreader(activeId).catch(() => {}) }
  }, [props.book?.id, attempt])
  return <section className="reader-card" aria-label="仿 Kindle 阅读器" data-engine="koreader" data-session-id={frame?.sessionId} data-profile-matched={frame?.exactBook ?? false} aria-busy={loading}>
    <div className="reader-stage"><div className="kindle-bezel white-paper"><div className="paper-viewport native-paper" onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || !visibleFrame.current || pending.current || error) return
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
    }} onPointerCancel={() => { gesture.current = undefined }} onPointerUp={event => {
      const start = gesture.current
      gesture.current = undefined
      if (!start || start.id !== event.pointerId) return
      const dx = event.clientX - start.x, dy = event.clientY - start.y
      const bounds = event.currentTarget.getBoundingClientRect()
      if (Math.abs(dx) > Math.max(30, bounds.width * .08) && Math.abs(dx) > Math.abs(dy) * 1.4) turn(dx < 0 ? 1 : -1)
      else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) turn(event.clientX > bounds.left + bounds.width / 2 ? 1 : -1)
    }}>
      <NativePage ref={surface} active={props.active !== false} style={props.pageTurn ?? 'paper'} />
      {!props.book && <div className="reader-welcome"><BookOpen size={32} /><h2>打开一本书</h2><button onClick={props.onImport}>导入书籍</button></div>}
      {loading && !frame && <div className="paper-overlay"><LoaderCircle className="spin" size={24} /><span>正在打开书籍</span></div>}
      {slow && frame && <div className="reader-page-status" role="status"><LoaderCircle className="spin" size={12} /><span>正在准备下一页</span></div>}
      {error && <div className="paper-overlay reader-error"><BookOpen size={24} /><strong>阅读器暂时不可用</strong><p>{error}</p><button className="button" onClick={() => setAttempt(value => value + 1)}>重新打开</button></div>}
    </div><span className="bezel-wordmark">kindlespouse</span></div></div>
    <div className="reader-toolbar"><button className="icon-button" aria-label="上一页" disabled={!frame || frame.page <= 1 || loading || Boolean(error)} onClick={() => turn(-1)}><ChevronLeft size={19} /></button><button className="icon-button" aria-label="下一页" disabled={!frame || frame.page >= frame.pages || loading || Boolean(error)} onClick={() => turn(1)}><ChevronRight size={19} /></button></div>
  </section>
})
export default KoreaderReader
