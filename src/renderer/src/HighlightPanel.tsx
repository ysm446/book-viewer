import type { Highlight } from './api'
import { HL_COLORS } from './highlightAnchor'
import type { HighlightPlace } from './TextView'

interface Props {
  highlights: Highlight[]
  /** テキスト表示で付け直した場所(id → 場所 / 見つからなければ null。まだ付け直していない本は空) */
  places: Record<number, HighlightPlace | null>
  onJump: (h: Highlight) => void
  onDelete: (h: Highlight) => void
}

/** 一覧の並びとページ。付け直した場所があればそちら、無ければ作ったときの場所。 */
function placeOf(h: Highlight, places: Props['places']): { page: number; block: number; lost: boolean } {
  const p = places[h.id]
  const first = h.parts[0]
  if (p) return { page: p.page, block: p.block, lost: false }
  return { page: first.page, block: first.block, lost: p === null }
}

/** ハイライトの一覧(本の中の順)。行をクリックでその場所へ移動する。 */
export function HighlightPanel({ highlights, places, onJump, onDelete }: Props): JSX.Element {
  const rows = highlights
    .map((h) => ({ h, at: placeOf(h, places) }))
    .sort((a, b) => a.at.page - b.at.page || a.at.block - b.at.block || a.h.parts[0].start - b.h.parts[0].start)

  return (
    <div className="reader-info hl-panel">
      <div className="reader-info-head">
        <span className="reader-info-title">ハイライト</span>
        {highlights.length > 0 && <span className="reader-info-note">{highlights.length} 件</span>}
      </div>
      {rows.length === 0 ? (
        <div className="reader-info-empty">
          ハイライトはありません。テキスト表示で本文を選ぶと、色やメモを付けられます。
        </div>
      ) : (
        <ul className="hl-list">
          {rows.map(({ h, at }) => (
            <li key={h.id} className="hl-item">
              <button className="hl-row" onClick={() => onJump(h)} title="この場所へ移動">
                <span
                  className={`hl-mark hl-swatch-${h.color}`}
                  aria-label={`${HL_COLORS.find((c) => c.value === h.color)?.label ?? ''}のハイライト`}
                />
                <span className="hl-body">
                  <span className="hl-text">{h.text}</span>
                  {h.note && <span className="hl-note">{h.note}</span>}
                </span>
                <span className="hl-meta">
                  <span className="toc-pages">p.{at.page + 1}</span>
                  {at.lost && (
                    <span
                      className="text-page-badge"
                      title="本文が変わって、元の場所が見つかりません（作ったときのページへ移動します）"
                    >
                      位置ずれ
                    </span>
                  )}
                </span>
              </button>
              <button
                className="icon-btn hl-del"
                onClick={() => onDelete(h)}
                aria-label="ハイライトを削除"
                title="削除"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
