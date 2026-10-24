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
  enqueueTranslate,
  figureUrl,
  getContent,
  getQueue,
  getPageText,
  getTranslation,
  getTranslationLive,
  lookupWord,
  pageUrl,
  savePageText,
  type BookContent,
  type BookTranslation,
  type ContentBlock,
  type DictionaryResult,
  type LowLine,
  type PageText,
  type TranscribeEngine,
  type TranslatedBlock,
  type TranslationLive,
  type Work
} from './api'
import { fmtElapsed } from './format'
import { Markdown } from './Markdown'
import { textFontOf, type TextFont } from './textFonts'

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
  /** 本文の文字の太さ(CSS の font-weight) */
  weight: number
  /** 本文の書体 */
  font: TextFont
  /** 本文の面の配色(黒 / セピア / 白) */
  theme: TextTheme
  /** ページ送りのフェードを出すか */
  animate: boolean
  /** 文字起こしのエンジン(設定) */
  engine: TranscribeEngine
  /** 英語の本の訳文の出し方(原文だけ / 訳文だけ / 対訳)。日本語の本は off */
  translation: TranslationMode
  /** 対訳で原文と訳文を並べる単位 */
  pairUnit: PairUnit
  /** 訳の種類(id と、ツールバーに出す名前) */
  trStyle: string
  trStyleName: string
  /** LLM が読み込まれているか(翻訳に必要) */
  llmReady: boolean
  /** 英語の本で、単語にマウスを乗せると英和辞書を引く */
  dictionary: boolean
  /** 検索結果から開いた箇所。その段落へ移動し、語をハイライトする */
  jump: TextJump | null
}

/** 検索結果から開いた箇所。block はアプリ用の本文のブロックの添字、seq は開くたびに変わる通し番号。 */
export interface TextJump {
  page: number
  block: number
  terms: string[]
  seq: number
}

export type TranslationMode = 'off' | 'ja' | 'both'
export type PairUnit = 'sentence' | 'paragraph' | 'section'

/** 本文の面の配色。auto はアプリのテーマのまま、ほかは styles.css の .rf-stage.theme-* で差し替える。 */
export type TextTheme = 'auto' | 'dark' | 'sepia' | 'light'

/** リーダーからのページ送り(キーボード)を受ける。 */
export interface TextViewHandle {
  turn: (dir: 'next' | 'prev') => void
}

/** 本文中の図の参照(../figures/p0001-1.png)だけを表示する。それ以外は読み込まない。 */
const FIGURE_SRC_RE = /^\.\.\/figures\/(p\d{4}-\d+\.png)$/

type Job = {
  state: 'queued' | 'running'
  current: number
  total: number
  /** 実行中のジョブの経過秒(キューから受け取った時点の値) */
  elapsed?: number
} | null

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

/**
 * 本ごとに、テキスト表示で最後に読んでいた画面の先頭を覚えておく(localStorage)。
 * 原本のページ番号(last_page)だけでは 1 ページが何画面にもまたがるため、開き直すと画面単位の位置がずれる。
 * reached はそのとき伝えた原本のページ。画像表示などで last_page が変わっていたら使わない。
 */
const ANCHOR_STORE = 'readerTextAnchors'

function loadAnchor(workId: string, page: number): AnchorKey | null {
  try {
    const v = JSON.parse(localStorage.getItem(ANCHOR_STORE) ?? '{}')[workId]
    if (v && v.reached === page && typeof v.page === 'number' && typeof v.ord === 'number') {
      return { page: v.page, ord: v.ord }
    }
  } catch {
    // 壊れた値は無視して原本のページから開く
  }
  return null
}

function saveAnchor(workId: string, key: AnchorKey, reached: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(ANCHOR_STORE) ?? '{}')
    all[workId] = { ...key, reached }
    localStorage.setItem(ANCHOR_STORE, JSON.stringify(all))
  } catch {
    // 保存できなくても読むのは続けられる
  }
}

/** マウスを乗せてから辞書を引くまでの時間(ms)。読んでいるだけで次々に開かないように少し待つ。 */
const DICT_DELAY = 450
const DICT_WIDTH = 280

