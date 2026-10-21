import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { KoreaderFrame } from './shared'
import { drawPageTurn, type PageTurnDirection, type PageTurnStyle } from './page-turn'

export interface NativePageHandle {
  show: (frame: KoreaderFrame, direction?: PageTurnDirection) => Promise<boolean>
  clear: () => void
}

type Picture = { url: string; image: HTMLImageElement; frame: KoreaderFrame }

const NativePage = forwardRef<NativePageHandle, { active: boolean; style: PageTurnStyle }>(function NativePage(props, ref) {
  const [picture, setPicture] = useState<Picture>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const current = useRef<Picture>(undefined)
  const sequence = useRef(0)
  const urls = useRef(new Set<string>())
  const cancel = useRef<() => void>(() => {})
  const options = useRef(props)
  options.current = props
  const release = (url: string) => { URL.revokeObjectURL(url); urls.current.delete(url) }
  const clear = () => {
    sequence.current++
    cancel.current()
    current.current = undefined
    for (const url of urls.current) release(url)
    setPicture(undefined)
  }
  useImperativeHandle(ref, () => ({
    clear,
    show: async (frame, direction = 0) => {
      const request = ++sequence.current
      cancel.current()
      const url = URL.createObjectURL(new Blob([frame.image as BlobPart], { type: 'image/png' }))
      urls.current.add(url)
      const image = new Image()
      image.src = url
      try { await image.decode() }
      catch (error) { release(url); if (sequence.current === request) throw error; return false }
      if (sequence.current !== request) { release(url); return false }
      const previous = current.current
      const next = { url, image, frame }
      const surface = canvas.current
      const style = options.current.style
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      const animate = previous && previous.frame.page !== frame.page && direction && options.current.active && style !== 'none' && !reduced.matches
      const context = animate ? surface?.getContext('2d', { alpha: false }) : undefined
      if (context && surface && previous) {
        surface.hidden = false
        const bounds = surface.getBoundingClientRect()
        const scale = Math.min(window.devicePixelRatio || 1, 2)
        surface.width = Math.max(1, Math.ceil(bounds.width * scale))
        surface.height = Math.max(1, Math.ceil(bounds.height * scale))
        drawPageTurn(context, previous.image, image, 0, direction, style)
      }
      current.current = next
      setPicture(next)
      const finished = await new Promise<boolean>(resolve => {
        let animation = 0
        let start: number | undefined
        const finish = (result: boolean) => {
          cancelAnimationFrame(animation)
          if (surface) surface.hidden = true
          cancel.current = () => {}
          resolve(result)
        }
        cancel.current = () => finish(false)
        const step = (now: number) => {
          if (sequence.current !== request) { finish(false); return }
          if (start === undefined) { start = now; animation = requestAnimationFrame(step); return }
          const progress = context && options.current.active && !reduced.matches ? Math.min(1, (now - start) / (style === 'paper' ? 380 : 170)) : 1
          if (context && previous) drawPageTurn(context, previous.image, image, progress * progress * (3 - 2 * progress), direction, style)
          if (progress < 1) animation = requestAnimationFrame(step)
          else finish(true)
        }
        animation = requestAnimationFrame(step)
      })
      if (previous) release(previous.url)
      return finished
    },
  }))
  useEffect(() => () => { sequence.current++; cancel.current(); for (const url of urls.current) release(url) }, [])
  return <>
    {picture && <img className="native-reader-page" src={picture.url} alt={`KOReader 第 ${picture.frame.page} 页，共 ${picture.frame.pages} 页`} draggable={false} />}
    <canvas ref={canvas} className="native-page-turn" aria-hidden="true" hidden />
  </>
})
export default NativePage
