import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelAnalysis,
  enqueueTranscribe,
  figureUrl,
  getAnalysisQueue,
  getPageText,
  getTextPages,
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

/**
 * リーダーのテキスト表示。本フォルダの pages/*.md を Markdown として描画し、
 * 未処理のページは文字起こしを解析キューへ積める。縦書きの本は縦書きで組む。
 */
export function TextView({ root, work, pages, vertical, engine }: Props): JSX.Element {
  const [texts, setTexts] = useState<Record<number, string | null>>({})
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
        const q = await getAnalysisQueue()
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
    getAnalysisQueue()
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
            <button className="btn" onClick={() => void cancelAnalysis(work.id)}>
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
              <div className="text-page-no">p.{p + 1}</div>
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
              ) : t.trim() === '' ? (
                <div className="text-empty">（本文なし）</div>
              ) : (
                <Markdown
                  text={t}
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
    </div>
  )
}
