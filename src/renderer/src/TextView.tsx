import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import {
  cancelJob,
  enqueueTranscribe,
  figureUrl,
  getContent,
  getQueue,
  getPageText,
  pageUrl,
  savePageText,
  type BookContent,
  type ContentBlock,
  type LowLine,
  type PageText,
  type TranscribeEngine,
  type Work
} from './api'
import { Markdown } from './Markdown'

interface Props {
  root: string
  work: Work
  /** 今読んでいる原本のページ(0 始まり)。外から変わったら、そのページの本文へ移動する。 */
  page: number
  /** 画面に出ている本文が原本のどのページまで進んだか。completed は本の終わりまで読んだか。 */
  onPageChange: (page: number, completed: boolean) => void
  /** 縦書きで組むか(原本の書字方向とは別に選べる) */
  vertical: boolean
  /** 横書きで 1 画面に並べる段の数(幅が足りなければ 1 段にする) */
  columns: 1 | 2
  /** 本文の文字サイズ(px) */
  fontSize: number
  /** ページ送りのフェードを出すか */
  animate: boolean
  /** 文字起こしのエンジン(設定) */
  engine: TranscribeEngine
}

/** リーダーからのページ送り(キーボード)を受ける。 */
export interface TextViewHandle {
  turn: (dir: 'next' | 'prev') => void
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

/** 段と段(= 画面と画面)の間隔。 */
const GAP = 48
/** 本文の上下の余白と、下の位置表示の高さ。 */
const PAD_Y = 24
const FOOT = 24
/** 1 行の長さの上限(em)。横書きは 1 段の幅、縦書きは高さ。 */
const LINE_MAX_EM = 42
/** 縦書きの 1 画面の幅の上限(em)。 */
const VERTICAL_WIDTH_MAX_EM = 64
/** 横書きを 2 段にする 1 段の幅の下限(em)。 */
const COLUMN_MIN_EM = 26

/**
 * 一度に組む範囲。章(break)で区切り、章立てが無い本や長い章は見出しの前で区切る
 * (本を丸ごと組むと、ウィンドウの大きさを変えるたびの組み直しが重い)。
 */
const SECTION_SOFT = 30000
const SECTION_HARD = 60000

interface Section {
  start: number
  /** この添字の手前まで */
  end: number
}

function buildSections(blocks: ContentBlock[]): Section[] {
  const out: Section[] = []
  let start = 0
  let chars = 0
  blocks.forEach((b, i) => {
    const cut =
      i > start &&
      (b.break || (chars >= SECTION_SOFT && b.kind === 'heading') || chars >= SECTION_HARD)
    if (cut) {
      out.push({ start, end: i })
      start = i
      chars = 0
    }
    chars += b.md.length
  })
  if (blocks.length > start) out.push({ start, end: blocks.length })
  return out
}

/** 原本のページ page 以降で最初に始まるブロック。無ければ最後のブロック。 */
function blockOfPage(blocks: ContentBlock[], page: number): number {
  const i = blocks.findIndex((b) => b.page >= page)
  return i >= 0 ? i : blocks.length - 1
}

/** 組み直しても同じ場所へ戻るための位置(原本のページと、そのページの中で何番目のブロックか)。 */
interface AnchorKey {
  page: number
  ord: number
}

function keyOfBlock(blocks: ContentBlock[], index: number): AnchorKey {
  const page = blocks[index].page
  let ord = 0
  for (let i = index - 1; i >= 0 && blocks[i].page === page; i--) ord++
  return { page, ord }
}

function blockOfKey(blocks: ContentBlock[], key: AnchorKey): number {
  const first = blockOfPage(blocks, key.page)
  if (first < 0 || blocks[first].page !== key.page) return first
  let i = first
  while (i - first < key.ord && i + 1 < blocks.length && blocks[i + 1].page === key.page) i++
  return i
}

/** 1 画面の大きさと段の数。 */
interface Geometry {
  width: number
  height: number
  columns: number
  /** 次の画面までの距離(横書きは横、縦書きは縦) */
  stride: number
  padX: number
}

/** 組んだ結果: 区画の各ブロックが何画面目から何画面目にあるか。 */
interface Layout {
  sec: number
  starts: number[]
  ends: number[]
  screens: number
}

type Pending = 'first' | 'last' | { block: number } | null

/**
 * リーダーのテキスト表示。アプリ用の本文(原本のページ割りから切り離したブロックの並び)を、
 * ウィンドウの大きさ・文字サイズ・組み方(横書き / 縦書き)に合わせて画面単位に組み直し、
 * ページ送りで読む(スクロールしない)。組版は CSS の段組みに任せ、1 段(横書きは 1〜2 段)を
 * 1 画面として、段の並ぶ方向(横書きは右、縦書きは下)へずらして見せる。
 * 読書位置は原本のページ番号でリーダーと共有する。文字起こしと本文の手直しは原本のページ単位。
 */
export const TextView = forwardRef<TextViewHandle, Props>(function TextView(
  { root, work, page, onPageChange, vertical, columns, fontSize, animate, engine },
  ref
): JSX.Element {
  const [content, setContent] = useState<BookContent | null>(null)
  const [texts, setTexts] = useState<Record<number, PageText | null>>({})
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
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

  // アプリ用の本文を読み込む。材料が変わっていなければ(signature が同じなら)組み直さない。
  const loadedAt = useRef(0)
  const reload = useCallback(async (): Promise<void> => {
    loadedAt.current = Date.now()
    const next = await getContent(root, work.id)
    setContent((prev) => (prev && prev.signature === next.signature ? prev : next))
  }, [root, work.id])

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message))
  }, [reload])

  // 今の原本ページの補助情報(要確認の行・手直し済みか。編集にも使う)を読み込む(未取得のときだけ)。
  const textsRef = useRef(texts)
  textsRef.current = texts
  useEffect(() => {
    if (!(page in textsRef.current)) loadText(page)
  }, [page, loadText])

  // キューを監視し、この本の文字起こしの進み具合を反映する。
  // 読みながら文字起こしを進められるよう、進んでいる間もときどき本文を読み込み直す。
  const pageRef = useRef(page)
  pageRef.current = page
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
        const progressed = cur !== null && cur.current !== lastCurrent
        lastCurrent = cur ? cur.current : -1
        if (progressed && Date.now() - loadedAt.current > 15000) await reload()
        if (!cur && !pending) {
          const recent = q.recent.filter((r) => r.work_id === work.id && r.kind === 'transcribe')
          const last = recent[recent.length - 1]
          if (last?.status === 'error') setError(last.error ?? '文字起こしに失敗しました')
          // やり直したページもあるので、終了時に必ず読み込み直す。
          await reload()
          loadText(pageRef.current)
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
  }, [work.id, reload, loadText])

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
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // ---- 組版とページ送り ----

  const blocks = content?.blocks
  const sections = useMemo(() => (blocks ? buildSections(blocks) : []), [blocks])
  const [sec, setSec] = useState(0)
  const [screen, setScreen] = useState(0)
  const [screens, setScreens] = useState(1)
  // 図の読み込みや移動の指示で、組んだ結果を測り直すための合図。
  const [tick, setTick] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const flowRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const layout = useRef<Layout | null>(null)
  const pending = useRef<Pending>(null)
  /** 画面の先頭のブロック(blocks の添字)。組み直したときにここへ戻る。 */
  const anchor = useRef<number | null>(null)
  const anchorKey = useRef<AnchorKey | null>(null)
  const screenRef = useRef(0)
  const reported = useRef({ page, completed: false })
  const onPageChangeRef = useRef(onPageChange)
  onPageChangeRef.current = onPageChange

  const showStage = !editing
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [showStage])

  const geo = useMemo((): Geometry | null => {
    if (!size) return null
    const padX = Math.max(24, Math.round(size.w * 0.1))
    const availW = size.w - padX * 2
    const availH = size.h - PAD_Y * 2 - FOOT
    if (availW < 120 || availH < 120) return null
    if (vertical) {
      const width = Math.floor(Math.min(availW, VERTICAL_WIDTH_MAX_EM * fontSize))
      const height = Math.floor(Math.min(availH, LINE_MAX_EM * fontSize))
      return { width, height, columns: 1, stride: height + GAP, padX }
    }
    const n = columns === 2 && availW >= COLUMN_MIN_EM * fontSize * 2 + GAP ? 2 : 1
    let width = Math.floor(Math.min(availW, LINE_MAX_EM * fontSize * n + GAP * (n - 1)))
    if (n === 2 && (width - GAP) % 2 === 1) width -= 1 // 段の幅を整数にする
    return { width, height: Math.floor(availH), columns: n, stride: width + GAP, padX }
  }, [size, vertical, columns, fontSize])

  // 画面が決まったら、先頭のブロックを覚え、原本のどのページまで進んだかをリーダーへ伝える。
  const settle = useCallback(
    (scr: number): void => {
      const l = layout.current
      if (!l || !blocks) return
      const s = sections[l.sec]
      if (!s) return
      let covering = -1
      let firstStart = -1
      let lastStart = -1
      for (let i = 0; i < l.starts.length && l.starts[i] <= scr; i++) {
        if (covering < 0 && l.ends[i] >= scr) covering = i
        if (l.starts[i] === scr) {
          if (firstStart < 0) firstStart = i
          lastStart = i
        }
      }
      // 前の画面から続く段落だけの画面では、その段落を先頭とみなす。
      const head = firstStart >= 0 ? firstStart : covering
      if (head < 0) return
      anchor.current = s.start + head
      anchorKey.current = keyOfBlock(blocks, s.start + head)
      const reached = blocks[s.start + (lastStart >= 0 ? lastStart : head)].page
      const atEnd = l.sec === sections.length - 1 && scr === l.screens - 1
      const completed = atEnd && (content?.pages_done ?? 0) >= work.page_count
      if (reported.current.page !== reached || reported.current.completed !== completed) {
        reported.current = { page: reached, completed }
        onPageChangeRef.current(reached, completed)
      }
    },
    [blocks, sections, content?.pages_done, work.page_count]
  )

  const fade = useCallback((): void => {
    if (animate) flowRef.current?.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 200, easing: 'ease' })
  }, [animate])

  const jumpToBlock = useCallback(
    (index: number): void => {
      const s = sections.findIndex((x) => index >= x.start && index < x.end)
      if (s < 0) return
      pending.current = { block: index }
      setSec(s)
      setTick((t) => t + 1)
    },
    [sections]
  )

  // 本文が読み込まれた(作り直された)ら、読んでいた場所(無ければ今の原本ページ)へ移動する。
  useEffect(() => {
    if (!blocks || blocks.length === 0) return
    const key = anchorKey.current
    jumpToBlock(key ? blockOfKey(blocks, key) : blockOfPage(blocks, pageRef.current))
  }, [blocks, jumpToBlock])

  // 原本のページが外から変わった(目次・しおり・スクラバー)ら、そのページの本文へ移動する。
  useEffect(() => {
    if (!blocks || blocks.length === 0 || page === reported.current.page) return
    reported.current = { ...reported.current, page }
    jumpToBlock(blockOfPage(blocks, page))
  }, [page, blocks, jumpToBlock])

  // 組んだ結果を測る: 各ブロックが何画面目にあるかを調べ、移動先(無ければ読んでいた場所)の画面を出す。
  useLayoutEffect(() => {
    const flow = flowRef.current
    const s = sections[sec]
    if (!flow || !geo || !s) return
    const origin = flow.getBoundingClientRect()
    const extent = vertical ? flow.scrollHeight : flow.scrollWidth
    const count = Math.max(1, Math.ceil((extent + GAP) / geo.stride - 0.01))
    const starts: number[] = []
    const ends: number[] = []
    const at = (r: DOMRect): number =>
      Math.min(
        count - 1,
        Math.max(0, Math.floor(((vertical ? r.top - origin.top : r.left - origin.left) + 2) / geo.stride))
      )
    flow.querySelectorAll<HTMLElement>('[data-b]').forEach((el) => {
      const rects = el.getClientRects()
      const prev = starts.length > 0 ? ends[ends.length - 1] : 0
      starts.push(rects.length > 0 ? at(rects[0]) : prev)
      ends.push(rects.length > 0 ? at(rects[rects.length - 1]) : prev)
    })
    layout.current = { sec, starts, ends, screens: count }
    const p = pending.current
    pending.current = null
    let target = 0
    if (p === 'last') target = count - 1
    else if (p && p !== 'first') target = starts[p.block - s.start] ?? 0
    else if (p === null && anchor.current !== null) target = starts[anchor.current - s.start] ?? 0
    target = Math.min(Math.max(target, 0), count - 1)
    screenRef.current = target
    setScreens(count)
    setScreen(target)
    settle(target)
  }, [sections, sec, geo, vertical, fontSize, tick, showStage, settle])

  const turn = useCallback(
    (dir: 'next' | 'prev'): void => {
      const l = layout.current
      if (!l) return
      const scr = screenRef.current + (dir === 'next' ? 1 : -1)
      if (scr >= 0 && scr < l.screens) {
        screenRef.current = scr
        setScreen(scr)
        settle(scr)
        fade()
        return
      }
      const nextSec = l.sec + (dir === 'next' ? 1 : -1)
      if (nextSec < 0 || nextSec >= sections.length) return
      pending.current = dir === 'next' ? 'first' : 'last'
      setSec(nextSec)
      fade()
    },
    [sections.length, settle, fade]
  )
  useImperativeHandle(ref, () => ({ turn }), [turn])

  // ホイールでもページを送る(回し続けても 1 回ずつ)。
  const wheelAt = useRef(0)
  function onWheel(e: React.WheelEvent): void {
    const d = e.deltaY || e.deltaX
    if (d === 0 || Date.now() - wheelAt.current < 160) return
    wheelAt.current = Date.now()
    turn(d > 0 ? 'next' : 'prev')
  }

  // 図が読み込まれると組みが変わるので測り直す(続けて読み込まれても 1 回にまとめる)。
  const remeasure = useRef(0)
  function onImageLoad(): void {
    cancelAnimationFrame(remeasure.current)
    remeasure.current = requestAnimationFrame(() => setTick((t) => t + 1))
  }
  useEffect(() => () => cancelAnimationFrame(remeasure.current), [])

  const resolveImage = useCallback(
    (src: string): string | null => {
      const m = src.match(FIGURE_SRC_RE)
      return m ? figureUrl(root, work.id, m[1]) : null
    },
    [root, work.id]
  )

  // 区画の本文。ページ送りのたびに作り直さないよう、区画が変わったときだけ作る。
  const current = sections[sec]
  const body = useMemo(
    () =>
      blocks && current
        ? blocks.slice(current.start, current.end).map((b, i) => (
            <div key={current.start + i} data-b={current.start + i} className={`rf-block rf-${b.kind}`}>
              <Markdown text={b.md} className="rf-md" resolveImage={resolveImage} eagerImages />
            </div>
          ))
        : null,
    [blocks, current, resolveImage]
  )

  const doneCount = content?.pages_done ?? 0
  const remaining = work.page_count - doneCount
  const pct = job && job.total > 0 ? Math.round((job.current / job.total) * 100) : 0
  const pageInfo = texts[page]
  const bookPct =
    blocks && blocks.length > 0 && anchor.current !== null
      ? Math.round(((anchor.current + 1) / blocks.length) * 100)
      : 0
  const shift = geo ? screen * geo.stride : 0

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
          remaining > 0 &&
          content && (
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
        {!editing && (
          <>
            <span className="text-toolbar-note">原本 p.{page + 1}</span>
            {pageInfo && pageInfo.low.length > 0 && (
              <span className="text-page-badge" title="このページに、読み取りに自信がない行があります">
                要確認 {pageInfo.low.length}
              </span>
            )}
            {pageInfo?.edited && <span className="text-page-badge">手直し済み</span>}
            <button
              className="btn"
              onClick={() => startEdit(page)}
              disabled={!!job || !pageInfo}
              title="原本のこのページと見比べて本文を直す"
            >
              編集
            </button>
          </>
        )}
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
          onClick={() => void transcribe([editing ? editing.page : page], true)}
          disabled={!!job}
          title="原本のこのページを文字起こしし直します"
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
        <div className="rf-stage" ref={stageRef} onWheel={onWheel}>
          {!content ? (
            <div className="text-empty">読み込み中…</div>
          ) : !blocks || blocks.length === 0 ? (
            <div className="text-empty">
              この本はまだ文字起こししていません。
              <button className="btn" onClick={() => void transcribe()} disabled={!!job}>
                全ページを文字起こし
              </button>
            </div>
          ) : (
            geo && (
              <>
                {/* 画面の端(本文の外の余白)のクリックでページ送り。縦書きは左が次。 */}
                <button
                  className="reader-zone reader-zone-left"
                  style={{ width: geo.padX }}
                  aria-label={vertical ? '次へ' : '前へ'}
                  onClick={() => turn(vertical ? 'next' : 'prev')}
                />
                <div className="rf-viewport" style={{ width: geo.width, height: geo.height }}>
                  <div
                    ref={flowRef}
                    className={`rf-flow book-md ${vertical ? 'is-vertical' : ''}`}
                    style={
                      {
                        width: geo.width,
                        height: geo.height,
                        columnCount: geo.columns,
                        columnGap: GAP,
                        fontSize,
                        transform: vertical ? `translateY(${-shift}px)` : `translateX(${-shift}px)`,
                        '--rf-w': `${(geo.width - GAP * (geo.columns - 1)) / geo.columns}px`,
                        '--rf-h': `${geo.height}px`
                      } as CSSProperties
                    }
                    onLoadCapture={onImageLoad}
                  >
                    {body}
                  </div>
                </div>
                <button
                  className="reader-zone reader-zone-right"
                  style={{ width: geo.padX }}
                  aria-label={vertical ? '前へ' : '次へ'}
                  onClick={() => turn(vertical ? 'prev' : 'next')}
                />
                <div className="rf-foot">
                  {screen + 1} / {screens}
                  {sections.length > 1 && `（${sec + 1} / ${sections.length}）`}・全体の {bookPct}%
                </div>
              </>
            )
          )}
        </div>
      )}
    </div>
  )
})
