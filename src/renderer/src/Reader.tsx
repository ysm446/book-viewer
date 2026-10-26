import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  addBookmark,
  addHighlight,
  addWorkTag,
  deleteBookmark,
  deleteHighlight,
  listBookmarks,
  listHighlights,
  updateHighlight,
  pageUrl,
  removeWorkTag,
  saveReadingState,
  getTranslationStyles,
  setWorkDirection,
  setWorkLanguage,
  setWorkSpreadOffset,
  setWorkWritingMode,
  type BookLanguage,
  type Bookmark,
  type Direction,
  type Highlight,
  type HighlightColor,
  type HighlightPart,
  type SpreadOffset,
  type TranslationStyle,
  type Work,
  type WritingMode
} from './api'
import { HighlightPanel } from './HighlightPanel'
import { PageScrubber } from './PageScrubber'
import { ReaderChat } from './ReaderChat'
import {
  TextView,
  type HighlightPlace,
  type PairUnit,
  type TextJump,
  type TextTheme,
  type TextViewHandle,
  type TranslationMode
} from './TextView'
import {
  TEXT_FONTS,
  nearestWeight,
  parseTextFont,
  textFontOf,
  weightName,
  type TextFont
} from './textFonts'
import { TocPanel } from './TocPanel'
import { TranslationStylesDialog } from './TranslationStylesDialog'
import { useStoredFlag } from './useStoredFlag'
import type { AppSettings } from '../../preload'

const CHAT_MIN = 260
const CHAT_DEFAULT = 340

/**
 * チャットに渡す本文の上限(文字数)。日本語は 1 トークンあたりおよそ 1〜1.5 文字なので、
 * コンテキスト長の半分程度を本文に回し、残りを指示・会話履歴・回答に空けておく。
 */
function chatContextChars(ctxSize: number): number {
  return Math.min(Math.max(Math.floor(ctxSize * 0.5), 2000), 60000)
}

/** 画像(スクリーンショット)で読むか、文字起こしした本文で読むか。 */
type ViewMode = 'image' | 'text'

/** 表示設定バーのタブ(本 / 文字 / 訳・辞書)。 */
type DisplayTab = 'book' | 'text' | 'translation'

/** テキスト表示の本文の組み方。book は原本の書字方向どおり。 */
type TextLayout = 'book' | 'horizontal' | 'vertical'
const TEXT_LAYOUTS: { value: TextLayout; label: string }[] = [
  { value: 'book', label: '原本どおり' },
  { value: 'horizontal', label: '横書き' },
  { value: 'vertical', label: '縦書き' }
]

/** 英語の本の訳文の出し方(原文だけ / 訳文だけ / 対訳)と、対訳でまとめる単位。 */
const TRANSLATION_MODES: { value: TranslationMode; label: string }[] = [
  { value: 'off', label: '原文' },
  { value: 'ja', label: '訳文' },
  { value: 'both', label: '対訳' }
]
const PAIR_UNITS: { value: PairUnit; label: string }[] = [
  { value: 'sentence', label: '文' },
  { value: 'paragraph', label: '段落' },
  { value: 'section', label: '節' }
]

/** テキスト表示の本文の面の配色(テーマどおり = アプリのテーマのまま)。 */
const TEXT_THEMES: { value: TextTheme; label: string }[] = [
  { value: 'auto', label: 'テーマどおり' },
  { value: 'dark', label: '黒' },
  { value: 'sepia', label: 'セピア' },
  { value: 'light', label: '白' }
]

/** テキスト表示の本文の文字サイズ(px)。 */
const TEXT_SIZES: { value: number; label: string }[] = [
  { value: 14, label: '小' },
  { value: 16, label: '中' },
  { value: 18, label: '大' },
  { value: 20, label: '特大' }
]

/**
 * 本ごとのテキスト表示の設定(組み方・文字サイズ・書体・背景)。localStorage に本の id ごとに持つ。
 * その本で一度も変えていなければ、最後に使った設定(readerText* の各キー)で開く。
 */
interface TextPrefs {
  layout: TextLayout
  size: number
  /** 文字の太さ(CSS の font-weight。書体に用意された太さから選ぶ) */
  weight?: number
  font: TextFont
  surface: TextTheme
  /** 英語の本の訳文の出し方と対訳の単位(その本だけ。ほかの本には引き継がない) */
  translation?: TranslationMode
  pairUnit?: PairUnit
  /** 訳の種類の id */
  trStyle?: string
  /** 旧形式(アプリのテーマが無かった頃の背景。黒は既定の意味だった)。読むだけ */
  theme?: string
}
const TEXT_PREFS_STORE = 'readerTextPrefs'

