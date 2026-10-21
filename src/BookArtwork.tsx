import { useEffect, useState } from 'react'

export default function BookArtwork({ title, author, cover, identity, format }: { title: string; author?: string; cover?: string; identity: string; format?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [cover])
  const tone = [...identity].reduce((value, letter) => value + letter.charCodeAt(0), 0) % 6
  return <div className="book-artwork" data-tone={tone}>
    {cover && !failed ? <img src={cover} alt={`${title}封面`} onError={() => setFailed(true)} /> : <div className="artwork-fallback">
      <span className="artwork-format">{format?.toUpperCase() ?? 'BOOK'}</span>
      <strong>{title}</strong>
      {author && <span className="artwork-author">{author}</span>}
    </div>}
  </div>
}
