import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  addBookmark,
  addWorkTag,
  cancelAnalysis,
  deleteBookmark,
  enqueueAnalysis,
  getAnalysis,
  getAnalysisQueue,
  getPageAnalysis,
  getWorkTags,
  listBookmarks,
  pageUrl,
  removeWorkTag,
  saveReadingState,
  setWorkDirection,
  setWorkSpreadOffset,
  setWorkWritingMode,
  type Bookmark,
  type Direction,
  type PageAnalysis,
  type SpreadOffset,
  type Work,
  type WritingMode
} from './api'
import { PageScrubber } from './PageScrubber'
import { ReaderChat } from './ReaderChat'
import { TextView } from './TextView'
import type { AppSettings } from '../../preload'

const CHAT_MIN = 260
const CHAT_DEFAULT = 340

/** 画像(スクリーンショット)で読むか、文字起こしした本文で読むか。 */
type ViewMode = 'image' | 'text'

interface ReaderProps {
  root: string
  work: Work
  settings: AppSettings
  /** 作品ごとの方向上書きが変わったとき、一覧側へ反映する。 */
  onDirectionChange?: (workId: string, direction: Direction) => void
  /** 既読位置が変わったとき、一覧側へ反映する。 */
  onProgress?: (workId: string, page: number, completed: boolean) => void
  /** 書字方向が変わったとき、一覧側へ反映する。 */
  onWritingModeChange?: (workId: string, writingMode: WritingMode) => void
  /** 見開きオフセットの上書きが変わったとき、一覧側へ反映する。 */
  onSpreadOffsetChange?: (workId: string, offset: SpreadOffset) => void
  /** タグ候補(既存タグ一覧)。 */
  allTags?: string[]
  /** タグが変わったとき、一覧側へ反映する。 */
  onTagsChange?: (workId: string, tags: string[]) => void
  /** 解析パネルの開閉(作品をまたいで保持するため App 側で持つ)。 */
  showInfo: boolean
  onShowInfoChange: (v: boolean) => void
  /** ページ解析パネルの開閉(同上)。 */
  showPageInfo: boolean
  onShowPageInfoChange: (v: boolean) => void
  /** しおり一覧の開閉(同上。既定は常時表示)。 */
  showBookmarks: boolean
  onShowBookmarksChange: (v: boolean) => void
  /** 作品チャットの開閉(同上)。 */
  showChat: boolean
  onShowChatChange: (v: boolean) => void
  /** 指定時のみ「一覧へ」ボタンと Escape での復帰を有効にする。 */
  onClose?: () => void
  /** 右下の一時通知を出す(F9 のページ画像保存の結果など)。 */
  onNotify: (message: string, path: string | null, error?: boolean) => void
}

/** ratios[i] = 画像の縦横比(横/縦)。1 より大きいと横長。 */
type Ratios = Record<number, number>

/** 表示の単位(1枚 or 2枚)を先頭ページから順に組み立てる。 */
function buildSpreads(
  count: number,
  mode: 'single' | 'double',
  singleWhenLandscape: boolean,
  ratios: Ratios,
  offset: number
): number[][] {
  const spreads: number[][] = []
  const isLandscape = (i: number): boolean => ratios[i] !== undefined && ratios[i] > 1
  let i = 0
  // 見開きのペア境界を offset 枚分ずらす(先頭を単独表示)。
  if (mode === 'double') {
    for (let k = 0; k < offset && i < count; k++) {
      spreads.push([i])
      i += 1
    }
  }
  while (i < count) {
    if (mode === 'single') {
      spreads.push([i])
      i += 1
      continue
    }
    // 見開き: 横長は単独。次ページが横長 or 末尾なら 1 枚だけ。
    if (singleWhenLandscape && isLandscape(i)) {
      spreads.push([i])
      i += 1
      continue
    }
    if (i + 1 >= count || (singleWhenLandscape && isLandscape(i + 1))) {
      spreads.push([i])
      i += 1
      continue
    }
    spreads.push([i, i + 1])
    i += 2
  }
  return spreads
}