/** 本文の背景の保存値を読む。旧形式の黒は「既定」の意味だったので、テーマどおりとして引き継ぐ。 */
function parseTextTheme(surface: unknown, legacy: unknown): TextTheme | undefined {
  if (surface === 'auto' || surface === 'dark' || surface === 'sepia' || surface === 'light') return surface
  if (legacy === 'sepia' || legacy === 'light') return legacy
  return undefined
}

function loadBookTextPrefs(workId: string): Partial<TextPrefs> {
  try {
    return JSON.parse(localStorage.getItem(TEXT_PREFS_STORE) ?? '{}')[workId] ?? {}
  } catch {
    return {}
  }
}

function saveBookTextPrefs(workId: string, prefs: TextPrefs): void {
  try {
    const all = JSON.parse(localStorage.getItem(TEXT_PREFS_STORE) ?? '{}')
    all[workId] = prefs
    localStorage.setItem(TEXT_PREFS_STORE, JSON.stringify(all))
  } catch {
    // 保存できなくても表示は続けられる
  }
}

interface ReaderProps {
  root: string
  work: Work
  settings: AppSettings
  /** 本ごとの方向上書きが変わったとき、一覧側へ反映する。 */
  onDirectionChange?: (workId: string, direction: Direction) => void
  /** 既読位置が変わったとき、一覧側へ反映する。 */
  onProgress?: (workId: string, page: number, completed: boolean) => void
  /** 書字方向が変わったとき、一覧側へ反映する。 */
  onWritingModeChange?: (workId: string, writingMode: WritingMode) => void
  /** 本の言語が変わったとき、一覧側へ反映する。 */
  onLanguageChange?: (workId: string, language: BookLanguage) => void
  /** 見開きオフセットの上書きが変わったとき、一覧側へ反映する。 */
  onSpreadOffsetChange?: (workId: string, offset: SpreadOffset) => void
  /** タグ候補(既存タグ一覧)。 */
  allTags?: string[]
  /** タグが変わったとき、一覧側へ反映する。 */
  onTagsChange?: (workId: string, tags: string[]) => void
  /** 目次・要約パネルの開閉(本をまたいで保持するため App 側で持つ)。 */
  showInfo: boolean
  onShowInfoChange: (v: boolean) => void
  /** LLM が読み込まれているか(章立て・要約の作成に必要)。 */
  llmReady: boolean
  /** しおり一覧の開閉(同上。既定は常時表示)。 */
  showBookmarks: boolean
  onShowBookmarksChange: (v: boolean) => void
  /** 本チャットの開閉(同上)。 */
  showChat: boolean
  onShowChatChange: (v: boolean) => void
  /** 指定時のみ「一覧へ」ボタンと Escape での復帰を有効にする。 */
  onClose?: () => void
  /** 右下の一時通知を出す(F9 のページ画像保存の結果など)。 */
  onNotify: (message: string, path: string | null, error?: boolean) => void
  /** 検索結果から開いた箇所。そのページへ移動し、テキスト表示ではその段落の語をハイライトする。 */
  jump?: ReaderJump | null
}

