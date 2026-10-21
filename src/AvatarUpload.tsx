import { useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'

export default function AvatarUpload({ image, onChange }: { image: string; onChange: (image: string) => void }) {
  const [source, setSource] = useState<HTMLImageElement>()
  const [zoom, setZoom] = useState(1), [x, setX] = useState(0), [y, setY] = useState(0), [error, setError] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const changed = useRef(onChange)
  changed.current = onChange
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (!source || !canvas.current) return
    const size = Math.min(source.naturalWidth, source.naturalHeight) / zoom
    const left = (source.naturalWidth - size) * (x + 1) / 2
    const top = (source.naturalHeight - size) * (y + 1) / 2
    const context = canvas.current.getContext('2d')!
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 256, 256)
    context.drawImage(source, left, top, size, size, 0, 0, 256, 256)
    changed.current(canvas.current.toDataURL('image/png'))
  }, [source, zoom, x, y])
  return <div className="avatar-upload">
    <div className="button-group"><label className="button avatar-file-button"><Upload size={15} />{image ? '更换头像' : '上传头像'}<input type="file" aria-label="上传头像文件" accept="image/png,image/jpeg,image/webp" onChange={async event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      const current = ++generation.current
      setError('')
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) { setError('请选择 8 MB 以内的 JPG、PNG 或 WebP 图片。'); return }
      const url = URL.createObjectURL(file)
      try {
        const next = new Image()
        next.src = url
        await next.decode()
        if (current !== generation.current) return
        if (next.naturalWidth * next.naturalHeight > 40000000) throw new Error('图片尺寸过大，请选择较小的图片。')
        setZoom(1); setX(0); setY(0); setSource(next)
      } catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : '无法读取图片。') }
      finally { URL.revokeObjectURL(url) }
    }} /></label>
      {image && <button className="text-button" type="button" onClick={() => { generation.current++; setSource(undefined); onChange(''); setError('') }}>移除照片</button>}
    </div>
    {source && <div className="avatar-crop-editor"><canvas ref={canvas} width={256} height={256} aria-label="头像裁切预览" /><div>
      <label>缩放<input aria-label="头像缩放" type="range" min="1" max="3" step="0.02" value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label>
      <label>左右<input aria-label="头像水平位置" type="range" min="-1" max="1" step="0.02" value={x} onChange={event => setX(Number(event.target.value))} /></label>
      <label>上下<input aria-label="头像垂直位置" type="range" min="-1" max="1" step="0.02" value={y} onChange={event => setY(Number(event.target.value))} /></label>
    </div></div>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <small className="field-hint">支持 JPG、PNG、WebP。调整后点击保存；Kindle 会使用适合墨水屏的灰度头像。</small>
  </div>
}