export function Reader({
  root,
  work,
  settings,
  onDirectionChange,
  onProgress,
  onSpreadOffsetChange,
  onWritingModeChange,
  allTags = [],
  onTagsChange,
  showInfo,
  onShowInfoChange,
  showPageInfo,
  onShowPageInfoChange,
  showBookmarks,
  onShowBookmarksChange,
  showChat,
  onShowChatChange,
  onClose,
  onNotify
}: ReaderProps): JSX.Element {
  const count = work.page_count
  const [dirOverride, setDirOverride] = useState<Direction>(
    (work.page_direction as Direction) || 'default'
  )
  const effectiveDir =
    dirOverride === 'default' ? settings.defaultDirection : dirOverride
  const rtl = effectiveDir === 'rtl'

  const [offsetOverride, setOffsetOverride] = useState<SpreadOffset>(
    (work.spread_offset as SpreadOffset) || 'default'
  )
  const effectiveOffset =
    offsetOverride === 'default' ? (settings.coverAlone ? 1 : 0) : Number(offsetOverride)

  const [ratios, setRatios] = useState<Ratios>({})
  const [page, setPage] = useState(() =>
    Math.min(Math.max(work.last_page, 0), Math.max(0, count - 1))
  )
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [scrubberVisible, setScrubberVisible] = useState(false)
  // チャットサイドバーの幅。ドラッグで変更でき、次回起動時も引き継ぐ。
  const [chatWidth, setChatWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('chatWidth'))
    return Number.isFinite(v) && v >= CHAT_MIN ? v : CHAT_DEFAULT
  })
  useEffect(() => {
    localStorage.setItem('chatWidth', String(chatWidth))
  }, [chatWidth])

  // 分割境界のドラッグでチャット幅を変更する(右端からの距離が幅になる)。
  const startChatDrag = useCallback(() => {
    const onMove = (e: MouseEvent): void => {
      const max = Math.round(window.innerWidth * 0.5)
      setChatWidth(Math.min(Math.max(window.innerWidth - e.clientX, CHAT_MIN), max))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])
  // 表示モードは本をまたいで引き継ぐ(次回起動時も)。
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    localStorage.getItem('readerViewMode') === 'text' ? 'text' : 'image'
  )
  useEffect(() => {
    localStorage.setItem('readerViewMode', viewMode)
  }, [viewMode])
  const [writingMode, setWritingMode] = useState<WritingMode>(work.writing_mode ?? 'horizontal')
  const [tags, setTags] = useState<string[]>(work.tags ?? [])
  const [showTags, setShowTags] = useState(false)
  // 表示設定バー(読み方向・見開きずらし)の開閉。
  const [showDisplay, setShowDisplay] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [summary, setSummary] = useState<string | null>(null)
  const [analyzedCount, setAnalyzedCount] = useState(0)
  const [pageInfos, setPageInfos] = useState<Record<number, PageAnalysis | null>>({})
  const [pageInfoVersion, setPageInfoVersion] = useState(0)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ current: number; total: number; phase: string } | null>(
    null
  )
  const [elapsedSec, setElapsedSec] = useState(0)
  const startRef = useRef<number | null>(null)

  const spreads = useMemo(
    () =>
      buildSpreads(count, settings.pageMode, settings.singleWhenLandscape, ratios, effectiveOffset),
    [count, settings.pageMode, settings.singleWhenLandscape, ratios, effectiveOffset]
  )

  // 既読位置の保存。最新の保存処理とページを ref に保持し、
  // デバウンス保存に加えて、リーダーを離れる直前にも確実に保存(flush)する。
  const pageRef = useRef(page)
  pageRef.current = page
  const persist = useRef<(p: number) => void>(() => {})
  persist.current = (p: number): void => {
    if (count === 0) return
    // p は見開きの先頭ページ。読了判定は見開き末尾のページで行う
    // (最終見開きが2枚組だと先頭ページでは最終ページに届かない)。
    const spread = spreads.find((s) => s.includes(p))
    const completed = (spread ? spread[spread.length - 1] : p) >= count - 1
    saveReadingState(root, work.id, p, completed).catch(() => {})
    onProgress?.(work.id, p, completed)
  }
  const curIdx = useMemo(
    () => Math.max(0, spreads.findIndex((s) => s.includes(page))),
    [spreads, page]
  )
  const currentSpread = spreads[curIdx] ?? [page]
  // テキスト表示ではページ番号順に並べる(rtl でも本文は先頭ページから)。
  const textPagesKey = [...currentSpread].sort((a, b) => a - b).join(',')
  const textPages = useMemo(() => textPagesKey.split(',').map(Number), [textPagesKey])

  // 直近のページ送り方向(スライドの向きに使う)。
  const turnRef = useRef<'next' | 'prev'>('next')

  const prev = useCallback(() => {
    turnRef.current = 'prev'
    setPage((p) => {
      const idx = spreads.findIndex((s) => s.includes(p))
      return idx > 0 ? spreads[idx - 1][0] : p
    })
  }, [spreads])

  const next = useCallback(() => {
    turnRef.current = 'next'
    setPage((p) => {
      const idx = spreads.findIndex((s) => s.includes(p))
      return idx >= 0 && idx < spreads.length - 1 ? spreads[idx + 1][0] : p
    })
  }, [spreads])

  // ページ移動時にデバウンス保存(連打を抑える)。
  useEffect(() => {
    const t = setTimeout(() => persist.current(page), 400)
    return () => clearTimeout(t)
  }, [page])

  // リーダーを離れる(アンマウント/作品切替)直前に、最新ページを確実に保存する。
  useEffect(() => {
    return () => persist.current(pageRef.current)
  }, [])

  // 現在の見開きと次の数ページの縦横比を読み込む(先読みも兼ねる)。
  // 読み込み完了前に effect が再実行されても同じページを二重リクエストしないよう、
  // 要求済みページを ref で覚えておく。
  const ratioRequested = useRef(new Set<number>())
  useEffect(() => {
    const want = new Set<number>([...currentSpread, page + 1, page + 2])
    want.forEach((i) => {
      if (i >= 0 && i < count && ratios[i] === undefined && !ratioRequested.current.has(i)) {
        ratioRequested.current.add(i)
        const img = new Image()
        img.onload = () => {
          const ratio = img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1
          setRatios((r) => (r[i] !== undefined ? r : { ...r, [i]: ratio }))
        }
        img.onerror = () => ratioRequested.current.delete(i)
        img.src = pageUrl(root, work.id, i)
      }
    })
  }, [root, work.id, page, currentSpread, count, ratios])

  // 見開きのペア境界を 1 ページずらす(作品ごとに保存)。
  const toggleOffset = useCallback(() => {
    const nextOffset: SpreadOffset = effectiveOffset === 1 ? '0' : '1'
    setOffsetOverride(nextOffset)
    setWorkSpreadOffset(root, work.id, nextOffset).catch(() => {})
    onSpreadOffsetChange?.(work.id, nextOffset)
  }, [effectiveOffset, root, work.id, onSpreadOffsetChange])

  // ブックマークの読み込み。
  useEffect(() => {
    listBookmarks(root, work.id)
      .then(setBookmarks)
      .catch(() => {})
  }, [root, work.id])

  // 表示中の見開きに含まれるページのしおり。
  const spreadBookmark = bookmarks.find((b) => currentSpread.includes(b.page))

  // 現在ページのしおりを付け外しする。
  const toggleBookmark = useCallback(() => {
    const target = currentSpread[0]
    const existing = bookmarks.find((b) => currentSpread.includes(b.page))
    if (existing) {
      setBookmarks((bs) => bs.filter((b) => b.id !== existing.id))
      deleteBookmark(root, work.id, existing.id).catch(() => {})
    } else {
      addBookmark(root, work.id, target)
        .then((id) =>
          setBookmarks((bs) =>
            [...bs, { id, page: target, note: null, created_at: new Date().toISOString() }].sort(
              (a, b) => a.page - b.page
            )
          )
        )
        .catch(() => {})
    }
  }, [bookmarks, currentSpread, root, work.id])

  function jumpTo(p: number): void {
    setPage(Math.min(Math.max(p, 0), count - 1))
  }

  function removeBookmark(id: number): void {
    setBookmarks((bs) => bs.filter((b) => b.id !== id))
    deleteBookmark(root, work.id, id).catch(() => {})
  }

  function addTag(name: string): void {
    const t = name.trim()
    if (!t || tags.includes(t)) {
      setTagInput('')
      return
    }
    const nextTags = [...tags, t].sort((a, b) => a.localeCompare(b, 'ja'))
    setTags(nextTags)
    setTagInput('')
    addWorkTag(root, work.id, t).catch(() => {})
    onTagsChange?.(work.id, nextTags)
  }

  function removeTag(name: string): void {
    const nextTags = tags.filter((t) => t !== name)
    setTags(nextTags)
    removeWorkTag(root, work.id, name).catch(() => {})
    onTagsChange?.(work.id, nextTags)
  }

  // まだ付いていない既存タグの候補。
  const tagSuggestions = allTags.filter((t) => !tags.includes(t))

  // 保存済みの解析結果(あらすじ + 解析済みページ数)を読み込む。
  useEffect(() => {
    getAnalysis(root, work.id)
      .then((a) => {
        setSummary(a.analysis?.summary ?? null)
        setAnalyzedCount(a.analyzedPages.length)
      })
      .catch(() => {})
  }, [root, work.id])

  // ページ解析パネル表示時、現在見開きのページ解析を取得する。
  // 未解析ページは数秒ごとに再取得し、解析が終わったら自動で表示する。
  const spreadKey = currentSpread.join(',')
  const pageInfosRef = useRef(pageInfos)
  pageInfosRef.current = pageInfos
  useEffect(() => {
    if (!showPageInfo) return
    let cancelled = false
    const fetchMissing = (force: boolean): void => {
      currentSpread.forEach((p) => {
        if (!force && pageInfosRef.current[p]) return
        getPageAnalysis(root, work.id, p)
          .then((d) => {
            if (!cancelled) setPageInfos((m) => ({ ...m, [p]: d }))
          })
          .catch(() => {})
      })
    }
    fetchMissing(true)
    const id = setInterval(() => fetchMissing(false), 2500)
    return () => {
      cancelled = true
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, work.id, spreadKey, showPageInfo, pageInfoVersion])

  const analyzeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopAnalyzePolling(): void {
    if (analyzeTimer.current) {
      clearInterval(analyzeTimer.current)
      analyzeTimer.current = null
    }
  }

  // キューを監視し、この作品が完了したら結果を反映する。
  function watchQueue(): void {
    stopAnalyzePolling()
    analyzeTimer.current = setInterval(async () => {
      try {
        const q = await getAnalysisQueue()
        const isCurrent = q.current?.work_id === work.id
        const isPending = q.pending.some((p) => p.work_id === work.id)
        if (isCurrent && q.current) {
          setProgress({ current: q.current.current, total: q.current.total, phase: q.current.phase })
          // 開始時刻をバックエンドの elapsed で補正(初回のみ)。
          if (startRef.current === null) {
            startRef.current = Date.now() - (q.current.elapsed ?? 0) * 1000
          }
        } else if (isPending) {
          setProgress(null)
        }
        if (!isCurrent && !isPending) {
          stopAnalyzePolling()
          startRef.current = null
          // この作品の最新の結果を見る(古い失敗エントリを拾わない)。
          const recents = q.recent.filter((r) => r.work_id === work.id)
          const rec = recents[recents.length - 1]
          if (rec?.status === 'error') setAnalyzeError(rec.error ?? '解析に失敗しました')
          try {
            const a = await getAnalysis(root, work.id)
            setSummary(a.analysis?.summary ?? null)
            setAnalyzedCount(a.analyzedPages.length)
            const t = await getWorkTags(root, work.id)
            setTags(t)
            onTagsChange?.(work.id, t)
            setPageInfoVersion((v) => v + 1)
          } catch {
            // 反映失敗は無視
          }
          setAnalyzing(false)
          setProgress(null)
        }
      } catch {
        // 一時的な取得失敗は無視
      }
    }, 700)
  }

  async function startAnalyze(opts?: {
    focusPage?: number
    pages?: number[]
    summaryOnly?: boolean
  }): Promise<void> {
    setAnalyzing(true)
    setAnalyzeError(null)
    setProgress(null)
    startRef.current = null
    setElapsedSec(0)
    const systemPrompt =
      settings.llm.systemPromptEnabled && settings.llm.systemPrompt.trim()
        ? settings.llm.systemPrompt
        : undefined
    const contextCount = settings.llm.usePageContext ? settings.llm.pageContextCount : 0
    try {
      await enqueueAnalysis(root, [work.id], settings.llm.samplePages, {
        ...opts,
        systemPrompt,
        contextCount,
        useStorySummary: settings.llm.useStorySummary,
        storyEvery: settings.llm.storySummaryEvery
      })
    } catch (e) {
      setAnalyzeError((e as Error).message)
      setAnalyzing(false)
      return
    }
    watchQueue()
  }

  // 増分解析: 開いているページを優先して未解析ページを埋める。
  function runAnalyze(): void {
    void startAnalyze({ focusPage: currentSpread[0] })
  }

  // 指定ページだけ解析する。
  function analyzeThisPage(p: number): void {
    void startAnalyze({ pages: [p] })
  }

  // ページ解析はやり直さず、既存の解析済みキャプションからあらすじ + タグだけ再生成する。
  function regenerateSummary(): void {
    void startAnalyze({ summaryOnly: true })
  }

  // 全ページを再解析する(時間がかかるため確認)。
  function analyzeAll(): void {
    if (!window.confirm(`全 ${count} ページを解析します。時間がかかる場合があります。よろしいですか？`)) {
      return
    }
    void startAnalyze({ pages: Array.from({ length: count }, (_, i) => i) })
  }

  async function cancelAnalyze(): Promise<void> {
    try {
      await cancelAnalysis(work.id)
    } catch {
      // 無視
    }
  }

  // アンマウント時にポーリングを止める。
  useEffect(() => () => stopAnalyzePolling(), [])

  // 経過時間を1秒ごとに更新(実行中のみ)。
  useEffect(() => {
    if (!analyzing) return
    const id = setInterval(() => {
      if (startRef.current !== null) {
        setElapsedSec(Math.max(0, Math.floor((Date.now() - startRef.current) / 1000)))
      }
    }, 1000)
    return () => clearInterval(id)
  }, [analyzing])

  const progressPct =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
  const queued = analyzing && !progress
  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`

  // キーボード操作。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 入力欄(タグ・チャット・設定モーダル等)へのタイピングでは発火させない。
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'Escape') onClose?.()
      else if (e.key === 'ArrowRight') rtl ? prev() : next()
      else if (e.key === 'ArrowLeft') rtl ? next() : prev()
      // テキスト表示では上下キーを本文のスクロールに譲る。
      else if (e.key === 'ArrowUp' && viewMode === 'image') prev()
      else if (e.key === 'ArrowDown' && viewMode === 'image') next()
      else if ((e.key === 's' || e.key === 'S') && settings.pageMode === 'double') toggleOffset()
      else if (e.key === 'b' || e.key === 'B') toggleBookmark()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rtl, prev, next, onClose, toggleOffset, toggleBookmark, settings.pageMode, viewMode])

  // F9: 表示中のページ画像を、アーカイブ内の元データのまま保存する(見開きなら 2 枚)。
  // backend から取得したバイト列をそのまま main へ渡すので、再エンコードによる劣化はない。
  const savePageImages = useCallback(async (): Promise<void> => {
    try {
      const pages = await Promise.all(
        currentSpread.map(async (i) => {
          const res = await fetch(pageUrl(root, work.id, i))
          if (!res.ok) throw new Error(`ページ ${i + 1} を取得できませんでした`)
          const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
          return { index: i, mediaType, data: new Uint8Array(await res.arrayBuffer()) }
        })
      )
      const saved = await window.api.savePageImages(root, work.title, pages)
      onNotify(`ページ画像を ${saved.length} 枚保存しました`, saved[0] ?? null)
    } catch (e) {
      onNotify(`保存に失敗しました: ${(e as Error).message}`, null, true)
    }
  }, [root, work.id, work.title, currentSpread, onNotify])

  // F9 は main が横取りしてこちらへ通知する(既定メニューのキー割り当てを避けるため)。
  useEffect(() => {
    return window.api.onShortcut((name) => {
      if (name === 'save-pages') void savePageImages()
    })
  }, [savePageImages])

  function changeWritingMode(mode: WritingMode): void {
    setWritingMode(mode)
    setWorkWritingMode(root, work.id, mode).catch((e) =>
      onNotify(`書字方向を保存できませんでした: ${(e as Error).message}`, null, true)
    )
    onWritingModeChange?.(work.id, mode)
  }

  function changeDirection(dir: Direction): void {
    setDirOverride(dir)
    setWorkDirection(root, work.id, dir).catch(() => {})
    onDirectionChange?.(work.id, dir)
  }

  // 表示順: rtl では番号の大きいページを左に置く。
  const order = rtl ? [...currentSpread].reverse() : currentSpread
  const lastPageOfSpread = currentSpread[currentSpread.length - 1]

  // ページめくりエフェクト。見開きキーが変わるたびにアニメを再生する。
  const transition = settings.pageTransition ?? 'slide'
  const animate = transition !== 'none'
  // スライドの入り方向: 進む(next)と方向(rtl)で符号が決まる。
  const slideSign = (turnRef.current === 'next' ? 1 : -1) * (rtl ? -1 : 1)
  const enterX = `${slideSign * 100}%`

  return (
    <div className="reader">
      <header className="reader-bar">
        {onClose && (
          <button className="btn" onClick={onClose}>
            ← 一覧へ
          </button>
        )}
        <span className="reader-title">{work.title}</span>
        <div className="seg" role="group" aria-label="表示モード">
          <button
            className={`seg-btn ${viewMode === 'image' ? 'seg-active' : ''}`}
            onClick={() => setViewMode('image')}
            title="スクリーンショットの画像で読む"
          >
            画像
          </button>
          <button
            className={`seg-btn ${viewMode === 'text' ? 'seg-active' : ''}`}
            onClick={() => setViewMode('text')}
            title="文字起こしした本文で読む"
          >
            テキスト
          </button>
        </div>
        <button
          className={`btn ${showDisplay ? 'btn-active' : ''}`}
          onClick={() => setShowDisplay((v) => !v)}
          title="表示設定（読み方向・見開き）"
        >
          表示
        </button>
        <button
          className={`btn ${showBookmarks ? 'btn-active' : ''}`}
          onClick={() => onShowBookmarksChange(!showBookmarks)}
          title="しおり一覧の開閉"
        >
          しおり{bookmarks.length > 0 ? `（${bookmarks.length}）` : ''}
        </button>
        <button
          className={`btn ${showTags ? 'btn-active' : ''}`}
          onClick={() => setShowTags((v) => !v)}
          title="タグの編集"
        >
          タグ{tags.length > 0 ? `（${tags.length}）` : ''}
        </button>
        <button
          className={`btn ${showInfo ? 'btn-active' : ''}`}
          onClick={() => onShowInfoChange(!showInfo)}
          title="解析 / あらすじ"
        >
          解析{analyzing ? `… ${progressPct}%` : ''}
        </button>
        <button
          className={`btn ${showChat ? 'btn-active' : ''}`}
          onClick={() => onShowChatChange(!showChat)}
          title="この作品について質問する"
        >
          チャット
        </button>
        <span className="reader-count">
          {currentSpread.length === 2
            ? `${currentSpread[0] + 1}-${lastPageOfSpread + 1}`
            : currentSpread[0] + 1}{' '}
          / {count}
        </span>
      </header>

      <div className="reader-body">
      <div className="reader-left">

      {showDisplay && (
        <div className="reader-display">
          <div className="display-item">
            <span className="display-label">読み方向</span>
            <select
              className="reader-dir"
              value={dirOverride}
              onChange={(e) => changeDirection(e.target.value as Direction)}
              title="この作品の読み進め方向"
            >
              <option value="default">
                既定（{settings.defaultDirection === 'rtl' ? '右→左' : '左→右'}）
              </option>
              <option value="rtl">右 → 左</option>
              <option value="ltr">左 → 右</option>
            </select>
          </div>
          <div className="display-item">
            <span className="display-label">書字方向</span>
            <div className="seg" role="group" aria-label="書字方向">
              {(['horizontal', 'vertical'] as const).map((m) => (
                <button
                  key={m}
                  className={`seg-btn ${writingMode === m ? 'seg-active' : ''}`}
                  onClick={() => changeWritingMode(m)}
                  title="本文の書字方向。テキスト表示の組み方と、文字起こしの読み順に使います"
                >
                  {m === 'horizontal' ? '横書き' : '縦書き'}
                </button>
              ))}
            </div>
          </div>
          {settings.pageMode === 'double' && (
            <div className="display-item">
              <span className="display-label">見開きのペア</span>
              <button
                className={`btn ${effectiveOffset === 1 ? 'btn-active' : ''}`}
                onClick={toggleOffset}
                title="見開きのペアを1ページずらす（S）"
              >
                ずらす{effectiveOffset === 1 ? '中' : ''}
              </button>
            </div>
          )}
        </div>
      )}

      {showTags && (
        <div className="reader-tags">
          {tags.map((t) => (
            <span key={t} className="tag-chip">
              {t}
              <button
                className="tag-chip-del"
                onClick={() => removeTag(t)}
                aria-label={`タグ ${t} を外す`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className="tag-input"
            list="reader-tag-suggestions"
            placeholder="タグを追加（Enter）"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              // IME 変換確定の Enter(isComposing)では追加しない。
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) addTag(tagInput)
            }}
          />
          <datalist id="reader-tag-suggestions">
            {tagSuggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button
            className="btn tag-generate"
            onClick={regenerateSummary}
            disabled={analyzing || analyzedCount === 0}
            title={
              analyzedCount === 0
                ? '先にページ解析が必要です（解析パネルから実行）'
                : '解析済みページの内容からタグを追加生成します。手で付けたタグは消えません（あらすじも更新されます）'
            }
          >
            {analyzing ? '生成中…' : '✦ タグを自動生成'}
          </button>
        </div>
      )}

      {showInfo && (
        <div className="reader-info">
          <div className="reader-info-head">
            <span className="reader-info-title">あらすじ（AI 解析）</span>
            <button className="btn" onClick={runAnalyze} disabled={analyzing}>
              {analyzing
                ? queued
                  ? '待機中…'
                  : `解析中… ${progressPct}%`
                : `ランダムに解析（${settings.llm.samplePages}p）`}
            </button>
            <button className="btn" onClick={analyzeAll} disabled={analyzing}>
              すべて再解析
            </button>
            <button
              className="btn"
              onClick={regenerateSummary}
              disabled={analyzing || analyzedCount === 0}
              title="ページ解析済みの内容からあらすじだけを作り直します"
            >
              あらすじ再生成
            </button>
            {analyzing && (
              <button className="btn" onClick={cancelAnalyze}>
                中止
              </button>
            )}
            <button
              className={`btn ${showPageInfo ? 'btn-active' : ''}`}
              onClick={() => onShowPageInfoChange(!showPageInfo)}
              title="現在ページの解析結果を下部に表示"
            >
              ページ解析を表示
            </button>
            <span className="reader-info-note">解析済み {analyzedCount}/{count} ページ</span>
          </div>
          {analyzing && (
            <div className="analyze-progress">
              <div className="analyze-bar">
                <div className="analyze-bar-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="analyze-progress-label">
                {queued
                  ? '順番待ち…'
                  : progress
                    ? progress.phase === 'summary'
                      ? `あらすじ生成中… ・ 経過 ${elapsedLabel}`
                      : `ページ解析中 ${progress.current}/${progress.total - 1} ・ 経過 ${elapsedLabel}`
                    : '準備中…'}
              </span>
            </div>
          )}
          {analyzeError && <div className="reader-info-error">エラー: {analyzeError}</div>}
          <div className="reader-info-body">
            {summary ? summary : <span className="reader-info-empty">まだ解析していません。</span>}
          </div>
        </div>
      )}

      <div
        className="reader-stage"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setScrubberVisible(e.clientY > r.bottom - 80)
        }}
        onMouseLeave={() => setScrubberVisible(false)}
      >
        {viewMode === 'text' ? (
          <TextView
            root={root}
            work={work}
            pages={textPages}
            vertical={writingMode === 'vertical'}
          />
        ) : (
        <>
        {/* 画面端クリックでページ送り(rtl では右が前)。 */}
        <button
          className="reader-zone reader-zone-left"
          aria-label={rtl ? '次へ' : '前へ'}
          onClick={rtl ? next : prev}
        />
        <div
          key={animate ? spreadKey : undefined}
          className={`reader-pages ${order.length === 2 ? 'is-double' : ''} ${
            animate ? `anim-${transition}` : ''
          }`}
          style={
            transition === 'slide' ? ({ '--enter-x': enterX } as CSSProperties) : undefined
          }
        >
          {order.map((i) => (
            <img
              key={i}
              className="reader-image"
              src={pageUrl(root, work.id, i)}
              alt={`page ${i + 1}`}
              draggable={false}
            />
          ))}
        </div>
        <button
          className="reader-zone reader-zone-right"
          aria-label={rtl ? '前へ' : '次へ'}
          onClick={rtl ? prev : next}
        />
        </>
        )}
        <PageScrubber
          root={root}
          workId={work.id}
          count={count}
          page={page}
          rtl={rtl}
          bookmarks={bookmarks}
          visible={scrubberVisible}
          onSeek={(p) => setPage(p)}
        />
        {showPageInfo && viewMode === 'image' && (
          <div className="reader-pageinfo">
            {order.map((p) => {
              const info = pageInfos[p]
              return (
                <div key={p} className="pageinfo-item">
                  <div className="pageinfo-head">
                    <span className="pageinfo-page">p.{p + 1}</span>
                    {info === undefined ? (
                      <span className="pageinfo-empty">読み込み中…</span>
                    ) : (
                      <button
                        className="btn pageinfo-btn"
                        onClick={() => analyzeThisPage(p)}
                        disabled={analyzing}
                      >
                        {info === null ? 'このページを解析' : '再解析'}
                      </button>
                    )}
                  </div>
                  {info && (
                    <div className="pageinfo-body">
                      {info.description && info.description.trim() ? (
                        info.description
                      ) : (
                        <span className="pageinfo-empty">（説明なし・再解析できます）</span>
                      )}
                      {info.text && info.text.trim() && (
                        <div className="pageinfo-text">{info.text}</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showBookmarks && (
        <div className={`reader-bm-strip ${rtl ? 'is-rtl' : ''}`}>
          <button
            className={`reader-bm-add ${spreadBookmark ? 'is-on' : ''}`}
            onClick={toggleBookmark}
            title="このページのしおりを付け外し（B）"
          >
            <span className="reader-bm-add-star">{spreadBookmark ? '★' : '☆'}</span>
            {spreadBookmark ? '解除' : '追加'}
          </button>
          {bookmarks.length === 0 ? (
            <div className="reader-bm-empty">しおりはありません</div>
          ) : (
            bookmarks.map((b) => (
              <div
                key={b.id}
                className={`reader-bm-item ${currentSpread.includes(b.page) ? 'is-current' : ''}`}
              >
                <button
                  className="reader-bm-thumb"
                  onClick={() => jumpTo(b.page)}
                  title={`${b.page + 1} ページへ`}
                >
                  <img src={pageUrl(root, work.id, b.page)} alt="" draggable={false} />
                  <span className="reader-bm-page">{b.page + 1}</span>
                </button>
                <button
                  className="reader-bm-del"
                  onClick={() => removeBookmark(b.id)}
                  aria-label="しおりを削除"
                  title="削除"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}

      </div>

      {showChat && (
        <>
          <div
            className="divider"
            onMouseDown={startChatDrag}
            onDoubleClick={() => setChatWidth(CHAT_DEFAULT)}
            role="separator"
            aria-orientation="vertical"
          />
          <ReaderChat
            root={root}
            work={work}
            currentPage={currentSpread[0]}
            think={settings.llm.thinkingEnabled}
            systemPrompt={settings.llm.chatSystemPrompt}
            dynamicSuggestions={settings.llm.chatDynamicSuggestions}
            width={chatWidth}
            onClose={() => onShowChatChange(false)}
          />
        </>
      )}
      </div>
    </div>
  )
}