/** 検索結果から開いた箇所(seq は同じ箇所を開き直したときも移動させるための通し番号)。 */
export type ReaderJump = TextJump

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
  onLanguageChange,
  allTags = [],
  onTagsChange,
  showInfo,
  onShowInfoChange,
  llmReady,
  showBookmarks,
  onShowBookmarksChange,
  showChat,
  onShowChatChange,
  onClose,
  onNotify,
  jump = null
}: ReaderProps): JSX.Element {
  const count = work.page_count
  const [dirOverride, setDirOverride] = useState<Direction>(
    work.page_direction || 'default'
  )
  const effectiveDir =
    dirOverride === 'default' ? settings.defaultDirection : dirOverride
  const rtl = effectiveDir === 'rtl'

  const [offsetOverride, setOffsetOverride] = useState<SpreadOffset>(
    work.spread_offset || 'default'
  )
  const effectiveOffset =
    offsetOverride === 'default' ? (settings.coverAlone ? 1 : 0) : Number(offsetOverride)

  const [ratios, setRatios] = useState<Ratios>({})
  const [page, setPage] = useState(() =>
    Math.min(Math.max(jump ? jump.page : work.last_page, 0), Math.max(0, count - 1))
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
  const [language, setLanguage] = useState<BookLanguage>(work.language ?? 'ja')
  // 本文の組み方・文字サイズ・書体・背景は本ごとに覚える(未設定の本は最後に使った設定で開く)。
  const [bookPrefs] = useState(() => loadBookTextPrefs(work.id))
  const [textLayout, setTextLayout] = useState<TextLayout>(() => {
    const v = bookPrefs.layout ?? localStorage.getItem('readerTextLayout')
    return v === 'horizontal' || v === 'vertical' ? v : 'book'
  })
  useEffect(() => {
    localStorage.setItem('readerTextLayout', textLayout)
  }, [textLayout])
  const [textSize, setTextSize] = useState<number>(() => {
    const v = Number(bookPrefs.size ?? localStorage.getItem('readerTextSize'))
    return TEXT_SIZES.some((s) => s.value === v) ? v : 16
  })
  useEffect(() => {
    localStorage.setItem('readerTextSize', String(textSize))
  }, [textSize])
  const [textFont, setTextFont] = useState<TextFont>(() =>
    parseTextFont(bookPrefs.font ?? localStorage.getItem('readerTextFont'))
  )
  useEffect(() => {
    localStorage.setItem('readerTextFont', textFont)
  }, [textFont])
  const [fontMenuOpen, setFontMenuOpen] = useState(false)
  // 文字の太さ。書体に無い太さは、いちばん近い太さにする(書体を変えたときも)。
  const [textWeight, setTextWeight] = useState<number>(() =>
    nearestWeight(textFont, Number(bookPrefs.weight ?? localStorage.getItem('readerTextWeight') ?? 400) || 400)
  )
  useEffect(() => {
    localStorage.setItem('readerTextWeight', String(textWeight))
  }, [textWeight])
  const [weightMenuOpen, setWeightMenuOpen] = useState(false)
  const [textTheme, setTextTheme] = useState<TextTheme>(
    () =>
      parseTextTheme(bookPrefs.surface, bookPrefs.theme) ??
      parseTextTheme(localStorage.getItem('readerTextSurface'), localStorage.getItem('readerTextTheme')) ??
      'auto'
  )
  useEffect(() => {
    localStorage.setItem('readerTextSurface', textTheme)
  }, [textTheme])
  const [translation, setTranslation] = useState<TranslationMode>(() =>
    TRANSLATION_MODES.some((m) => m.value === bookPrefs.translation) ? bookPrefs.translation! : 'off'
  )
  const [pairUnit, setPairUnit] = useState<PairUnit>(() =>
    PAIR_UNITS.some((u) => u.value === bookPrefs.pairUnit) ? bookPrefs.pairUnit! : 'sentence'
  )
  // 訳の種類(本ごと)。一覧は管理ルートの種類(組み込み + 自分で作った種類)。
  const [trStyles, setTrStyles] = useState<TranslationStyle[]>([])
  const [trStyleId, setTrStyleId] = useState<string>(() => bookPrefs.trStyle ?? 'natural')
  const [trStyleMenuOpen, setTrStyleMenuOpen] = useState(false)
  const [stylesDialog, setStylesDialog] = useState(false)
  useEffect(() => {
    if (language !== 'en') return
    getTranslationStyles(root)
      .then((r) => setTrStyles(r.styles))
      .catch(() => {})
  }, [root, language])
  // 消した種類を選んでいたら自然な訳にする(一覧を読み込むまでは選んだまま)
  const trStyle =
    trStyles.length === 0 || trStyles.some((s) => s.id === trStyleId) ? trStyleId : 'natural'
  const trStyleName = trStyles.find((s) => s.id === trStyle)?.name ?? '自然な訳'
  // 英語の本の辞書(単語にマウスを乗せて引く)。全部の本で共通。
  const [dictionary, setDictionary] = useStoredFlag('readerDictionary', true)
  // 表示設定で変えたときだけ、この本の設定として保存する(開いただけの本は最後に使った設定に従う)。
  const prefsTouched = useRef(false)
  function changeTextPrefs(patch: Partial<TextPrefs>): void {
    prefsTouched.current = true
    if (patch.layout !== undefined) setTextLayout(patch.layout)
    if (patch.size !== undefined) setTextSize(patch.size)
    if (patch.font !== undefined) {
      setTextFont(patch.font)
      const font = patch.font
      setTextWeight((w) => nearestWeight(font, patch.weight ?? w))
    } else if (patch.weight !== undefined) {
      setTextWeight(patch.weight)
    }
    if (patch.surface !== undefined) setTextTheme(patch.surface)
    if (patch.translation !== undefined) setTranslation(patch.translation)
    if (patch.pairUnit !== undefined) setPairUnit(patch.pairUnit)
    if (patch.trStyle !== undefined) setTrStyleId(patch.trStyle)
  }
  useEffect(() => {
    if (!prefsTouched.current) return
    saveBookTextPrefs(work.id, {
      layout: textLayout,
      size: textSize,
      weight: textWeight,
      font: textFont,
      surface: textTheme,
      translation,
      pairUnit,
      trStyle: trStyleId
    })
  }, [work.id, textLayout, textSize, textWeight, textFont, textTheme, translation, pairUnit, trStyleId])
  const textVertical = (textLayout === 'book' ? writingMode : textLayout) === 'vertical'
  const textRef = useRef<TextViewHandle | null>(null)
  // テキスト表示で本の終わり(全ページ文字起こし済みの本文の最後の画面)まで読んだか。
  const [textCompleted, setTextCompleted] = useState(false)
  const [tags, setTags] = useState<string[]>(work.tags ?? [])
  // タグ・表示設定のバーの開閉も、本をまたいで・次回起動時も保持する。
  const [showTags, setShowTags] = useStoredFlag('readerShowTags', false)
  // 表示設定バー(読み方向・見開きずらし・本文の組み方など)の開閉。
  const [showDisplay, setShowDisplay] = useStoredFlag('readerShowDisplay', false)
  // ハイライト一覧の開閉。
  const [showHighlights, setShowHighlights] = useStoredFlag('readerShowHighlights', false)
  // 表示設定バーは項目を「本」「文字」「訳・辞書」のタブに分け、選んだタブの項目だけを出す(最後に開いたタブを覚える)。
  const [displayTab, setDisplayTab] = useState<DisplayTab>(() => {
    const v = localStorage.getItem('readerDisplayTab')
    return v === 'book' || v === 'text' || v === 'translation' ? v : 'text'
  })
  useEffect(() => {
    localStorage.setItem('readerDisplayTab', displayTab)
  }, [displayTab])
  const displayTabs: { id: DisplayTab; label: string }[] = [
    { id: 'book', label: '本' },
    ...(viewMode === 'text' ? [{ id: 'text' as const, label: '文字' }] : []),
    ...(viewMode === 'text' && language === 'en' ? [{ id: 'translation' as const, label: '訳・辞書' }] : [])
  ]
  // 今の表示で出ないタブ(画像表示の「文字」など)を覚えていたら、テキスト表示は「文字」、画像表示は「本」を開く。
  const activeDisplayTab: DisplayTab = displayTabs.some((t) => t.id === displayTab)
    ? displayTab
    : viewMode === 'text'
      ? 'text'
      : 'book'
  const [tagInput, setTagInput] = useState('')

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
    const completed =
      (spread ? spread[spread.length - 1] : p) >= count - 1 || (viewMode === 'text' && textCompleted)
    saveReadingState(root, work.id, p, completed).catch(() => {})
    onProgress?.(work.id, p, completed)
  }
  const curIdx = useMemo(
    () => Math.max(0, spreads.findIndex((s) => s.includes(page))),
    [spreads, page]
  )
  const currentSpread = spreads[curIdx] ?? [page]
  // テキスト表示は原本の見開きに縛られないので、今の原本ページだけを「表示中」とみなす
  // (しおり・目次・チャットのネタバレ防止に使う)。
  const viewPages = useMemo(
    () => (viewMode === 'text' ? [page] : currentSpread),
    [viewMode, page, currentSpread]
  )

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

  // リーダーを離れる(アンマウント/本切替)直前に、最新ページを確実に保存する。
  useEffect(() => {
    return () => persist.current(pageRef.current)
  }, [])
  // ウィンドウを閉じるときは React のアンマウントが走らないので、ここでも保存する。
  useEffect(() => {
    const flush = (): void => persist.current(pageRef.current)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
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

  // 見開きのペア境界を 1 ページずらす(本ごとに保存)。
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

  // ハイライト(本フォルダの highlights.json)。作る・変える・消すはここで保存し、TextView は描くだけ。
  const [highlights, setHighlights] = useState<Highlight[]>([])
  // テキスト表示で付け直した場所(一覧の並び・ページ・位置ずれの印)。本を変えたら捨てる。
  const [hlPlaces, setHlPlaces] = useState<Record<number, HighlightPlace | null>>({})
  const onNotifyRef = useRef(onNotify)
  onNotifyRef.current = onNotify
  useEffect(() => {
    setHighlights([])
    setHlPlaces({})
    listHighlights(root, work.id)
      .then(setHighlights)
      .catch((e) => onNotifyRef.current(`ハイライトを読み込めませんでした: ${(e as Error).message}`, null, true))
  }, [root, work.id])

  const hlFailed = useCallback((e: unknown): void => {
    onNotifyRef.current(`ハイライトを保存できませんでした: ${(e as Error).message}`, null, true)
  }, [])

  const createHighlight = useCallback(
    (body: { color: HighlightColor; note: string | null; text: string; parts: HighlightPart[] }): void => {
      addHighlight(root, work.id, body)
        .then((h) => setHighlights((hs) => [...hs, h]))
        .catch(hlFailed)
    },
    [root, work.id, hlFailed]
  )

  const changeHighlight = useCallback(
    (id: number, changes: { color?: HighlightColor; note?: string | null }): void => {
      setHighlights((hs) => hs.map((h) => (h.id === id ? { ...h, ...changes } : h)))
      updateHighlight(root, work.id, id, changes)
        .then((saved) => setHighlights((hs) => hs.map((h) => (h.id === id ? saved : h))))
        .catch(hlFailed)
    },
    [root, work.id, hlFailed]
  )

  const removeHighlight = useCallback(
    (id: number): void => {
      setHighlights((hs) => hs.filter((h) => h.id !== id))
      deleteHighlight(root, work.id, id).catch(hlFailed)
    },
    [root, work.id, hlFailed]
  )

  // 表示中の見開きに含まれるページのしおり。
  const spreadBookmark = bookmarks.find((b) => viewPages.includes(b.page))

  // 現在ページのしおりを付け外しする。
  const toggleBookmark = useCallback(() => {
    const target = viewPages[0]
    const existing = bookmarks.find((b) => viewPages.includes(b.page))
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
  }, [bookmarks, viewPages, root, work.id])

  // テキスト表示から: 画面の本文が原本のどのページまで進んだか。
  const onTextPageChange = useCallback((p: number, completed: boolean): void => {
    setPage(p)
    setTextCompleted(completed)
  }, [])

  function jumpTo(p: number): void {
    setPage(Math.min(Math.max(p, 0), count - 1))
  }

  // 検索結果から開いた箇所のページへ移る。テキスト表示は TextView が段落まで合わせて、
  // 進んだページを知らせてくる(ここでページを変えると、TextView がページの先頭へ移り直してしまう)。
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  useEffect(() => {
    if (jump && viewModeRef.current === 'image') setPage(Math.min(Math.max(jump.page, 0), count - 1))
  }, [jump, count])
  // テキスト表示へ渡す箇所。表示を切り替えたら捨てる(作り直した TextView が検索の箇所へ戻らないように)。
  const [textJump, setTextJump] = useState(jump)
  useEffect(() => {
    setTextJump(jump)
  }, [jump])
  const shownMode = useRef(viewMode)
  useEffect(() => {
    if (shownMode.current === viewMode) return
    shownMode.current = viewMode
    setTextJump(null)
  }, [viewMode])

  // 一覧のハイライトの場所へ。テキスト表示はその段落の画面へ、画像表示はそのページへ。
  function jumpToHighlight(h: Highlight): void {
    const place = hlPlaces[h.id] ?? { block: h.parts[0].block, page: h.parts[0].page }
    if (viewMode === 'text') setTextJump({ page: place.page, block: place.block, terms: [], seq: Date.now() })
    else jumpTo(place.page)
  }

  function deleteHighlightFromList(h: Highlight): void {
    if (h.note && !window.confirm('メモの付いたハイライトを削除します。よろしいですか？')) return
    removeHighlight(h.id)
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

  const spreadKey = currentSpread.join(',')

  // キーボード操作。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 入力欄(タグ・チャット・設定モーダル等)へのタイピングでは発火させない。
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable]')) return
      // 設定・モデル選択・取り込みなどのモーダルが開いている間は裏のリーダーを動かさない。
      if (document.querySelector('[aria-modal="true"]')) return
      // Ctrl+S / Ctrl+B などの修飾キー付きはブラウザや OS の操作なので拾わない。
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // 書体・太さのメニューが開いている間は、Escape でメニューだけ閉じる(一覧へは戻らない)。
      if (fontMenuOpen || weightMenuOpen || trStyleMenuOpen) {
        if (e.key === 'Escape') {
          setFontMenuOpen(false)
          setWeightMenuOpen(false)
          setTrStyleMenuOpen(false)
        }
        return
      }
      // テキスト表示はアプリが組んだ画面を送る。進む向きは本文の組み方で決まる(縦書きは左へ)。
      const text = viewMode === 'text'
      const back = text ? () => textRef.current?.turn('prev') : prev
      const forward = text ? () => textRef.current?.turn('next') : next
      const leftIsNext = text ? textVertical : rtl
      if (e.key === 'Escape') onClose?.()
      else if (e.key === 'ArrowRight') leftIsNext ? back() : forward()
      else if (e.key === 'ArrowLeft') leftIsNext ? forward() : back()
      else if (e.key === 'ArrowUp') back()
      else if (e.key === 'ArrowDown') forward()
      else if ((e.key === 's' || e.key === 'S') && settings.pageMode === 'double') toggleOffset()
      else if (e.key === 'b' || e.key === 'B') toggleBookmark()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    rtl,
    prev,
    next,
    onClose,
    toggleOffset,
    toggleBookmark,
    settings.pageMode,
    viewMode,
    textVertical,
    fontMenuOpen,
    weightMenuOpen,
    trStyleMenuOpen
  ])

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

  function changeLanguage(lang: BookLanguage): void {
    setLanguage(lang)
    setWorkLanguage(root, work.id, lang).catch((e) =>
      onNotify(`本の言語を保存できませんでした: ${(e as Error).message}`, null, true)
    )
    onLanguageChange?.(work.id, lang)
    // 英語の本は横書き
    if (lang === 'en' && writingMode === 'vertical') changeWritingMode('horizontal')
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
          className={`btn ${showHighlights ? 'btn-active' : ''}`}
          onClick={() => setShowHighlights(!showHighlights)}
          title="ハイライト一覧の開閉（テキスト表示で本文を選ぶと付けられます）"
        >
          ハイライト{highlights.length > 0 ? `（${highlights.length}）` : ''}
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
          title="目次と章ごとの要約"
        >
          目次
        </button>
        <button
          className={`btn ${showChat ? 'btn-active' : ''}`}
          onClick={() => onShowChatChange(!showChat)}
          title="この本について質問する"
        >
          チャット
        </button>
        <span className="reader-count" title={viewMode === 'text' ? '原本のページ' : undefined}>
          {viewPages.length === 2 ? `${viewPages[0] + 1}-${lastPageOfSpread + 1}` : viewPages[0] + 1}{' '}
          / {count}
        </span>
      </header>

      <div className="reader-body">
      <div className="reader-left">

      {showDisplay && (
        <div className="reader-display">
          <div className="display-tabs" role="tablist" aria-label="表示の項目">
            {displayTabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={activeDisplayTab === t.id}
                className={`display-tab ${activeDisplayTab === t.id ? 'is-active' : ''}`}
                onClick={() => setDisplayTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="display-items" role="tabpanel">
            {activeDisplayTab === 'book' && (
              <>
                <div className="display-item">
                  <span className="display-label">読み方向</span>
                  <select
                    className="reader-dir"
                    value={dirOverride}
                    onChange={(e) => changeDirection(e.target.value as Direction)}
                    title="この本の読み進め方向"
                  >
                    <option value="default">
                      既定（{settings.defaultDirection === 'rtl' ? '右→左' : '左→右'}）
                    </option>
                    <option value="rtl">右 → 左</option>
                    <option value="ltr">左 → 右</option>
                  </select>
                </div>
                <div className="display-item">
                  <span className="display-label">言語</span>
                  <div className="seg" role="group" aria-label="本の言語">
                    {(['ja', 'en'] as const).map((l) => (
                      <button
                        key={l}
                        className={`seg-btn ${language === l ? 'seg-active' : ''}`}
                        onClick={() => changeLanguage(l)}
                        title="文字起こしの読み方（行のつなぎ方・文の終わりの判定など）を本の言語に合わせます。文字起こし済みのページは、やり直すと新しい言語で読み直します"
                      >
                        {l === 'ja' ? '日本語' : '英語'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="display-item">
                  <span className="display-label">原本の書字方向</span>
                  <div className="seg" role="group" aria-label="原本の書字方向">
                    {(['horizontal', 'vertical'] as const).map((m) => (
                      <button
                        key={m}
                        className={`seg-btn ${writingMode === m ? 'seg-active' : ''}`}
                        onClick={() => changeWritingMode(m)}
                        title="原本の書字方向。文字起こしの読み順と、本文の組み方「原本どおり」に使います"
                      >
                        {m === 'horizontal' ? '横書き' : '縦書き'}
                      </button>
                    ))}
                  </div>
                </div>
                {settings.pageMode === 'double' && viewMode === 'image' && (
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
              </>
            )}
            {activeDisplayTab === 'text' && (
              <>
                <div className="display-item">
                  <span className="display-label">組み方</span>
                  <div className="seg" role="group" aria-label="本文の組み方">
                    {TEXT_LAYOUTS.map((l) => (
                      <button
                        key={l.value}
                        className={`seg-btn ${textLayout === l.value ? 'seg-active' : ''}`}
                        onClick={() => changeTextPrefs({ layout: l.value })}
                        title="テキスト表示の本文を横書き / 縦書きのどちらで組むか（原本の書字方向とは別に選べます）"
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="display-item">
                  <span className="display-label">サイズ</span>
                  <div className="seg" role="group" aria-label="文字サイズ">
                    {TEXT_SIZES.map((t) => (
                      <button
                        key={t.value}
                        className={`seg-btn ${textSize === t.value ? 'seg-active' : ''}`}
                        onClick={() => changeTextPrefs({ size: t.value })}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="display-item">
                  <span className="display-label">書体</span>
                  <div className="font-picker">
                    <button
                      className="reader-dir font-picker-btn"
                      onClick={() => setFontMenuOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={fontMenuOpen}
                      title="テキスト表示の本文の書体"
                    >
                      <span className="font-picker-label">{textFontOf(textFont).label}</span>
                      <span className="font-picker-caret" aria-hidden="true">
                        ▾
                      </span>
                    </button>
                    {fontMenuOpen && (
                      <>
                        <div className="popup-backdrop" onClick={() => setFontMenuOpen(false)} />
                        <div className="ex-popup font-picker-menu" role="menu" aria-label="書体">
                          {TEXT_FONTS.map((f) => (
                            <button
                              key={f.value}
                              className={`ex-popup-item font-picker-item ${textFont === f.value ? 'is-current' : ''}`}
                              role="menuitemradio"
                              aria-checked={textFont === f.value}
                              style={{ fontFamily: f.family ?? undefined }}
                              onClick={() => {
                                changeTextPrefs({ font: f.value })
                                setFontMenuOpen(false)
                              }}
                            >
                              <span className="font-picker-check" aria-hidden="true">
                                {textFont === f.value ? '✓' : ''}
                              </span>
                              {f.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <div className="display-item">
                  <span className="display-label">文字の太さ</span>
                  <div className="font-picker">
                    <button
                      className="reader-dir font-picker-btn weight-picker-btn"
                      onClick={() => setWeightMenuOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={weightMenuOpen}
                      disabled={textFontOf(textFont).weights.length < 2}
                      title={
                        textFontOf(textFont).weights.length < 2
                          ? 'この書体は太さが 1 種類だけです'
                          : 'テキスト表示の本文の文字の太さ（書体に用意されている太さから選びます）'
                      }
                    >
                      <span className="font-picker-label">{weightName(textFont, textWeight)}</span>
                      <span className="font-picker-caret" aria-hidden="true">
                        ▾
                      </span>
                    </button>
                    {weightMenuOpen && (
                      <>
                        <div className="popup-backdrop" onClick={() => setWeightMenuOpen(false)} />
                        <div className="ex-popup font-picker-menu" role="menu" aria-label="文字の太さ">
                          {textFontOf(textFont).weights.map((w) => (
                            <button
                              key={w.value}
                              className={`ex-popup-item font-picker-item ${textWeight === w.value ? 'is-current' : ''}`}
                              role="menuitemradio"
                              aria-checked={textWeight === w.value}
                              style={{ fontFamily: textFontOf(textFont).family ?? undefined, fontWeight: w.value }}
                              onClick={() => {
                                changeTextPrefs({ weight: w.value })
                                setWeightMenuOpen(false)
                              }}
                            >
                              <span className="font-picker-check" aria-hidden="true">
                                {textWeight === w.value ? '✓' : ''}
                              </span>
                              {w.name}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <div className="display-item">
                  <span className="display-label">背景</span>
                  <div className="seg" role="group" aria-label="背景">
                    {TEXT_THEMES.map((t) => (
                      <button
                        key={t.value}
                        className={`seg-btn ${textTheme === t.value ? 'seg-active' : ''}`}
                        onClick={() => changeTextPrefs({ surface: t.value })}
                        title="テキスト表示の本文の背景と文字の色"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {activeDisplayTab === 'translation' && (
              <>
                <div className="display-item">
                  <span className="display-label">訳の種類</span>
                  <div className="font-picker">
                    <button
                      className="reader-dir font-picker-btn"
                      onClick={() => setTrStyleMenuOpen((v) => !v)}
                      aria-haspopup="menu"
                      aria-expanded={trStyleMenuOpen}
                      title="表示・翻訳する訳の種類（訳し方）。種類ごとに訳を保存します"
                    >
                      <span className="font-picker-label">{trStyleName}</span>
                      <span className="font-picker-caret" aria-hidden="true">
                        ▾
                      </span>
                    </button>
                    {trStyleMenuOpen && (
                      <>
                        <div className="popup-backdrop" onClick={() => setTrStyleMenuOpen(false)} />
                        <div className="ex-popup font-picker-menu" role="menu" aria-label="訳の種類">
                          {trStyles.map((st) => (
                            <button
                              key={st.id}
                              className={`ex-popup-item font-picker-item ${trStyle === st.id ? 'is-current' : ''}`}
                              role="menuitemradio"
                              aria-checked={trStyle === st.id}
                              onClick={() => {
                                changeTextPrefs({ trStyle: st.id })
                                setTrStyleMenuOpen(false)
                              }}
                            >
                              <span className="font-picker-check" aria-hidden="true">
                                {trStyle === st.id ? '✓' : ''}
                              </span>
                              {st.name}
                            </button>
                          ))}
                          <div className="ex-popup-sep" />
                          <button
                            className="ex-popup-item"
                            role="menuitem"
                            onClick={() => {
                              setTrStyleMenuOpen(false)
                              setStylesDialog(true)
                            }}
                          >
                            種類を作る・編集する…
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <div className="display-item">
                  <span className="display-label">日本語訳</span>
                  <div className="seg" role="group" aria-label="日本語訳">
                    {TRANSLATION_MODES.map((m) => (
                      <button
                        key={m.value}
                        className={`seg-btn ${translation === m.value ? 'seg-active' : ''}`}
                        onClick={() => changeTextPrefs({ translation: m.value })}
                        title="原文だけ / 訳文だけ / 原文と訳文を並べて（対訳）読む。訳していない段落は原文のまま"
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
                {translation === 'both' && (
                  <div className="display-item">
                    <span className="display-label">対訳の単位</span>
                    <div className="seg" role="group" aria-label="対訳の単位">
                      {PAIR_UNITS.map((u) => (
                        <button
                          key={u.value}
                          className={`seg-btn ${pairUnit === u.value ? 'seg-active' : ''}`}
                          onClick={() => changeTextPrefs({ pairUnit: u.value })}
                          title="原文と訳文を、1 文ずつ / 段落ごと / 節（見出しや場面の区切りまで）ごとに並べる"
                        >
                          {u.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="display-item">
                  <span className="display-label">辞書</span>
                  <div className="seg" role="group" aria-label="辞書">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        className={`seg-btn ${dictionary === on ? 'seg-active' : ''}`}
                        onClick={() => setDictionary(on)}
                        title="英語の本文の単語にマウスを乗せると、英和辞書（EJDict）の意味を出します"
                      >
                        {on ? 'オン' : 'オフ'}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {stylesDialog && (
        <TranslationStylesDialog
          root={root}
          styles={trStyles}
          initialId={trStyle}
          onClose={() => setStylesDialog(false)}
          onSaved={(styles) => {
            setTrStyles(styles)
            setStylesDialog(false)
          }}
        />
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
        </div>
      )}

      {showInfo && (
        <TocPanel
          root={root}
          work={work}
          currentPage={viewPages[0]}
          llmReady={llmReady}
          onJump={jumpTo}
        />
      )}

      {showHighlights && (
        <HighlightPanel
          highlights={highlights}
          places={hlPlaces}
          onJump={jumpToHighlight}
          onDelete={deleteHighlightFromList}
        />
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
            ref={textRef}
            root={root}
            work={work}
            page={page}
            onPageChange={onTextPageChange}
            vertical={textVertical}
            columns={settings.pageMode === 'double' ? 2 : 1}
            fontSize={textSize}
            weight={textWeight}
            font={textFont}
            theme={textTheme}
            animate={animate}
            engine={settings.transcribeEngine ?? 'yomitoku'}
            translation={language === 'en' ? translation : 'off'}
            pairUnit={pairUnit}
            trStyle={trStyle}
            trStyleName={trStyleName}
            llmReady={llmReady}
            dictionary={dictionary}
            jump={textJump}
            tts={settings.tts}
            highlights={highlights}
            onHighlightCreate={createHighlight}
            onHighlightChange={changeHighlight}
            onHighlightDelete={removeHighlight}
            onHighlightsResolved={setHlPlaces}
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
              alt={`p.${i + 1}`}
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
                className={`reader-bm-item ${viewPages.includes(b.page) ? 'is-current' : ''}`}
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
            llmReady={llmReady}
            work={work}
            currentPage={viewPages[viewPages.length - 1]}
            contextChars={chatContextChars(settings.llm.ctxSize)}
            think={settings.llm.thinkingEnabled}
            systemPrompt={settings.llm.chatSystemPrompt}
            dynamicSuggestions={settings.llm.chatDynamicSuggestions}
            generalKnowledge={settings.llm.chatGeneralKnowledge}
            width={chatWidth}
          />
        </>
      )}
      </div>
    </div>
  )
}
