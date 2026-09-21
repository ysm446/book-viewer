import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelJob,
  enqueueTranscribe,
  figureUrl,
  getQueue,
  getPageText,
  getTextPages,
  pageUrl,
  savePageText,
  type LowLine,
  type PageText,
  type TranscribeEngine,
  type Work
} from './api'
import { Markdown } from './Markdown'

interface Props {
  root: string
  work: Work
  /** 表示するページ(0 始まり、昇順)。見開き表示なら 2 枚。 */
  pages: number[]
  /** 縦書きで組むか(本の書字方向) */
  vertical: boolean
  /** 文字起こしのエンジン(設定) */
  engine: TranscribeEngine
}

/** 本文中の図の参照(../figures/p0001-1.png)だけを表示する。それ以外は読み込まない。 */
const FIGURE_SRC_RE = /^\.\.\/figures\/(p\d{4}-\d+\.png)$/

type Job = { state: 'queued' | 'running'; current: number; total: number } | null

/** 編集中のページ(原本と見比べて本文を直す)。 */
interface Editing {
  page: number
  draft: string
  low: LowLine[]
}

/**
 * リーダーのテキスト表示。本フォルダの pages/*.md を Markdown として描画し、
 * 未処理のページは文字起こしをジョブキューへ積める。縦書きの本は縦書きで組む。
 */
