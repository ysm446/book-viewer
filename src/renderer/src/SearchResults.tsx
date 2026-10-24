import { useEffect, useRef, useState } from 'react'
import { searchPassages, thumbnailUrl, type PassageHit, type PassageSearch, type Work } from './api'
import { useStoredFlag } from './useStoredFlag'

interface Props {
  root: string
  /** 出しているか(閉じても隠すだけにして、結果とスクロール位置を残す) */
  open: boolean
  /** 検索語(一覧の検索欄と共通) */
  query: string
  onQueryChange: (q: string) => void
  /** 今開いている本(「この本」で絞り込める) */
  current: Work | null
  /** 開いたときに入力欄へフォーカスを移すための合図(開くたびに変わる) */
  focusKey: number
  /** 箇所を開く(その本のそのページ・段落へ移動し、語をハイライトする) */
  onOpenHit: (workId: string, hit: PassageHit, terms: string[]) => void
  onClose: () => void
}

type Scope = 'all' | 'book'

/** 抜粋のうち一致した語を太字にする。位置は文字(コードポイント)の数え方(Python と同じ)。 */
function Marked({
  text,
  marks,
  className
}: {
  text: string
  marks: [number, number][]
  className: string
}): JSX.Element {
  const chars = Array.from(text)
  const out: (string | JSX.Element)[] = []
  let at = 0
  marks.forEach(([s, e], i) => {
    if (s > at) out.push(chars.slice(at, s).join(''))
    out.push(<strong key={i}>{chars.slice(s, e).join('')}</strong>)
    at = e
  })
  out.push(chars.slice(at).join(''))
  return <span className={className}>{out}</span>
}

/**
 * 本文の検索結果(右ペインに重ねて出す)。一致した段落を本ごとにまとめて並べ、クリックでその箇所を開く。
 * 閉じても消さずに隠しておき、開き直したときに同じ結果とスクロール位置へ戻る。
 */
