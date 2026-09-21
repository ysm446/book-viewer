import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelAnalysis,
  enqueueStructure,
  getAnalysisQueue,
  getStructure,
  type BookStructure,
  type Work
} from './api'
import { Markdown } from './Markdown'

interface Props {
  root: string
  work: Work
  /** いま開いているページ(0 始まり)。今の章の強調に使う。 */
  currentPage: number
  /** LLM が読み込まれているか(章立て・要約の作成に必要)。 */
  llmReady: boolean
  onJump: (page: number) => void
}

type Job = { state: 'queued' | 'running'; current: number; total: number; phase: string } | null

const PHASE_LABEL: Record<string, string> = {
  chapters: '章立てを作成中',
  summary: '章の要約を作成中',
  book: '本全体の要約を作成中'
}

/** 目次(章立て)と章ごとの要約。章をクリックでそのページへ移動する。 */
export function TocPanel({ root, work, currentPage, llmReady, onJump }: Props): JSX.Element {
  const [data, setData] = useState<BookStructure | null>(null)
  const [job, setJob] = useState<Job>(null)
  const [error, setError] = useState<string | null>(null)
  const [openSummary, setOpenSummary] = useState<number | null>(null)
  const alive = useRef(true)
  const polling = useRef(false)
  const currentRef = useRef<HTMLLIElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await getStructure(root, work.id))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [root, work.id])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // キューを監視し、この本の章立て・要約の進み具合を出す。終わったら読み込み直す。
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
        const cur = q.current?.work_id === work.id && q.current.kind === 'structure' ? q.current : null
        const pending = q.pending.some((j) => j.work_id === work.id && j.kind === 'structure')
        if (cur) {
          setJob({ state: 'running', current: cur.current, total: cur.total, phase: cur.phase })
          // 章の要約が 1 つできるたびに反映する。
          if (cur.current !== lastCurrent) {
            lastCurrent = cur.current
            void load()
          }
        } else if (pending) {
          setJob({ state: 'queued', current: 0, total: 0, phase: '' })
        } else {
          const recent = q.recent.filter((r) => r.work_id === work.id && r.kind === 'structure')
          const last = recent[recent.length - 1]
          if (last?.status === 'error') setError(last.error ?? '作成に失敗しました')
          setJob(null)
          polling.current = false
          void load()
          return
        }
      } catch {
        // 一時的な取得失敗は次の周期で取り直す
      }
      setTimeout(() => void tick(), 1500)
    }
    void tick()
  }, [work.id, load])

  // 開いた時点で作成中なら進み具合を追う。
  useEffect(() => {
    getAnalysisQueue()
      .then((q) => {
        const active =
          (q.current?.work_id === work.id && q.current.kind === 'structure') ||
          q.pending.some((j) => j.work_id === work.id && j.kind === 'structure')
        if (active) watch()
      })
      .catch(() => {})
  }, [work.id, watch])

  async function start(redo: boolean): Promise<void> {
    if (
      redo &&
      !window.confirm('章立てから作り直します。今の章の区切りと要約は消えます。よろしいですか？')
    ) {
      return
    }
    setError(null)
    try {
      await enqueueStructure(root, work.id, redo)
      setJob({ state: 'queued', current: 0, total: 0, phase: '' })
      watch()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const chapters = data?.chapters ?? []
  const hasChapters = chapters.length > 0
  const currentIndex = chapters.findIndex((c) => c.start <= currentPage && currentPage <= c.end)

  // 章立てを読み込んだとき・章が変わったときは、今の章が見える位置までスクロールする。
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex, hasChapters])
  const missing = data ? data.page_count - data.transcribed : 0
  const pct = job && job.total > 0 ? Math.round((job.current / job.total) * 100) : 0
  const needsModel = !llmReady ? '章立てと要約には LLM が必要です。上部でモデルを読み込んでください' : undefined

  return (
    <div className="reader-info toc-panel">
      <div className="reader-info-head">
        <span className="reader-info-title">目次と要約</span>
        {job ? (
          <>
            <span className="analyze-bar toc-bar">
              <span className="analyze-bar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="reader-info-note">
              {job.state === 'queued'
                ? '順番待ち…'
                : `${PHASE_LABEL[job.phase] ?? '作成中'} ${job.current}/${job.total}`}
            </span>
            <button className="btn" onClick={() => void cancelAnalysis(work.id)}>
              中止
            </button>
          </>
        ) : (
          <>
            <button
              className="btn"
              onClick={() => void start(false)}
              disabled={!llmReady || data?.transcribed === 0}
              title={
                needsModel ??
                (hasChapters
                  ? 'まだ要約のない章だけ要約し、本全体の要約を作り直します'
                  : '文字起こしした本文から章立てを作り、章ごとに要約します')
              }
            >
              {hasChapters ? '要約を更新' : '章立てと要約を作る'}
            </button>
            {hasChapters && (
              <button
                className="btn"
                onClick={() => void start(true)}
                disabled={!llmReady}
                title={needsModel ?? '章立てから作り直します'}
              >
                作り直す
              </button>
            )}
          </>
        )}
      </div>
      {error && <div className="reader-info-error">エラー: {error}</div>}
      {data && data.transcribed === 0 && (
        <div className="reader-info-empty">
          まだ文字起こししていません。テキスト表示から文字起こしすると、章立てと要約を作れます。
        </div>
      )}
      {data && data.transcribed > 0 && missing > 0 && (
        <div className="toc-note">
          文字起こしが済んでいないページが {missing} ページあります。章立てと要約は文字起こし済みの本文だけで作ります。
        </div>
      )}
      {data && data.transcribed > 0 && !hasChapters && !job && (
        <div className="reader-info-empty">まだ章立てがありません。</div>
      )}
      {hasChapters && (
        <div className="toc-body">
          {data?.book_summary && (
            <details className="toc-book">
              <summary>本全体の要約（先の内容も含みます）</summary>
              <Markdown text={data.book_summary} className="chat-md toc-summary" />
            </details>
          )}
          <ol className="toc-list">
            {chapters.map((c, i) => {
              const current = i === currentIndex
              return (
                <li
                  key={`${c.start}-${c.title}`}
                  ref={current ? currentRef : undefined}
                  className={`toc-item ${current ? 'is-current' : ''}`}
                >
                  <div className="toc-row">
                    <button className="toc-title" onClick={() => onJump(c.start)} title="この章へ移動">
                      {c.title}
                    </button>
                    <span className="toc-pages">
                      p.{c.start + 1}–{c.end + 1}
                    </span>
                    {c.summary && (
                      <button
                        className={`btn toc-toggle ${openSummary === i ? 'btn-active' : ''}`}
                        onClick={() => setOpenSummary((v) => (v === i ? null : i))}
                        aria-expanded={openSummary === i}
                      >
                        要約
                      </button>
                    )}
                  </div>
                  {openSummary === i && c.summary && (
                    <Markdown text={c.summary} className="chat-md toc-summary" />
                  )}
                  {/* 節は今読んでいる章だけ広げる(一覧が長くなりすぎないように) */}
                  {current && c.sections.length > 0 && (
                    <ul className="toc-sections">
                      {c.sections.map((s) => (
                        <li key={`${s.page}-${s.title}`}>
                          <button className="toc-section" onClick={() => onJump(s.page)}>
                            {s.title}
                            <span className="toc-pages">p.{s.page + 1}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