export function TextView({ root, work, pages, vertical, engine }: Props): JSX.Element {
  const [texts, setTexts] = useState<Record<number, PageText | null>>({})
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const [done, setDone] = useState<Set<number> | null>(null)
  const [job, setJob] = useState<Job>(null)
  const [error, setError] = useState<string | null>(null)

  const loadText = useCallback(
    (p: number): void => {
      getPageText(root, work.id, p)
        .then((t) => setTexts((m) => ({ ...m, [p]: t })))
        .catch((e) => setError((e as Error).message))
    },
    [root, work.id]
  )

  const refreshDone = useCallback(async (): Promise<Set<number>> => {
    const list = new Set(await getTextPages(root, work.id))
    setDone(list)
    return list
  }, [root, work.id])

  useEffect(() => {
    refreshDone().catch((e) => setError((e as Error).message))
  }, [refreshDone])

  // 表示ページの本文を読み込む(未取得のものだけ)。
  const textsRef = useRef(texts)
  textsRef.current = texts
  useEffect(() => {
    pages.forEach((p) => {
      if (!(p in textsRef.current)) loadText(p)
    })
  }, [pages, loadText])

  // キューを監視し、この本の文字起こしの進み具合を反映する。
  // 進むたびに済みページを取り直し、表示中で未取得だったページは本文を読み込み直す。
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const polling = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const watch = useCallback((): void => {
    if (polling.current) return
    polling.current = true
    let lastCurrent = -1
    const tick = async (): Promise<void> => {
      if (!alive.current) {
        polling.current = false
        return
      }
      try {
        const q = await getQueue()
        const cur = q.current?.work_id === work.id && q.current.kind === 'transcribe' ? q.current : null
        const pending = q.pending.some((j) => j.work_id === work.id && j.kind === 'transcribe')
        if (cur) setJob({ state: 'running', current: cur.current, total: cur.total })
        else if (pending) setJob({ state: 'queued', current: 0, total: 0 })
        const progressed = cur ? cur.current !== lastCurrent : true
        lastCurrent = cur ? cur.current : -1
        if (progressed) {
          const list = await refreshDone()
          pagesRef.current.forEach((p) => {
            if (list.has(p) && !textsRef.current[p]) loadText(p)
          })
        }
        if (!cur && !pending) {
          const recent = q.recent.filter((r) => r.work_id === work.id && r.kind === 'transcribe')
          const last = recent[recent.length - 1]
          if (last?.status === 'error') setError(last.error ?? '文字起こしに失敗しました')
          // やり直したページもあるので、表示中のページは終了時に必ず読み込み直す。
          pagesRef.current.forEach(loadText)
          setJob(null)
          polling.current = false
          return
        }
      } catch {
        // 一時的な取得失敗は次の周期で取り直す
      }
      setTimeout(() => void tick(), 1500)
    }
    void tick()
  }, [work.id, refreshDone, loadText])

  // 開いた時点で既に文字起こし中なら進み具合を追う。
  useEffect(() => {
    getQueue()
      .then((q) => {
        const active =
          (q.current?.work_id === work.id && q.current.kind === 'transcribe') ||
          q.pending.some((j) => j.work_id === work.id && j.kind === 'transcribe')
        if (active) watch()
      })
      .catch(() => {})
  }, [work.id, watch])

  async function transcribe(target?: number[], force = false): Promise<void> {
    setError(null)
    try {
      await enqueueTranscribe(root, work.id, { pages: target, force, engine })
      setJob({ state: 'queued', current: 0, total: 0 })
      watch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function startEdit(p: number): void {
    const t = texts[p]
    if (!t) return
    setError(null)
    setEditing({ page: p, draft: t.markdown, low: t.low })
  }

  // 要確認の行を編集欄で選択し、そこまでスクロールする。
  function selectLow(text: string): void {
    const area = areaRef.current
    if (!area || !editing) return
    const at = editing.draft.indexOf(text)
    if (at < 0) return
    // いったん外してから focus し直すと、選択位置までスクロールされる。
    area.blur()
    area.setSelectionRange(at, at + text.length)
    area.focus()
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      const saved = await savePageText(root, work.id, editing.page, editing.draft)
      setTexts((m) => ({ ...m, [editing.page]: saved }))
      setEditing(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // 表示ページが変わったら編集を閉じる(別のページの原本と取り違えないように)。
  useEffect(() => {
    setEditing((e) => (e && !pages.includes(e.page) ? null : e))
  }, [pages])

  const doneCount = done?.size ?? 0
  const remaining = work.page_count - doneCount
  const pct = job && job.total > 0 ? Math.round((job.current / job.total) * 100) : 0

  return (
    <div className="text-view">
      <div className="text-toolbar">
        <span className="text-toolbar-note">
          文字起こし済み {doneCount} / {work.page_count}
        </span>
        {job ? (
          <>
            <span className="analyze-bar text-toolbar-bar">
              <span className="analyze-bar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="text-toolbar-note">
              {job.state === 'queued' ? '順番待ち…' : `文字起こし中 ${job.current}/${job.total}`}
            </span>
            <button className="btn" onClick={() => void cancelJob(work.id)}>
              中止
            </button>
          </>
        ) : (
          remaining > 0 && (
            <button
              className="btn"
              onClick={() => void transcribe()}
              title={
                engine === 'vlm'
                  ? 'まだ文字起こししていないページを先頭から順に処理します（Vision LLM の読み込みが必要）'
                  : 'まだ文字起こししていないページを先頭から順に処理します'
              }
            >
              残り {remaining} ページを文字起こし
            </button>
          )
        )}
        <span className="text-toolbar-spacer" />
        {doneCount > 0 && (
          <button
            className="btn"
            onClick={() => {
              if (
                window.confirm(
                  `全 ${work.page_count} ページを文字起こしし直します（手で直したページはそのまま残します）。よろしいですか？`
                )
              ) {
                void transcribe(undefined, true)
              }
            }}
            disabled={!!job}
            title="文字起こしの改良を反映させたいときに、すべてのページを作り直します"
          >
            全ページやり直す
          </button>
        )}
        <button
          className="btn"
          onClick={() => void transcribe(pages, true)}
          disabled={!!job}
          title="表示中のページを文字起こしし直します"
        >
          このページをやり直す
        </button>
      </div>
      {error && <div className="text-error">エラー: {error}</div>}
      {editing ? (
        <div className="text-edit">
          <div className={`text-edit-image ${zoom ? 'is-zoomed' : ''}`}>
            <img
              src={pageUrl(root, work.id, editing.page)}
              alt={`p.${editing.page + 1} の原本`}
              draggable={false}
              onClick={() => setZoom((z) => !z)}
              title={zoom ? 'クリックで全体表示' : 'クリックで拡大'}
            />
          </div>
          <div className="text-edit-side">
            <div className="text-edit-head">
              <span className="text-toolbar-note">p.{editing.page + 1} の本文を編集（Markdown）</span>
              <span className="text-toolbar-spacer" />
              <button className="btn" onClick={() => setEditing(null)} disabled={saving}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={() => void saveEdit()} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
            {editing.low.length > 0 && (
              <div className="text-edit-low">
                <span className="text-toolbar-note">読み取りに自信がない行（クリックで選択）</span>
                {editing.low.map((l, i) => (
                  <button
                    key={i}
                    className="text-edit-low-item"
                    onClick={() => selectLow(l.text)}
                    title={`確信度 ${Math.round(l.score * 100)}%`}
                  >
                    {l.text}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={areaRef}
              className="text-edit-area"
              value={editing.draft}
              spellCheck={false}
              onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void saveEdit()
                }
              }}
              aria-label="本文"
            />
          </div>
        </div>
      ) : (
      <div
        key={pages.join(',')}
        className={`text-scroll ${vertical ? 'is-vertical' : ''}`}
        onWheel={(e) => {
          // 縦書きは横方向にスクロールするので、ホイールの上下を左右へ振り替える
          // (下へ回すと読み進む = 左へ進む)。
          if (vertical && e.deltaX === 0) e.currentTarget.scrollLeft -= e.deltaY
        }}
      >
        {pages.map((p) => {
          const t = texts[p]
          return (
            <section key={p} className="text-page">
              <div className="text-page-no">
                p.{p + 1}
                {t && t.low.length > 0 && (
                  <span className="text-page-badge" title="読み取りに自信がない行があります">
                    要確認 {t.low.length}
                  </span>
                )}
                {t?.edited && <span className="text-page-badge">手直し済み</span>}
                {t && (
                  <button
                    className="text-page-edit"
                    onClick={() => startEdit(p)}
                    disabled={!!job}
                    title="原本と見比べて本文を直す"
                  >
                    編集
                  </button>
                )}
              </div>
              {t === undefined ? (
                <div className="text-empty">読み込み中…</div>
              ) : t === null ? (
                <div className="text-empty">
                  このページはまだ文字起こししていません。
                  <button
                    className="btn"
                    onClick={() => void transcribe([p])}
                    disabled={!!job}
                  >
                    このページを文字起こし
                  </button>
                </div>
              ) : t.markdown.trim() === '' ? (
                <div className="text-empty">（本文なし）</div>
              ) : (
                <Markdown
                  text={t.markdown}
                  className="book-md"
                  resolveImage={(src) => {
                    const m = src.match(FIGURE_SRC_RE)
                    return m ? figureUrl(root, work.id, m[1]) : null
                  }}
                />
              )}
            </section>
          )
        })}
      </div>
      )}
    </div>
  )
}