/** 辞書のポップアップ。x / y は本文の面(.rf-stage)の中の位置。 */
interface DictPopup {
  word: string
  /** 単語の位置(画面座標)。ポインタがここから出たら閉じる */
  rect: DOMRect
  /** 単語の範囲(開いている間ハイライトする) */
  range: Range
  x: number
  y: number
  /** 単語の上に出す(下に余裕が無いとき) */
  above: boolean
  result: DictionaryResult | null
  error: string | null
}

/** 英単語の字(語の途中のアポストロフィを含む。ハイフンでは分ける)。 */
const WORD_CHAR_RE = /[A-Za-z'’]/

/** 画面座標の下にある英単語と、その範囲。英語の本文(訳文 .rf-ja を除く)の上でなければ null。 */
function wordAt(
  flow: HTMLElement,
  x: number,
  y: number
): { word: string; rect: DOMRect; range: Range } | null {
  const range = document.caretRangeFromPoint?.(x, y)
  const node = range?.startContainer
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return null
  const el = node.parentElement
  if (!el || !flow.contains(el) || el.closest('.rf-ja')) return null
  const text = node.textContent ?? ''
  let s = range.startOffset
  let e = s
  while (s > 0 && WORD_CHAR_RE.test(text[s - 1])) s--
  while (e < text.length && WORD_CHAR_RE.test(text[e])) e++
  while (s < e && /['’]/.test(text[s])) s++
  while (e > s && /['’]/.test(text[e - 1])) e--
  if (e - s < 2) return null
  const r = document.createRange()
  r.setStart(node, s)
  r.setEnd(node, e)
  const rect = r.getBoundingClientRect()
  // caretRangeFromPoint は余白の上でも近くの字を返すので、本当に単語の上かを確かめる
  if (x < rect.left - 1 || x > rect.right + 1 || y < rect.top - 1 || y > rect.bottom + 1) return null
  return { word: text.slice(s, e), rect, range: r }
}

/** 辞書を引いている単語のハイライト(CSS Custom Highlight API。DOM を変えないので組みは変わらない)。 */
const DICT_HIGHLIGHT = 'dict-word'
/** 検索結果から開いたときの、検索した語のハイライト(同上)。 */
const SEARCH_HIGHLIGHT = 'search-hit'

/**
 * 検索結果の箇所のブロック。索引を作った後に本文を直すと添字がずれるので、そのブロックに語が無ければ
 * 同じページで語を含むブロックを探す。それも無ければ、ページが合っていればそのブロック(英語の本を
 * 訳文の語で探したときは原文に語が無い)、合っていなければページの先頭のブロックにする。
 */
function blockOfJump(blocks: ContentBlock[], jump: TextJump): number {
  const terms = jump.terms.map((t) => t.toLowerCase())
  const has = (b: ContentBlock | undefined): boolean =>
    !!b && b.page === jump.page && terms.some((t) => b.md.toLowerCase().includes(t))
  if (has(blocks[jump.block])) return jump.block
  const i = blocks.findIndex(has)
  if (i >= 0) return i
  return blocks[jump.block]?.page === jump.page ? jump.block : blockOfPage(blocks, jump.page)
}

/** 辞書の意味の『』(主な意味)を太字にする。 */
function DictMeaning({ text }: { text: string }): JSX.Element {
  const parts = text.split(/『|』/)
  return <>{parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}</>
}

/** 段落の右クリックのメニューの幅。 */
const BLOCK_MENU_WIDTH = 220

/** 訳す対象のブロックか(バックエンドの translate._translatable と同じ: 段落・見出し・箇条・引用。場面転換は除く)。 */
function isTranslatableBlock(b: ContentBlock | undefined): boolean {
  return (
    !!b && ['p', 'heading', 'list', 'quote'].includes(b.kind) && !/^\*{3,}\s*$/.test(b.md.trim())
  )
}

/** 対訳を節の単位でまとめるときの区切り(見出しと場面転換の ***)。 */
function isSectionBoundary(b: ContentBlock): boolean {
  return b.kind === 'heading' || /^\*{3,}\s*$/.test(b.md.trim())
}

/** 訳したブロックの訳文(見出し・箇条の記号を付けて Markdown にする)。 */
function jaText(t: TranslatedBlock): string {
  return t.head + t.pairs.map((p) => p.ja).join('')
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
  {
    root,
    work,
    page,
    onPageChange,
    vertical,
    columns,
    fontSize,
    weight,
    font,
    theme,
    animate,
    engine,
    translation,
    pairUnit,
    trStyle,
    trStyleName,
    llmReady,
    dictionary,
    jump
  },
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
          // やり直したページの補助情報(要確認の行・手直し済み)も古いので捨てて、今のページだけ取り直す。
          setTexts({})
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

  // ---- 日本語訳(英語の本) ----

  const isEnglish = work.language === 'en'
  const [tr, setTr] = useState<BookTranslation | null>(null)
  const [trJob, setTrJob] = useState<Job>(null)
  // 訳の種類は ref で持つ(翻訳中の監視ループが古い種類の訳を取り続けないように)。
  const trStyleRef = useRef(trStyle)
  trStyleRef.current = trStyle
  const reloadTranslation = useCallback(async (): Promise<void> => {
    const style = trStyleRef.current
    const t = await getTranslation(root, work.id, style)
    if (trStyleRef.current === style) setTr(t)
  }, [root, work.id])
  // 本文が作り直されたら(文字起こし・手直し)、訳の種類を変えたら、訳の対応も取り直す。
  const signature = content?.signature
  useEffect(() => {
    if (!isEnglish || !signature) return
    reloadTranslation().catch((e) => setError((e as Error).message))
  }, [isEnglish, signature, trStyle, reloadTranslation])

  // 翻訳中の途中経過(LLM が書いている途中の訳文)。訳文を出しているときだけ取りに行く。
  const [live, setLive] = useState<TranslationLive | null>(null)
  const translationRef = useRef(translation)
  translationRef.current = translation

  // 翻訳の進み具合を追う。1 秒ごとに途中経過を取り、まとまりが保存されたら(進み具合が変わったら)
  // 訳を読み込み直す。訳しながら読める。
  const trPolling = useRef(false)
  const watchTranslate = useCallback((): void => {
    if (trPolling.current) return
    trPolling.current = true
    let lastCurrent = -1
    const tick = async (): Promise<void> => {
      if (!alive.current) {
        trPolling.current = false
        return
      }
      try {
        const q = await getQueue()
        const cur = q.current?.work_id === work.id && q.current.kind === 'translate' ? q.current : null
        const pending = q.pending.some((j) => j.work_id === work.id && j.kind === 'translate')
        if (cur) setTrJob({ state: 'running', current: cur.current, total: cur.total, elapsed: cur.elapsed })
        else if (pending) setTrJob({ state: 'queued', current: 0, total: 0 })
        const progressed = cur !== null && cur.current !== lastCurrent
        lastCurrent = cur ? cur.current : -1
        if (progressed) await reloadTranslation()
        if (cur && translationRef.current !== 'off') {
          const next = await getTranslationLive(work.id)
          // 途中経過が変わっていなければ組み直さない(本文全体の再描画・再計測を避ける)。
          setLive((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
        }
        if (!cur && !pending) {
          setLive(null)
          const recent = q.recent.filter((r) => r.work_id === work.id && r.kind === 'translate')
          const last = recent[recent.length - 1]
          if (last?.status === 'error') setError(last.error ?? '翻訳に失敗しました')
          await reloadTranslation()
          setTrJob(null)
          trPolling.current = false
          return
        }
      } catch {
        // 一時的な取得失敗は次の周期で取り直す
      }
      setTimeout(() => void tick(), 1000)
    }
    void tick()
  }, [work.id, reloadTranslation])

  // 翻訳の経過時間。キューの値の間も 1 秒ごとに進めて見せる。
  const [trElapsed, setTrElapsed] = useState(0)
  const trBase = trJob?.elapsed
  useEffect(() => {
    if (trBase === undefined) return
    const at = Date.now()
    setTrElapsed(trBase)
    const id = setInterval(() => setTrElapsed(trBase + Math.floor((Date.now() - at) / 1000)), 1000)
    return () => clearInterval(id)
  }, [trBase])

  // 開いた時点で既に翻訳中なら進み具合を追う。
  useEffect(() => {
    if (!isEnglish) return
    getQueue()
      .then((q) => {
        const active =
          (q.current?.work_id === work.id && q.current.kind === 'translate') ||
          q.pending.some((j) => j.work_id === work.id && j.kind === 'translate')
        if (active) watchTranslate()
      })
      .catch(() => {})
  }, [isEnglish, work.id, watchTranslate])

  async function translate(opts: { redo?: boolean; stale?: boolean; blocks?: number[] } = {}): Promise<void> {
    setError(null)
    try {
      await enqueueTranslate(root, work.id, trStyle, opts)
      setTrJob({ state: 'queued', current: 0, total: 0 })
      watchTranslate()
    } catch (e) {
      setError((e as Error).message)
    }
  }

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
  // 書体。同梱の書体は使われてから読み込まれるので、読み込みが済んだら測り直す
  // (読み込み前の代わりの書体で組んだままにしない)。
  const fontFamily = textFontOf(font).family
  useEffect(() => {
    if (!fontFamily) return
    let alive = true
    void document.fonts.load(`${weight} 16px ${fontFamily}`, 'あ').then(() => {
      if (alive) setTick((t) => t + 1)
    })
    return () => {
      alive = false
    }
  }, [fontFamily, weight])
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
  // 検索結果から開いた箇所(済んだものの seq を覚えて、同じ指示で二度動かない)と、ハイライトする語。
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  const handledJump = useRef<number | null>(null)
  const [searchTerms, setSearchTerms] = useState<string[] | null>(null)

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
      saveAnchor(work.id, anchorKey.current, reached)
    },
    [blocks, sections, content?.pages_done, work.id, work.page_count]
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

  // 本文が作り直されたら(文字起こしの進行・やり直し)、読んでいた場所へ戻る。
  // 開いた直後の位置は、測る処理(下の useLayoutEffect)が最初の画面を出す前に決める。
  useEffect(() => {
    if (!blocks || blocks.length === 0) return
    const key = anchorKey.current
    if (key) jumpToBlock(blockOfKey(blocks, key))
  }, [blocks, jumpToBlock])

  // 原本のページが外から変わった(目次・しおり・スクラバー)ら、そのページの本文へ移動する。
  useEffect(() => {
    if (!blocks || blocks.length === 0 || page === reported.current.page) return
    reported.current = { ...reported.current, page }
    setSearchTerms(null)
    jumpToBlock(blockOfPage(blocks, page))
  }, [page, blocks, jumpToBlock])

  // 検索結果から開いた箇所へ移動し、語をハイライトする。開いた直後は下の測る処理が最初の画面で合わせる。
  useEffect(() => {
    if (!jump) {
      setSearchTerms(null)
      return
    }
    if (!blocks || blocks.length === 0 || handledJump.current === jump.seq) return
    handledJump.current = jump.seq
    setSearchTerms(jump.terms)
    jumpToBlock(blockOfJump(blocks, jump))
  }, [jump, blocks, jumpToBlock])

  const resolveImage = useCallback(
    (src: string): string | null => {
      const m = src.match(FIGURE_SRC_RE)
      return m ? figureUrl(root, work.id, m[1]) : null
    },
    [root, work.id]
  )

  // 区画の本文。ページ送りのたびに作り直さないよう、区画が変わったときだけ作る。
  // 英語の本で訳文を出すときは、ブロック(data-b。位置の基準)はそのままに、中身を訳文・対訳にする。
  const current = sections[sec]
  // 保存済みの訳に、翻訳中のまとまりの途中経過を重ねる。
  const trBlocks = useMemo(() => {
    // 種類を変えた直後の、前の種類の訳は出さない(読み込み直すまで原文)
    if (translation === 'off' || !tr || !content || tr.signature !== content.signature || tr.style !== trStyle) {
      return null
    }
    const liveBlocks =
      live && live.signature === content.signature && live.style === trStyle ? Object.entries(live.blocks) : []
    if (liveBlocks.length === 0) return tr.blocks
    const merged = tr.blocks.slice()
    for (const [k, b] of liveBlocks) merged[Number(k)] = b
    return merged
  }, [translation, tr, content, live, trStyle])
  const body = useMemo(() => {
    if (!blocks || !current) return null
    const md = (text: string, className = 'rf-md'): JSX.Element => (
      <Markdown text={text} className={className} resolveImage={resolveImage} eagerImages />
    )
    const out: JSX.Element[] = []
    // 節の単位の対訳: 区切り(見出し・場面転換)までの訳文を、まとめて原文の後に出す。
    let group: JSX.Element[] = []
    const flush = (key: string): void => {
      if (group.length > 0) out.push(<div key={key} className="rf-ja-group">{group}</div>)
      group = []
    }
    for (let i = current.start; i < current.end; i++) {
      const b = blocks[i]
      const t = trBlocks?.[i] ?? null
      const cls = `rf-block rf-${b.kind}`
      if (pairUnit === 'section' && translation === 'both' && isSectionBoundary(b)) flush(`g${i}`)
      if (!t) {
        // 訳さないブロック(図など)と、まだ訳していないブロックは原文のまま
        out.push(<div key={i} data-b={i} className={cls}>{md(b.md)}</div>)
      } else if (translation === 'ja') {
        out.push(<div key={i} data-b={i} className={cls}>{md(jaText(t))}</div>)
      } else if (pairUnit === 'sentence') {
        out.push(
          <div key={i} data-b={i} className={`${cls} rf-pairs`}>
            {t.pairs.map((p, k) => (
              <div key={k} className="rf-pair">
                {md((k === 0 ? t.head : '') + p.en)}
                {md((k === 0 ? t.head : '') + p.ja, 'rf-md rf-ja')}
              </div>
            ))}
          </div>
        )
      } else if (pairUnit === 'paragraph' || b.kind === 'heading') {
        out.push(
          <div key={i} data-b={i} className={cls}>
            {md(b.md)}
            {md(jaText(t), 'rf-md rf-ja')}
          </div>
        )
      } else {
        out.push(<div key={i} data-b={i} className={cls}>{md(b.md)}</div>)
        group.push(<div key={i}>{md(jaText(t), 'rf-md rf-ja')}</div>)
      }
    }
    flush('g-end')
    return out
  }, [blocks, current, resolveImage, trBlocks, translation, pairUnit])

  // 組んだ結果を測る: 各ブロックが何画面目にあるかを調べ、移動先(無ければ読んでいた場所)の画面を出す。
  useLayoutEffect(() => {
    const flow = flowRef.current
    const s = sections[sec]
    if (!flow || !geo || !s || !blocks) return
    // 開いた直後(まだどの画面も出していない)は、前回の続きの画面(無ければ今の原本ページ)から始める。
    // ここで決めずに測ると先頭の画面で落ち着き、「1 ページ目を表示中」とリーダーへ伝えて保存されてしまう。
    if (pending.current === null && anchor.current === null) {
      const j = jumpRef.current
      if (j && handledJump.current !== j.seq) {
        handledJump.current = j.seq
        setSearchTerms(j.terms)
        pending.current = { block: blockOfJump(blocks, j) }
      } else {
        const key = loadAnchor(work.id, pageRef.current)
        pending.current = { block: key ? blockOfKey(blocks, key) : blockOfPage(blocks, pageRef.current) }
      }
    }
    // 移動先が別の区画なら、その区画を組んでから測る(今の区画で測って落ち着かない)。
    const p0 = pending.current
    if (p0 !== null && typeof p0 === 'object' && (p0.block < s.start || p0.block >= s.end)) {
      const target = sections.findIndex((x) => p0.block >= x.start && p0.block < x.end)
      if (target >= 0) {
        setSec(target)
        return
      }
    }
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
  }, [sections, sec, geo, vertical, fontSize, weight, font, tick, showStage, settle, blocks, work.id, body])

  // ---- 辞書(英語の本。単語にマウスを乗せて引く) ----

  const [dict, setDict] = useState<DictPopup | null>(null)
  const dictRef = useRef<DictPopup | null>(null)
  dictRef.current = dict
  const dictCache = useRef(new Map<string, DictionaryResult>())
  const dictTimer = useRef(0)
  const overPopup = useRef(false)
  const dictEnabled = dictionary && isEnglish && translation !== 'ja'

  const closeDict = useCallback((): void => {
    window.clearTimeout(dictTimer.current)
    setDict(null)
  }, [])

  function onFlowMouseMove(e: React.MouseEvent): void {
    if (!dictEnabled) return
    const { clientX: x, clientY: y } = e
    const open = dictRef.current
    if (open) {
      const r = open.rect
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return
      setDict(null)
    }
    window.clearTimeout(dictTimer.current)
    dictTimer.current = window.setTimeout(() => {
      const flow = flowRef.current
      const stage = stageRef.current
      if (!flow || !stage) return
      const hit = wordAt(flow, x, y)
      if (!hit) return
      const box = stage.getBoundingClientRect()
      const above = hit.rect.bottom + 220 > box.bottom
      const key = hit.word.toLowerCase()
      const popup: DictPopup = {
        word: hit.word,
        rect: hit.rect,
        range: hit.range,
        x: Math.min(Math.max(hit.rect.left - box.left, 8), box.width - DICT_WIDTH - 8),
        y: above ? box.bottom - hit.rect.top + 4 : hit.rect.bottom - box.top + 4,
        above,
        result: dictCache.current.get(key) ?? null,
        error: null
      }
      setDict(popup)
      if (popup.result) return
      lookupWord(hit.word)
        .then((res) => {
          dictCache.current.set(key, res)
          setDict((d) => (d && d.word === hit.word ? { ...d, result: res } : d))
        })
        .catch((err) =>
          setDict((d) => (d && d.word === hit.word ? { ...d, error: (err as Error).message } : d))
        )
    }, DICT_DELAY)
  }

  function onFlowMouseLeave(): void {
    window.clearTimeout(dictTimer.current)
    // ポップアップへ移ったときは閉じない(意味を読んだり選んだりできるように)
    window.setTimeout(() => {
      if (!overPopup.current) setDict(null)
    }, 120)
  }

  // 開いている間、引いている単語をハイライトする。
  const dictRange = dict?.range
  useEffect(() => {
    if (!dictRange || typeof Highlight === 'undefined') return
    CSS.highlights.set(DICT_HIGHLIGHT, new Highlight(dictRange))
    return () => {
      CSS.highlights.delete(DICT_HIGHLIGHT)
    }
  }, [dictRange])

  // 検索した語を、今の区画の本文の中でハイライトする(区画を移ったら消す)。
  useEffect(() => {
    const flow = flowRef.current
    if (!searchTerms || !flow || typeof Highlight === 'undefined') return
    const needles = searchTerms.map((t) => t.toLowerCase()).filter((t) => t !== '')
    const ranges: Range[] = []
    const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? '').toLowerCase()
      for (const t of needles) {
        for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length)) {
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + t.length)
          ranges.push(r)
        }
      }
    }
    CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...ranges))
    return () => {
      CSS.highlights.delete(SEARCH_HIGHLIGHT)
    }
  }, [searchTerms, body, showStage])

  // ページを送ったら・辞書を切ったら閉じる。Escape でも閉じる。
  useEffect(() => {
    closeDict()
  }, [screen, sec, dictEnabled, closeDict])
  // 訳し直すのメニュー(この画面 / 全部)
  const [redoMenu, setRedoMenu] = useState(false)
  // 段落の右クリックのメニュー(この段落 / この画面を訳す)。x / y は本文の面(.rf-stage)の中の位置。
  const [blockMenu, setBlockMenu] = useState<{ block: number; x: number; y: number } | null>(null)
  useEffect(() => {
    setBlockMenu(null)
  }, [screen, sec])

  // 辞書やメニューが開いている間の Escape は、それを閉じるだけにする。リーダーは Escape で一覧へ戻るので、
  // 先に(capture で)受けて止める。
  const popupOpen = !!dict || redoMenu || !!blockMenu
  useEffect(() => {
    if (!popupOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeDict()
      setRedoMenu(false)
      setBlockMenu(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [popupOpen, closeDict])

  // 英語の本の訳文を出しているとき、段落を右クリックすると、その段落・この画面だけを訳すメニューを出す。
  function onFlowContextMenu(e: React.MouseEvent): void {
    if (!isEnglish || translation === 'off' || !blocks) return
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-b]')
    const stage = stageRef.current
    if (!el || !stage) return
    const index = Number(el.dataset.b)
    if (!isTranslatableBlock(blocks[index])) return
    e.preventDefault()
    closeDict()
    const box = stage.getBoundingClientRect()
    setBlockMenu({
      block: index,
      x: Math.min(e.clientX - box.left, box.width - BLOCK_MENU_WIDTH - 8),
      y: Math.min(e.clientY - box.top, box.height - 120)
    })
  }

  /** 今の画面に出ているブロック(blocks の添字)。 */
  function blocksOnScreen(): number[] {
    const l = layout.current
    const s = l ? sections[l.sec] : undefined
    if (!l || !s) return []
    const out: number[] = []
    l.starts.forEach((st, i) => {
      if (st <= screenRef.current && l.ends[i] >= screenRef.current) out.push(s.start + i)
    })
    return out
  }
  useEffect(() => () => window.clearTimeout(dictTimer.current), [])

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
      setSearchTerms(null)
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
        {isEnglish && (translation !== 'off' || trJob) && (
          <>
            <span
              className="text-toolbar-note"
              title={
                tr && tr.models.length > 0
                  ? `訳の種類: ${trStyleName}\n訳したモデル: ${tr.models.map((m) => `${m.model || '記録なし'}（${m.blocks} 段落）`).join('、')}`
                  : `訳の種類: ${trStyleName}`
              }
            >
              {trStyleName} {tr?.done ?? 0} / {tr?.total ?? 0}
            </span>
            {trJob ? (
              <>
                <span className="analyze-bar text-toolbar-bar">
                  <span
                    className="analyze-bar-fill"
                    style={{
                      width: `${trJob.total > 0 ? Math.round((trJob.current / trJob.total) * 100) : 0}%`
                    }}
                  />
                </span>
                <span className="text-toolbar-note">
                  {trJob.state === 'queued'
                    ? '順番待ち…'
                    : `翻訳中 ${trJob.current}/${trJob.total} ・ ${fmtElapsed(trElapsed)}`}
                </span>
                <button className="btn" onClick={() => void cancelJob(work.id)}>
                  中止
                </button>
              </>
            ) : (
              tr && (
                <>
                  {tr.total > tr.done && (
                    <button
                      className="btn"
                      onClick={() => void translate()}
                      disabled={!llmReady}
                      title={
                        llmReady
                          ? 'まだ訳していない段落を先頭から順に日本語に訳します（時間がかかります。読みながら待てます）'
                          : 'モデルを読み込むと翻訳できます'
                      }
                    >
                      残り {tr.total - tr.done} 段落を翻訳
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      const blocks = blocksOnScreen()
                      if (blocks.length > 0) void translate({ blocks })
                    }}
                    disabled={!llmReady}
                    title={
                      llmReady
                        ? '今の画面に出ている段落を訳します（訳してある段落は訳し直します）。段落を右クリックすると、その段落だけを訳せます'
                        : 'モデルを読み込むと翻訳できます'
                    }
                  >
                    この画面を訳す
                  </button>
                  {tr.done > 0 && (
                    <div className="text-redo">
                      <button
                        className="btn"
                        onClick={() => setRedoMenu((v) => !v)}
                        disabled={!llmReady}
                        aria-haspopup="menu"
                        aria-expanded={redoMenu}
                        title={
                          llmReady
                            ? '今読み込んでいるモデルで訳し直します（モデルを変えて訳を比べるときなど）'
                            : 'モデルを読み込むと訳し直せます'
                        }
                      >
                        訳し直す
                      </button>
                      {redoMenu && (
                        <>
                          <div className="popup-backdrop" onClick={() => setRedoMenu(false)} />
                          <div className="ex-popup text-redo-menu" role="menu" aria-label="訳し直す">
                            {tr.stale > 0 && (
                              <button
                                className="ex-popup-item"
                                role="menuitem"
                                onClick={() => {
                                  setRedoMenu(false)
                                  void translate({ stale: true })
                                }}
                              >
                                指示を書き直す前の段落を訳し直す（{tr.stale}）
                              </button>
                            )}
                            <button
                              className="ex-popup-item"
                              role="menuitem"
                              onClick={() => {
                                setRedoMenu(false)
                                if (
                                  window.confirm(
                                    `訳した ${tr.done} 段落をすべて、今のモデルで訳し直します（時間がかかります。人名などの訳語はそのまま使います）。よろしいですか？`
                                  )
                                ) {
                                  void translate({ redo: true })
                                }
                              }}
                            >
                              全部を訳し直す…
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )
            )}
          </>
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
        <div
          className={`rf-stage ${theme === 'auto' ? '' : `theme-${theme}`}`}
          ref={stageRef}
          onWheel={onWheel}
        >
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
                <div
                  className="rf-viewport"
                  style={{ width: geo.width, height: geo.height }}
                  onMouseMove={onFlowMouseMove}
                  onMouseLeave={onFlowMouseLeave}
                  onContextMenu={onFlowContextMenu}
                >
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
                        fontFamily: fontFamily ?? undefined,
                        fontWeight: weight,
                        '--rf-weight': weight,
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
                {blockMenu && tr && (
                  <>
                    <div className="popup-backdrop" onClick={() => setBlockMenu(null)} />
                    <div
                      className="ex-popup block-menu"
                      role="menu"
                      aria-label="段落の翻訳"
                      style={{ left: blockMenu.x, top: blockMenu.y, width: BLOCK_MENU_WIDTH }}
                    >
                      {(() => {
                        const why = !llmReady
                          ? 'モデルを読み込むと訳せます'
                          : trJob
                            ? '翻訳が終わるか、中止してから使えます'
                            : undefined
                        const translated = !!tr.blocks[blockMenu.block]
                        return (
                          <>
                            <button
                              className="ex-popup-item"
                              role="menuitem"
                              disabled={!!why}
                              title={why}
                              onClick={() => {
                                const b = blockMenu.block
                                setBlockMenu(null)
                                void translate({ blocks: [b] })
                              }}
                            >
                              {translated ? 'この段落を訳し直す' : 'この段落を訳す'}
                            </button>
                            <button
                              className="ex-popup-item"
                              role="menuitem"
                              disabled={!!why}
                              title={why}
                              onClick={() => {
                                setBlockMenu(null)
                                const bs = blocksOnScreen()
                                if (bs.length > 0) void translate({ blocks: bs })
                              }}
                            >
                              この画面の段落を訳す
                            </button>
                          </>
                        )
                      })()}
                    </div>
                  </>
                )}
                {dict && (
                  <div
                    className="ex-popup dict-popup"
                    role="tooltip"
                    style={
                      dict.above
                        ? { left: dict.x, top: 'auto', bottom: dict.y, width: DICT_WIDTH }
                        : { left: dict.x, top: dict.y, width: DICT_WIDTH }
                    }
                    onMouseEnter={() => {
                      overPopup.current = true
                    }}
                    onMouseLeave={() => {
                      overPopup.current = false
                      setDict(null)
                    }}
                  >
                    {dict.error ? (
                      <div className="dict-note">辞書を引けませんでした: {dict.error}</div>
                    ) : !dict.result ? (
                      <div className="dict-note">{dict.word} を引いています…</div>
                    ) : dict.result.entries.length === 0 ? (
                      <div className="dict-note">「{dict.word}」は辞書にありません</div>
                    ) : (
                      dict.result.entries.map((en, i) => (
                        <div key={i} className="dict-entry">
                          <div className="dict-word">{en.word}</div>
                          <ul className="dict-meanings">
                            {en.meanings.map((m, k) => (
                              <li key={k}>
                                <DictMeaning text={m} />
                              </li>
                            ))}
                          </ul>
                          {en.more > 0 && <div className="dict-note">ほか {en.more} 件</div>}
                        </div>
                      ))
                    )}
                  </div>
                )}
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
