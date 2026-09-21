import { useEffect, useRef, useState } from 'react'
import { pageUrl, type Bookmark } from './api'

interface PageScrubberProps {
  root: string
  workId: string
  count: number
  /** 現在の先頭ページ */
  page: number
  /** 右開きならスライダーも右→左にする */
  rtl: boolean
  bookmarks: Bookmark[]
  /** 下端ホバーで表示(ドラッグ中は強制表示) */
  visible: boolean
  onSeek: (page: number) => void
}

/**
 * ページ画像の上に重ねるオーバーレイ式のページスクラバー。
 * レイアウト高さを取らず、下端に近づいたときだけ表示する。
 */
export function PageScrubber({
  root,
  workId,
  count,
  page,
  rtl,
  bookmarks,
  visible,
  onSeek
}: PageScrubberProps): JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [pointerPage, setPointerPage] = useState<number | null>(null)
  const [previewPage, setPreviewPage] = useState<number | null>(null)

  const pageFromClientX = (clientX: number): number => {
    const el = trackRef.current
    if (!el || count <= 1) return 0
    const r = el.getBoundingClientRect()
    let ratio = (clientX - r.left) / r.width
    ratio = Math.min(1, Math.max(0, ratio))
    const idx = Math.round((rtl ? 1 - ratio : ratio) * (count - 1))
    return Math.min(count - 1, Math.max(0, idx))
  }

  const posPct = (p: number): number => {
    if (count <= 1) return 0
    const ratio = p / (count - 1)
    return (rtl ? 1 - ratio : ratio) * 100
  }

  // プレビュー画像は読み込み負荷を抑えるため、少し止まってから読み込む。
  useEffect(() => {
    if (pointerPage == null) {
      setPreviewPage(null)
      return
    }
    const t = setTimeout(() => setPreviewPage(pointerPage), 100)
    return () => clearTimeout(t)
  }, [pointerPage])

  // ドラッグはトラック外でも追従させ、離した位置で確定する。
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => setPointerPage(pageFromClientX(e.clientX))
    const up = (e: MouseEvent): void => {
      onSeek(pageFromClientX(e.clientX))
      setDragging(false)
      setPointerPage(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  if (count <= 1) return null

  const thumbPage = dragging && pointerPage != null ? pointerPage : page
  const previewLeft = previewPage == null ? 0 : Math.min(92, Math.max(8, posPct(previewPage)))

  return (
    <div className={`scrubber ${visible || dragging ? 'is-visible' : ''}`}>
      {previewPage != null && (
        <div className="scrubber-preview" style={{ left: `${previewLeft}%` }}>
          <img src={pageUrl(root, workId, previewPage)} alt="" draggable={false} />
          <span className="scrubber-preview-page">{previewPage + 1}</span>
        </div>
      )}
      <div
        className="scrubber-track"
        ref={trackRef}
        onMouseDown={(e) => {
          e.preventDefault()
          setDragging(true)
          setPointerPage(pageFromClientX(e.clientX))
        }}
        onMouseMove={(e) => {
          if (!dragging) setPointerPage(pageFromClientX(e.clientX))
        }}
        onMouseLeave={() => {
          if (!dragging) setPointerPage(null)
        }}
      >
        {bookmarks.map((b) => (
          <span key={b.id} className="scrubber-tick" style={{ left: `${posPct(b.page)}%` }} />
        ))}
        <span className="scrubber-thumb" style={{ left: `${posPct(thumbPage)}%` }} />
      </div>
      <div className="scrubber-label">
        {(pointerPage ?? page) + 1} / {count}
      </div>
    </div>
  )
}
