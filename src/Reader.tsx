import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import ePub from 'epubjs'
import * as pdfjs from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { BookOpen, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import type { Candidate, NoteAnchor, PreviewProfile, KoreaderFrame } from './shared'
import { quoteMatches } from './anchors'
import KoreaderReader from './KoreaderReader'
import { usesKoreader } from './book-formats'
import type { PageTurnStyle } from './page-turn'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker
export interface Chapter {
  label: string
  href: string
  children?: Chapter[]
}
export interface ReaderHandle {
  go: (href: string) => void
  locate: (anchor: NoteAnchor) => Promise<{ found: boolean; message?: string }>
  configure?: () => void
}
export interface ReaderProps {
  browserOnly?: boolean
  active?: boolean
  onKoreader?: (frame: Omit<KoreaderFrame, 'image'> | undefined) => void
  engine?: 'koreader' | 'browser'
  pageTurn?: PageTurnStyle
  book?: Candidate
  profile: PreviewProfile
  onReady: (ready: boolean) => void
  onChapters: (chapters: Chapter[]) => void
  onLocation: (location: string, progress: number) => void
  onImport: () => void
  loadBytes?: (id: string) => Promise<Uint8Array>
}
const fonts = {
  serif: 'Georgia, "Noto Serif CJK SC", "SimSun", serif',
  sans: '"Segoe UI", "Microsoft YaHei", sans-serif',
  song: '"SimSun", "Songti SC", "Noto Serif CJK SC", serif',
}

const BrowserReader = forwardRef<ReaderHandle, ReaderProps>(function BrowserReader(props, forwardedRef) {
  const viewport = useRef<HTMLDivElement>(null)
  const rendition = useRef<ReturnType<ReturnType<typeof ePub>['renderTo']> | null>(null)
  const epub = useRef<ReturnType<typeof ePub> | null>(null)
  const pdf = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const pdfTask = useRef<pdfjs.PDFDocumentLoadingTask | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [percent, setPercent] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [pdfReady, setPdfReady] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [highlight, setHighlight] = useState<{ page: number; quote: string }>()
  const locating = useRef(0)
  const [viewportSize, setViewportSize] = useState({ width: 280, height: 374 })
  const observedSize = useRef({ width: 0, height: 0 })

  useImperativeHandle(
    forwardedRef,
    () => ({
      go: (href) => {
        if (props.book?.format === 'pdf') setPageNumber(Math.max(1, Math.min(pageCount, Number(href))))
        else void rendition.current?.display(href).catch(() => setError('无法跳转到这一章。'))
      },
      locate: async (anchor) => {
        const request = ++locating.current
        const bookId = callbacks.current.book?.id
        if (callbacks.current.book?.format === 'pdf') {
          const document = pdf.current
          if (!document) return { found: false, message: '书籍尚未加载完成。' }
          if (!anchor.quote && anchor.page && anchor.page <= document.numPages) {
            setPageNumber(anchor.page)
            return { found: true }
          }
          const hits: number[] = []
          for (let page = 1; page <= Math.min(1000, document.numPages); page++) {
            if (request !== locating.current || bookId !== callbacks.current.book?.id)
              return { found: false, message: '定位已取消。' }
            const content = await (await document.getPage(page)).getTextContent()
            const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
            for (const match of quoteMatches(text, anchor.quote ?? '', anchor.prefix, anchor.suffix)) {
              void match
              hits.push(page)
            }
            if (hits.length > 1) break
          }
          if (hits.length !== 1)
            return {
              found: false,
              message: hits.length
                ? '有多处相同引文，请关联正确版本或补充上下文。'
                : '此版本未找到引文；扫描版 PDF 可能没有文字层。',
            }
          setHighlight({ page: hits[0], quote: anchor.quote! })
          setPageNumber(hits[0])
          return { found: true }
        }
        const document = epub.current,
          instance = rendition.current
        if (!document || !instance) return { found: false, message: '书籍尚未加载完成。' }
        if (anchor.cfi) {
          try {
            await instance.display(anchor.cfi)
            instance.annotations.highlight(anchor.cfi, {}, undefined, 'note-highlight', {
              fill: '#f4ce53',
              'fill-opacity': '.4',
            })
            return { found: true }
          } catch {}
        }
        const sections: ReturnType<typeof document.spine.get>[] = []
        document.spine.each((section: ReturnType<typeof document.spine.get>) => sections.push(section))
        const matches: string[] = []
        for (const section of sections.slice(0, 1000)) {
          if (request !== locating.current || bookId !== callbacks.current.book?.id)
            return { found: false, message: '定位已取消。' }
          await section.load(document.load.bind(document))
          const body = section.document.body ?? section.document.documentElement
          const walker = section.document.createTreeWalker(body, 4)
          const nodes: { node: Node; start: number; end: number }[] = []
          let text = '',
            node: Node | null
          while ((node = walker.nextNode())) {
            const start = text.length
            text += node.textContent ?? ''
            nodes.push({ node, start, end: text.length })
          }
          for (const match of quoteMatches(text, anchor.quote ?? '', anchor.prefix, anchor.suffix)) {
            const start = nodes.find((item) => item.end > match.start),
              end = nodes.find((item) => item.end >= match.end)
            if (!start || !end) continue
            const range = section.document.createRange()
            range.setStart(start.node, match.start - start.start)
            range.setEnd(end.node, match.end - end.start)
            matches.push(section.cfiFromRange(range))
          }
          if (matches.length > 1) break
        }
        if (matches.length !== 1)
          return {
            found: false,
            message: matches.length ? '引文存在多处匹配，请检查版本。' : '此版本未找到引文，可重新关联原书。',
          }
        if (request !== locating.current || bookId !== callbacks.current.book?.id)
          return { found: false, message: '定位已取消。' }
        await instance.display(matches[0])
        instance.annotations.highlight(matches[0], {}, undefined, 'note-highlight', {
          fill: '#f4ce53',
          'fill-opacity': '.4',
        })
        return { found: true }
      },
    }),
    [props.book?.format, pageCount],
  )

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      if (width > 0 && height > 0 && (width !== observedSize.current.width || height !== observedSize.current.height)) {
        observedSize.current = { width, height }
        setViewportSize({ width, height })
        rendition.current?.resize(width, height)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (callbacks.current.active === false) return
      if ((event.target as HTMLElement)?.matches('input,select,textarea')) return
      if (event.key === 'ArrowRight') {
        if (callbacks.current.book?.format === 'pdf')
          setPageNumber((value) => Math.min(value + 1, pdf.current?.numPages ?? 1))
        else void rendition.current?.next()
      }
      if (event.key === 'ArrowLeft') {
        if (callbacks.current.book?.format === 'pdf') setPageNumber((value) => Math.max(1, value - 1))
        else void rendition.current?.prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let disposed = false
    let activeEpub: ReturnType<typeof ePub> | undefined
    let loadFinished = false
    const book = props.book
    setError('')
    setPercent(0)
    setPageCount(0)
    setPageNumber(1)
    setZoom(1)
    setHighlight(undefined)
    locating.current++
    callbacks.current.onReady(false)
    callbacks.current.onChapters([])
    if (!book) {
      setLoading(false)
      return
    }
    setLoading(true)
    const load = async () => {
      const bytes = await (callbacks.current.loadBytes ?? window.kindlespouse.preview)(book.id)
      if (disposed) return
      if (book.format === 'pdf') {
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes), enableXfa: false })
        pdfTask.current = task
        const document = await task.promise
        if (disposed) {
          await task.destroy()
          return
        }
        pdf.current = document
        setPageCount(document.numPages)
        const restored = book.location?.startsWith('pdf:') ? Number(book.location.slice(4)) : 1
        setPageNumber(Math.max(1, Math.min(document.numPages, restored)))
        callbacks.current.onChapters(
          Array.from({ length: document.numPages }, (_, index) => ({
            label: `第 ${index + 1} 页`,
            href: String(index + 1),
          })),
        )
        setPdfReady((value) => value + 1)
      } else {
        const buffer = new Uint8Array(bytes).buffer
        const document = ePub(buffer)
        activeEpub = document
        epub.current = document
        await Promise.all([document.ready, document.opened])
        if (disposed || !viewport.current) return
        const instance = document.renderTo(viewport.current, {
          width: viewport.current.clientWidth || 280,
          height: viewport.current.clientHeight || 374,
          flow: 'paginated',
          spread: 'none',
          allowScriptedContent: false,
        })
        await instance.q.enqueue(() => {})
        if (disposed) return
        rendition.current = instance
        const profile = callbacks.current.profile
        instance.themes.default({
          body: {
            'font-family': fonts[profile.font],
            'line-height': String(profile.lineHeight),
            padding: `8px ${profile.margin}px !important`,
            color: '#292a29',
            background: 'transparent',
          },
          p: { 'margin-top': '0', 'margin-bottom': '.6em' },
          img: { 'max-width': '100%', height: 'auto' },
          a: { color: 'inherit' },
        })
        instance.themes.fontSize(`${profile.fontSize}px`)
        instance.on('relocated', (location: { start: { cfi: string; percentage?: number; index?: number } }) => {
          if (disposed) return
          const percentage = location.start.percentage ?? (location.start.index ?? 0) / Math.max(1, book.chapters)
          setPercent(percentage)
          callbacks.current.onLocation(location.start.cfi, percentage)
        })
        const navigation = await document.loaded.navigation
        if (disposed) return
        const convert = (items: { label: string; href: string; subitems?: unknown[] }[]): Chapter[] =>
          items.flatMap((item) => [
            { label: item.label.trim(), href: item.href },
            ...(item.subitems?.length ? convert(item.subitems as typeof items) : []),
          ])
        callbacks.current.onChapters(convert(navigation.toc))
        await instance
          .display(book.location?.startsWith('epubcfi(') ? book.location : undefined)
          .catch(() => instance.display())
        if (!disposed) {
          setLoading(false)
          callbacks.current.onReady(true)
        }
      }
    }
    void load()
      .catch((failure) => {
        if (!disposed) {
          setError(failure instanceof Error ? failure.message : '无法打开这份文件。')
          setLoading(false)
          callbacks.current.onReady(false)
        }
      })
      .finally(() => {
        loadFinished = true
        if (disposed) activeEpub?.destroy()
      })
    return () => {
      disposed = true
      if (loadFinished) activeEpub?.destroy()
      if (epub.current === activeEpub) {
        epub.current = null
        rendition.current = null
      }
      void pdfTask.current?.destroy()
      pdfTask.current = null
      pdf.current = null
    }
  }, [props.book?.id])

  useEffect(() => {
    const instance = rendition.current
    if (!instance) return
    instance.themes.font(fonts[props.profile.font])
    instance.themes.fontSize(`${props.profile.fontSize}px`)
    instance.themes.override('line-height', String(props.profile.lineHeight))
    instance.themes.default({
      body: {
        'line-height': String(props.profile.lineHeight),
        padding: `8px ${props.profile.margin}px !important`,
        color: '#292a29',
        background: 'transparent',
      },
    })
  }, [props.profile])

  useEffect(() => {
    if (props.book?.format !== 'pdf' || !pdf.current || !canvas.current) return
    let disposed = false
    let renderTask: pdfjs.RenderTask | undefined
    const render = async () => {
      const page = await pdf.current!.getPage(pageNumber)
      if (disposed || !canvas.current) return
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(viewportSize.width / base.width, viewportSize.height / base.height) * zoom
      const view = page.getViewport({ scale: scale * window.devicePixelRatio })
      const element = canvas.current
      element.width = view.width
      element.height = view.height
      element.style.width = `${view.width / window.devicePixelRatio}px`
      element.style.height = `${view.height / window.devicePixelRatio}px`
      renderTask = page.render({ canvas: element, viewport: view })
      await renderTask.promise
      if (disposed) return
      if (highlight?.page === pageNumber && highlight.quote) {
        const text = await page.getTextContent()
        if (disposed) return
        const items = text.items.filter((item) => 'str' in item)
        const full = items.map((item) => item.str).join(' ')
        const match = quoteMatches(full, highlight.quote)[0]
        if (match) {
          let cursor = 0
          const context = element.getContext('2d')!
          context.fillStyle = 'rgba(245, 202, 57, .28)'
          for (const item of items) {
            const end = cursor + item.str.length
            if (end > match.start && cursor < match.end) {
              const transform = pdfjs.Util.transform(view.transform, item.transform)
              const height = Math.hypot(transform[2], transform[3])
              context.fillRect(transform[4], transform[5] - height, item.width * view.scale, height * 1.2)
            }
            cursor = end + 1
          }
        }
      }
      setLoading(false)
      callbacks.current.onReady(true)
      const progress = (pageNumber - 1) / Math.max(1, pdf.current!.numPages - 1)
      setPercent(progress)
      callbacks.current.onLocation(`pdf:${pageNumber}`, progress)
    }
    void render().catch((failure) => {
      if (!disposed && failure?.name !== 'RenderingCancelledException') {
        setError(String(failure))
        setLoading(false)
        callbacks.current.onReady(false)
      }
    })
    return () => {
      disposed = true
      renderTask?.cancel()
    }
  }, [props.book?.id, pdfReady, pageNumber, zoom, viewportSize, highlight])

  const turn = (direction: number) => {
    if (props.book?.format === 'pdf') setPageNumber((value) => Math.max(1, Math.min(pageCount, value + direction)))
    else if (direction > 0) void rendition.current?.next()
    else void rendition.current?.prev()
  }

  return (
    <section className="reader-card" aria-label="仿 Kindle 阅读器">
      <div className="reader-stage">
        <div className={`kindle-bezel ${props.profile.paper === 'white' ? 'white-paper' : ''}`}>
          <div className={`paper-viewport ${props.book?.format === 'pdf' ? 'pdf-viewport' : ''}`}>
            <div
              ref={viewport}
              className={`epub-viewport ${!props.book || props.book.format === 'pdf' ? 'not-visible' : ''}`}
              data-testid="epub-viewport"
            />
            {props.book?.format === 'pdf' && (
              <div className="pdf-canvas-wrap">
                <canvas ref={canvas} aria-label={`PDF 第 ${pageNumber} 页`} />
              </div>
            )}
            {!props.book && (
              <div className="reader-welcome">
                <BookOpen size={32} strokeWidth={1.3} />
                <h2>打开一本书</h2>
                <button onClick={props.onImport}>
                  导入书籍 <ChevronRight size={14} />
                </button>
              </div>
            )}
            {loading && (
              <div className="paper-overlay">
                <LoaderCircle className="spin" size={24} />
                <span>正在准备试读</span>
              </div>
            )}
            {error && (
              <div className="paper-overlay reader-error">
                <BookOpen size={24} />
                <strong>这份书暂时打不开</strong>
                <p>{error}</p>
                <span>可以更换版本后再试读。</span>
              </div>
            )}
            {props.book && !loading && !error && (
              <div className="paper-footer">
                <span>{props.book.format.toUpperCase()}</span>
                <span>
                  {props.book.format === 'pdf' ? `${pageNumber} / ${pageCount}` : `${Math.round(percent * 100)}%`}
                </span>
              </div>
            )}
          </div>
          <span className="bezel-wordmark">kindlespouse</span>
        </div>
      </div>
      <div className="reader-toolbar">
        <button
          className="icon-button"
          aria-label="上一页"
          disabled={!props.book || loading || Boolean(error)}
          onClick={() => turn(-1)}
        >
          <ChevronLeft size={19} />
        </button>
        {props.book?.format === 'pdf' && (
          <select
            className="pdf-page-select"
            aria-label="跳转 PDF 页码"
            value={pageNumber}
            disabled={!pageCount || loading}
            onChange={(event) => setPageNumber(Number(event.target.value))}
          >
            {Array.from({ length: pageCount }, (_, index) => (
              <option key={index + 1} value={index + 1}>
                第 {index + 1} 页
              </option>
            ))}
          </select>
        )}
        <button
          className="icon-button"
          aria-label="下一页"
          disabled={!props.book || loading || Boolean(error)}
          onClick={() => turn(1)}
        >
          <ChevronRight size={19} />
        </button>
      </div>
    </section>
  )
})

const Reader = forwardRef<ReaderHandle, ReaderProps>(function Reader(props, ref) {
  const native = !props.browserOnly && !props.loadBytes && usesKoreader(props.book?.format, props.engine ?? 'browser')
  return native ? <KoreaderReader {...props} ref={ref} /> : <BrowserReader {...props} ref={ref} />
})
export default Reader