export function SearchResults({
  root,
  open,
  query,
  onQueryChange,
  current,
  focusKey,
  onOpenHit,
  onClose
}: Props): JSX.Element {
  const [scope, setScope] = useState<Scope>('all')
  // 英語の本の箇所に日本語訳を添えるか(次回も同じ)
  const [showJa, setShowJa] = useStoredFlag('searchShowJa', true)
  const [result, setResult] = useState<PassageSearch | null>(null)
  const [loading, setLoading] = useState(false)
  // 検索に時間がかかっている(最初の 1 回は意味で探すモデルの読み込みで 10 秒ほどかかる)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 「すべて表示」で取り直した本の全件
  const [expanded, setExpanded] = useState<Record<string, PassageHit[] | 'loading'>>({})
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusKey])

  // 開いている本が無くなったら「この本」は選べない
  const bookId = scope === 'book' && current ? current.id : undefined

  // 入力をデバウンスして検索する。古い応答で上書きしない。
  // 閉じているときは探さない(一覧の検索欄の入力ごとに段落の検索が走らないように)。開いたときに探す。
  const queryRef = useRef(query)
  queryRef.current = query
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    setExpanded({})
    if (q === '') {
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }
    let stale = false
    setLoading(true)
    const id = setTimeout(async () => {
      try {
        const res = await searchPassages(root, q, bookId)
        if (stale) return
        setResult(res)
        setError(null)
        listRef.current?.scrollTo({ top: 0 })
      } catch (e) {
        if (!stale) setError((e as Error).message)
      } finally {
        if (!stale) setLoading(false)
      }
    }, 300)
    return () => {
      stale = true
      clearTimeout(id)
    }
  }, [open, root, query, bookId])

  useEffect(() => {
    setSlow(false)
    if (!loading) return
    const id = setTimeout(() => setSlow(true), 1500)
    return () => clearTimeout(id)
  }, [loading])

  async function expand(workId: string): Promise<void> {
    const q = query.trim()
    setExpanded((m) => ({ ...m, [workId]: 'loading' }))
    try {
      const res = await searchPassages(root, q, workId)
      // 返ってくる前に語が変わっていたら、古い語の結果を混ぜない。
      if (queryRef.current.trim() !== q) return
      setExpanded((m) => ({ ...m, [workId]: res.books[0]?.hits ?? [] }))
    } catch (e) {
      setExpanded((m) => {
        const { [workId]: _, ...rest } = m
        return rest
      })
      setError((e as Error).message)
    }
  }

  // 上下の矢印で入力欄と結果のあいだを移る。Escape で閉じる。
  // 裏のリーダーへキーを渡さない(リーダーは window でページ送りのキーを受けている)。
  function onKeyDown(e: React.KeyboardEvent): void {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.search-hit') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    if (e.key === 'ArrowDown') {
      items[i < 0 ? 0 : Math.min(i + 1, items.length - 1)]?.focus()
    } else if (i <= 0) {
      inputRef.current?.focus()
    } else {
      items[i - 1]?.focus()
    }
  }

  const terms = result?.terms ?? []
  const books = result?.books ?? []
  // 「訳を併記」で消せる訳(原文で一致した箇所に添えた訳)があるか。訳文で一致した箇所の訳は常に出す
  const hasJa = [...books.map((b) => b.hits), ...Object.values(expanded)].some(
    (hits) => Array.isArray(hits) && hits.some((h) => h.ja && h.ja_marks.length === 0)
  )

  return (
    // 開いている間は aria-modal にして、裏のリーダーのキー操作を止める(Reader が見ている)
    <div
      className="search-page"
      role="dialog"
      aria-modal={open ? 'true' : undefined}
      aria-label="本文の検索"
      hidden={!open}
      onKeyDown={onKeyDown}
    >
      <div className="search-head">
        <input
          ref={inputRef}
          className="search-input search-page-input"
          type="search"
          placeholder="本文から探す（語でも、言い換えた文でも）"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {current && (
          <div className="seg" role="group" aria-label="検索する範囲">
            <button
              className={`seg-btn ${scope === 'all' ? 'seg-active' : ''}`}
              onClick={() => setScope('all')}
            >
              すべての本
            </button>
            <button
              className={`seg-btn ${scope === 'book' ? 'seg-active' : ''}`}
              onClick={() => setScope('book')}
              title={current.title}
            >
              この本
            </button>
          </div>
        )}
        {hasJa && (
          <button
            className={`btn search-ja-btn ${showJa ? 'btn-active' : ''}`}
            aria-pressed={showJa}
            onClick={() => setShowJa((v) => !v)}
            title="英語の本の箇所に、一致した文の日本語訳を添える（訳してある段落だけ）"
          >
            訳を併記
          </button>
        )}
        <span className="search-count">
          {loading
            ? '検索中…'
            : result && query.trim() !== ''
              ? `${result.total}${result.capped ? '+' : ''} 件 ・ ${books.length} 冊`
              : ''}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="検索を閉じる" title="検索を閉じる（Esc）">
          ✕
        </button>
      </div>

      <div className="search-list" ref={listRef}>
        {loading && query.trim() !== '' && (
          <div className="search-loading" role="status">
            <span className="queue-spin" />
            <span>
              検索中…
              {slow && (
                <span className="search-loading-hint">
                  はじめての検索は、意味で探すモデルを読み込むため 10 秒ほどかかります。
                </span>
              )}
            </span>
          </div>
        )}
        {error && <div className="search-note is-error">検索できませんでした: {error}</div>}
        {query.trim() !== '' && result?.semantic?.error && (
          <div className="search-note is-error">
            意味の近さでは探せませんでした（語の一致だけの結果です）: {result.semantic.error}
          </div>
        )}
        {query.trim() !== '' &&
          result?.semantic &&
          !result.semantic.error &&
          result.semantic.indexed < result.semantic.books && (
            <div className="search-note">
              意味の近さで探したのは、段落の索引のある {result.semantic.indexed} / {result.semantic.books} 冊です
              （文字起こしのあと自動で作ります）。
            </div>
          )}
        {query.trim() === '' ? (
          <div className="search-note">
            文字起こしした本文から、語の一致する段落と、意味の近い段落を探します（「雲ができる仕組み」のような文でも探せます）。
            <br />
            空白で区切るとすべての語を含む段落、"…" で囲むと空白を含む語。英語の本は日本語の語・文でも探せます。
            <br />
            結果を開くと、その段落へ移動して語をハイライトします。
            <br />
            Ctrl+F でこの画面を開き、Esc で閉じます。
          </div>
        ) : (
          result &&
          !loading &&
          books.length === 0 && (
            <div className="search-note">
              「{query.trim()}」に一致する段落はありません。
              <br />
              文字起こしが済んだページだけが対象です。
            </div>
          )
        )}
        {/* 検索中は前の結果を薄くする(新しい結果が届いたら差し替わる) */}
        <div className={`search-books ${loading ? 'is-stale' : ''}`}>
          {books.map((b) => {
            const more = expanded[b.work_id]
            const hits = Array.isArray(more) ? more : b.hits
            return (
              <section key={b.work_id} className="search-book">
                <div className="search-book-head">
                  <span className="ex-thumb search-book-thumb">
                    <img src={thumbnailUrl(root, b.work_id)} alt="" loading="lazy" draggable={false} />
                  </span>
                  <span className="search-book-title" title={b.title}>
                    {b.title}
                  </span>
                  {b.author && <span className="search-book-author">{b.author}</span>}
                  <span className="search-book-count">{b.count} 件</span>
                </div>
                <ul className="search-hits">
                  {hits.map((h) => (
                    <li key={`${h.block}-${h.page}`}>
                      <button className="search-hit" onClick={() => onOpenHit(b.work_id, h, terms)}>
                        <span className="search-hit-meta">
                          <span className="search-hit-page">p.{h.page + 1}</span>
                          {h.chapter && <span className="search-hit-chapter">{h.chapter}</span>}
                          {h.match === 'meaning' && (
                            <span className="text-page-badge" title="語は一致していませんが、意味の近い段落です">
                              意味が近い
                            </span>
                          )}
                          {h.ahead && (
                            <span className="text-page-badge" title="今の読書位置より先の箇所です">
                              未読
                            </span>
                          )}
                        </span>
                        <Marked text={h.snippet} marks={h.marks} className="search-snippet" />
                        {h.ja && (showJa || h.ja_marks.length > 0) && (
                          <Marked text={h.ja} marks={h.ja_marks} className="search-snippet-ja" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                {/* 取り直した全件は意味の近さで拾う数が違うので、件数がそろわなくても一度だけ出す */}
                {!Array.isArray(more) && b.count > hits.length && (
                  <button
                    className="btn search-more"
                    disabled={more === 'loading'}
                    onClick={() => void expand(b.work_id)}
                  >
                    {more === 'loading' ? '読み込み中…' : `この本の ${b.count} 件をすべて表示（ページ順）`}
                  </button>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
