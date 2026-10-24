/** バックエンド (FastAPI) への薄い HTTP クライアント。 */

import type { AppSettings } from '../../preload'

let baseUrl = ''
let token = ''

export interface Work {
  id: string
  rel_path: string
  title: string
  author: string
  /** 本文の書字方向(取り込み時に指定) */
  writing_mode: WritingMode
  /** 本の言語(文字起こしの後処理を切り替える。取り込み時に指定) */
  language: BookLanguage
  page_count: number
  page_direction: Direction
  spread_offset: SpreadOffset
  sort_index: number | null
  added_at: string
  last_opened_at: string | null
  last_page: number
  completed: number
  tags: string[]
}

export type WritingMode = 'horizontal' | 'vertical'
export type BookLanguage = 'ja' | 'en'

export interface ScanResult {
  added: number
  updated: number
  removed: number
  total: number
  scanned: number
  /** 管理ルート内で、まだ本フォルダに取り込まれていないアーカイブの数 */
  loose: number
}

/** 取り込み候補のアーカイブ(書名の初期値と重複の有無)。 */
export interface ImportCandidate {
  path: string
  name: string
  title: string
  size: number
  /** 同じ内容の本が既に取り込まれている */
  duplicate: boolean
  error: string | null
}

export interface ImportItem {
  path: string
  title: string
  author: string
  writing_mode: WritingMode
  language: BookLanguage
}

export interface ImportResult {
  path: string
  ok: boolean
  id?: string
  title?: string
  dir?: string
  error?: string
}

/** 起動時に Electron からバックエンドの接続先を受け取る。 */
export async function initApi(): Promise<{ baseUrl: string; port: number }> {
  const info = await window.api.getBackendInfo()
  baseUrl = info.baseUrl
  token = info.token
  return info
}

/** API の URL。fetch では合言葉をヘッダで送る(URL に載せるとアクセスログに残る)。 */
function api(path: string): string {
  return `${baseUrl}/api${path}`
}

/** 合言葉付きの URL。ヘッダを付けられない <img src> 用。 */
function imageUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${api(path)}${sep}token=${encodeURIComponent(token)}`
}

const TOKEN_HEADER = 'X-Book-Viewer-Token'

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // 起動直後、接続先が決まる前の呼び出し(定期取得など)は送らない(file:// へ飛んでしまう)。
  if (!baseUrl) throw new Error('バックエンドに接続していません')
  const res = await fetch(api(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...(init?.headers ?? {}) }
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} ${text}`)
  }
  return res.json() as Promise<T>
}

export async function health(): Promise<{ status: string; version: string }> {
  return jsonFetch('/health')
}

export async function scanRoot(root: string): Promise<ScanResult> {
  return jsonFetch('/roots/scan', { method: 'POST', body: JSON.stringify({ root }) })
}

/** 取り込み候補のファイルについて、書名の初期値と重複の有無を調べる。 */
export async function inspectArchives(root: string, paths: string[]): Promise<ImportCandidate[]> {
  const data = await jsonFetch<{ files: ImportCandidate[] }>('/library/inspect', {
    method: 'POST',
    body: JSON.stringify({ root, paths })
  })
  return data.files
}

/** 管理ルート内の未取り込みアーカイブを返す。 */
export async function listLooseArchives(root: string): Promise<ImportCandidate[]> {
  const data = await jsonFetch<{ files: ImportCandidate[] }>(
    `/library/loose?root=${encodeURIComponent(root)}`
  )
  return data.files
}

/** アーカイブを本フォルダとして取り込む(copy: 元を残す / move: 移動する)。 */
export async function importBooks(
  root: string,
  items: ImportItem[],
  mode: 'copy' | 'move'
): Promise<{ results: ImportResult[]; scan: ScanResult }> {
  return jsonFetch('/library/import', {
    method: 'POST',
    body: JSON.stringify({ root, items, mode })
  })
}

export async function listWorks(root: string): Promise<Work[]> {
  const data = await jsonFetch<{ works: Work[] }>(`/roots/works?root=${encodeURIComponent(root)}`)
  return data.works
}

/** 手動並び替えの順序を保存する(ids の並びがそのまま表示順になる)。 */
export async function setWorksOrder(root: string, ids: string[]): Promise<void> {
  await jsonFetch('/roots/works-order', { method: 'PUT', body: JSON.stringify({ root, ids }) })
}

/** 書名を変更する(本フォルダ名も追従)。新しい title / rel_path を返す。 */
export async function renameWork(
  root: string,
  workId: string,
  name: string
): Promise<{ title: string; rel_path: string }> {
  return jsonFetch(`/works/${workId}/filename?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  })
}

/** 本を削除する(本フォルダはごみ箱へ移動)。 */
export async function deleteWork(root: string, workId: string): Promise<void> {
  await jsonFetch(`/works/${workId}?root=${encodeURIComponent(root)}`, { method: 'DELETE' })
}

/** 書名・著者・要約・本文を横断検索し、該当 work_id を返す。 */
export async function searchWorks(root: string, q: string): Promise<string[]> {
  const data = await jsonFetch<{ work_ids: string[] }>(
    `/roots/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`
  )
  return data.work_ids
}

/** 本文検索で見つかった箇所(アプリ用の本文の段落)。 */
export interface PassageHit {
  /** アプリ用の本文のブロックの添字(テキスト表示でその段落へ飛ぶ) */
  block: number
  /** 原本のページ(0 始まり) */
  page: number
  /** 章(と節)の名前。章立てが無ければ空 */
  chapter: string
  /** まだ読んでいない所か(読み終えた本は false) */
  ahead: boolean
  /** 段落の一致した語の付近 */
  snippet: string
  /** snippet の中の一致した語の位置 [始, 終] */
  marks: [number, number][]
  /** 英語の本で訳してあれば、一致した文の日本語訳(自然な訳を優先) */
  ja: string | null
  /** ja の中の一致した語の位置(訳文で一致したとき。そのとき snippet は一致した文の原文で、marks は空) */
  ja_marks: [number, number][]
  /** 何で見つかったか: 原文の語 / 訳文の語 / 意味が近いだけ(語は一致していない) */
  match: 'text' | 'ja' | 'meaning'
}

export interface PassageBook {
  work_id: string
  title: string
  author: string
  /** この本で見つかった箇所の数 */
  count: number
  title_match: boolean
  /** 本ごとのまとめでは順位の高い数件、本を指定したときは全件(ページ順) */
  hits: PassageHit[]
}

export interface PassageSearch {
  /** 検索に使った語(空白で分けたもの) */
  terms: string[]
  books: PassageBook[]
  total: number
  /** 見つかった箇所が多すぎて、数えるのを途中でやめたか */
  capped: boolean
  /** 意味の近さで探せた本の数(段落の索引のある本)と全体の数、探せなかった理由 */
  semantic: { indexed: number; books: number; error: string | null } | null
}

/** 本文を段落の単位で探す(検索結果の画面)。workId を渡すとその本の全件。 */
export async function searchPassages(root: string, q: string, workId?: string): Promise<PassageSearch> {
  const params = new URLSearchParams({ root, q })
  if (workId) params.set('work_id', workId)
  return jsonFetch(`/roots/search/passages?${params}`)
}

export async function saveReadingState(
  root: string,
  workId: string,
  lastPage: number,
  completed = false
): Promise<void> {
  await jsonFetch(`/works/${workId}/reading-state?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ last_page: lastPage, completed }),
    // ウィンドウを閉じる直前の保存も届くようにする。
    keepalive: true
  })
}

export type Direction = 'default' | 'rtl' | 'ltr'
export type SpreadOffset = 'default' | '0' | '1'

/** 本ごとの読み進め方向の上書きを保存する。 */
export async function setWorkDirection(
  root: string,
  workId: string,
  direction: Direction
): Promise<void> {
  await jsonFetch(`/works/${workId}/direction?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ direction })
  })
}

/** 本文の書字方向(横書き / 縦書き)を変更する(book.json も更新される)。 */
export async function setWorkWritingMode(
  root: string,
  workId: string,
  writingMode: WritingMode
): Promise<void> {
  await jsonFetch(`/works/${workId}/writing-mode?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ writing_mode: writingMode })
  })
}

/** 本の言語(日本語 / 英語)を変更する(book.json も更新される)。 */
export async function setWorkLanguage(
  root: string,
  workId: string,
  language: BookLanguage
): Promise<void> {
  await jsonFetch(`/works/${workId}/language?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ language })
  })
}

/** 本ごとの見開きペア境界ずらしを保存する。 */
export async function setWorkSpreadOffset(
  root: string,
  workId: string,
  offset: SpreadOffset
): Promise<void> {
  await jsonFetch(`/works/${workId}/spread-offset?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ offset })
  })
}

export interface Bookmark {
  id: number
  page: number
  note: string | null
  created_at: string
}

export async function listBookmarks(root: string, workId: string): Promise<Bookmark[]> {
  const data = await jsonFetch<{ bookmarks: Bookmark[] }>(
    `/works/${workId}/bookmarks?root=${encodeURIComponent(root)}`
  )
  return data.bookmarks
}

export async function addBookmark(
  root: string,
  workId: string,
  page: number,
  note?: string
): Promise<number> {
  const data = await jsonFetch<{ id: number }>(
    `/works/${workId}/bookmarks?root=${encodeURIComponent(root)}`,
    { method: 'POST', body: JSON.stringify({ page, note: note ?? null }) }
  )
  return data.id
}

export async function deleteBookmark(
  root: string,
  workId: string,
  bookmarkId: number
): Promise<void> {
  await jsonFetch(
    `/works/${workId}/bookmarks/${bookmarkId}?root=${encodeURIComponent(root)}`,
    { method: 'DELETE' }
  )
}

/** ページ画像の URL。<img src> に直接渡す。 */
export function pageUrl(root: string, workId: string, index: number): string {
  return imageUrl(`/works/${workId}/pages/${index}?root=${encodeURIComponent(root)}`)
}

/** 本にタグを付ける(無ければ作成)。 */
export async function addWorkTag(root: string, workId: string, name: string): Promise<void> {
  await jsonFetch(`/works/${workId}/tags?root=${encodeURIComponent(root)}`, {
    method: 'POST',
    body: JSON.stringify({ name })
  })
}

/** 本からタグを外す。 */
export async function removeWorkTag(root: string, workId: string, name: string): Promise<void> {
  await jsonFetch(
    `/works/${workId}/tags?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  )
}

/** ジョブの種類(文字起こし / 章立てと要約 / 本文検索の索引 / 英語の本の日本語訳)。 */
export type JobKind = 'transcribe' | 'structure' | 'index' | 'translate' | 'vectors'

export interface QueueCurrent {
  work_id: string
  title: string
  kind: JobKind
  current: number
  total: number
  phase: string
  elapsed: number
}
export interface QueueItem {
  work_id: string
  title: string
  kind: JobKind
}
export interface QueueRecent {
  work_id: string
  title: string
  kind: JobKind
  status: string
  error: string | null
}
export interface JobQueue {
  current: QueueCurrent | null
  pending: QueueItem[]
  recent: QueueRecent[]
}

/** ジョブキューの状態(実行中・待機中・最近終わったもの)。 */
export async function getQueue(): Promise<JobQueue> {
  return jsonFetch(`/queue`)
}

/** アプリ用の本文のブロック(段落・見出し・図など)。 */
export interface ContentBlock {
  /** 原本の何ページから始まるか(0 始まり) */
  page: number
  kind: 'p' | 'heading' | 'figure' | 'table' | 'list' | 'quote' | 'code' | 'math'
  md: string
  /** 章の始まり(表示で改ページする) */
  break?: boolean
}

/** アプリ用の本文(原本のページ割りから切り離した、ひと続きの本文)。 */
export interface BookContent {
  /** 材料(ページの本文・章立て)の指紋。変わっていなければ組み直さなくてよい。 */
  signature: string
  pages_done: number
  blocks: ContentBlock[]
}

export async function getContent(root: string, workId: string): Promise<BookContent> {
  return jsonFetch(`/works/${workId}/content?root=${encodeURIComponent(root)}`)
}

/** 訳文の 1 組(原文の 1 文、または続いた数文 ↔ 訳文)。 */
export interface TranslationPair {
  en: string
  ja: string
}

/** 訳したブロック。head は見出し・箇条の記号など、訳さない頭の部分(`## ` など)。 */
export interface TranslatedBlock {
  head: string
  /** 訳したモデルの名前(記録の無い古い訳は空) */
  model: string
  pairs: TranslationPair[]
  /** 翻訳中の途中経過(保存前。最後の訳文は書きかけのことがある) */
  live?: boolean
}

/** 訳の種類(訳し方の指示)。builtin は組み込み(自然な訳・直訳)で、変えられない。 */
export interface TranslationStyle {
  id: string
  name: string
  instructions: string
  builtin: boolean
  updated_at?: string
}

/** 訳の種類の一覧(組み込みが先。自分で作った種類は管理ルートに保存されている)。 */
export async function getTranslationStyles(root: string): Promise<{ styles: TranslationStyle[] }> {
  return jsonFetch(`/translation-styles?root=${encodeURIComponent(root)}`)
}

/** 自分で作った訳の種類を保存する(一覧から外した種類は消える。新しい種類は id を省く)。 */
export async function saveTranslationStyles(
  root: string,
  styles: { id?: string; name: string; instructions: string }[]
): Promise<{ styles: TranslationStyle[] }> {
  return jsonFetch(`/translation-styles`, {
    method: 'PUT',
    body: JSON.stringify({ root, styles })
  })
}

/** アプリ用の本文のブロックの並びに合わせた日本語訳(訳さない・未訳のブロックは null)。 */
export interface BookTranslation {
  /** どの本文(BookContent.signature)に合わせたものか */
  signature: string
  /** 訳の種類 */
  style: string
  /** 今と違う指示(訳し方を書き直す前)で訳したブロックの数 */
  stale: number
  /** この本に訳がある種類ごとの、訳したブロック数 */
  styles: Record<string, number>
  /** 訳す対象のブロック数と、訳したブロック数 */
  total: number
  done: number
  /** 訳したモデルごとのブロック数(多い順。model が空は記録の無い古い訳) */
  models: { model: string; blocks: number }[]
  blocks: (TranslatedBlock | null)[]
}

export async function getTranslation(root: string, workId: string, style: string): Promise<BookTranslation> {
  return jsonFetch(
    `/works/${workId}/translation?root=${encodeURIComponent(root)}&style=${encodeURIComponent(style)}`
  )
}

/** 翻訳中のまとまりの、保存前の訳(キーは BookContent.blocks の添字)。翻訳していなければ blocks は空。 */
export interface TranslationLive {
  signature: string | null
  /** 訳している種類 */
  style: string | null
  blocks: Record<string, TranslatedBlock>
}

export async function getTranslationLive(workId: string): Promise<TranslationLive> {
  return jsonFetch(`/works/${workId}/translation/live`)
}

/**
 * 日本語訳をジョブキューに積む(LLM の読み込みが必要)。
 * style の訳の種類で訳す。redo で訳したブロックも全部、stale で指示を書き直す前に訳したブロックだけ、
 * blocks を渡すとそのブロック(BookContent.blocks の添字)だけ訳し直す。
 */
export async function enqueueTranslate(
  root: string,
  workId: string,
  style: string,
  opts: { redo?: boolean; stale?: boolean; blocks?: number[] } = {}
): Promise<JobQueue> {
  return jsonFetch(`/works/${workId}/translate`, {
    method: 'POST',
    body: JSON.stringify({
      root,
      style,
      redo: opts.redo ?? false,
      stale: opts.stale ?? false,
      blocks: opts.blocks ?? null
    })
  })
}

/** 英和辞書(EJDict)の項目。meanings は意味の一覧(『』は主な意味)、more は表示しきれなかった数。 */
export interface DictionaryEntry {
  word: string
  meanings: string[]
  more: number
}

export interface DictionaryResult {
  query: string
  /** 書かれた形の項目と、語尾を外した元の形の項目(見つからなければ空) */
  entries: DictionaryEntry[]
}

export async function lookupWord(word: string): Promise<DictionaryResult> {
  return jsonFetch(`/dictionary?word=${encodeURIComponent(word)}`)
}

/** 読み取りの確信度が低い本文の行(要確認の候補)。 */
export interface LowLine {
  text: string
  score: number
}

/** ページの本文と補助情報。 */
export interface PageText {
  markdown: string
  /** 確信度の低い行 */
  low: LowLine[]
  /** 手で直したページか(全ページのやり直しでは上書きしない) */
  edited: boolean
}

/** ページの本文(Markdown)と補助情報。未処理なら null。 */
export async function getPageText(
  root: string,
  workId: string,
  index: number
): Promise<PageText | null> {
  const data = await jsonFetch<{ markdown: string | null; low: LowLine[]; edited: boolean }>(
    `/works/${workId}/text/${index}?root=${encodeURIComponent(root)}`
  )
  return data.markdown === null ? null : { markdown: data.markdown, low: data.low, edited: data.edited }
}

/** 手で直した本文を保存する。 */
export async function savePageText(
  root: string,
  workId: string,
  index: number,
  markdown: string
): Promise<PageText> {
  return jsonFetch(`/works/${workId}/text/${index}`, {
    method: 'PUT',
    body: JSON.stringify({ root, markdown })
  })
}

/** 文字起こしのエンジン。yomitoku は LLM 不要、vlm は読み込み済みの Vision LLM を使う。 */
export type TranscribeEngine = 'yomitoku' | 'vlm'

/** 文字起こしをキューに積む(pages 省略時は未処理の全ページ、force で作り直し)。 */
export async function enqueueTranscribe(
  root: string,
  workId: string,
  opts?: { pages?: number[]; force?: boolean; engine?: TranscribeEngine }
): Promise<JobQueue> {
  return jsonFetch(`/works/${workId}/transcribe`, {
    method: 'POST',
    body: JSON.stringify({
      root,
      pages: opts?.pages ?? null,
      force: opts?.force ?? false,
      engine: opts?.engine ?? 'yomitoku'
    })
  })
}

/** 章(目次の 1 項目)。start / end は 0 始まりで end を含む。 */
export interface Chapter {
  title: string
  start: number
  end: number
  sections: { title: string; page: number }[]
  /** 章の要約(Markdown)。まだ無ければ null */
  summary: string | null
}

/** 章立ての 1 項目(編集用)。page は 0 始まり、level 1 = 章 / 2 = 節。 */
export interface ChapterEntry {
  title: string
  page: number
  level: 1 | 2
}

export interface BookStructure {
  chapters: Chapter[]
  /** 編集用の章立て(章と節をページ順に) */
  entries: ChapterEntry[]
  /** 本全体の要約(先の内容を含む)。まだ無ければ null */
  book_summary: string | null
  /** 文字起こし済みのページ数 */
  transcribed: number
  page_count: number
}

/** 章立てと要約を取得する。 */
export async function getStructure(root: string, workId: string): Promise<BookStructure> {
  return jsonFetch(`/works/${workId}/structure?root=${encodeURIComponent(root)}`)
}

/** 本文検索の索引の状態。 */
export interface IndexStatus {
  /** 索引のまとまりの数(0 なら索引なし) */
  chunks: number
  /** 索引を作ったあとで本文か埋め込みモデルが変わった */
  stale: boolean
  /** 索引を作ったときの埋め込みモデル(索引が無ければ null) */
  model: string | null
  /** 今使う埋め込みモデル(Ruri v3) */
  embedding_model: string
}

export async function getIndexStatus(root: string, workId: string): Promise<IndexStatus> {
  return jsonFetch(
    `/works/${workId}/index?root=${encodeURIComponent(root)}`
  )
}

/** 本文検索の索引づくりをキューに積む。 */
export async function enqueueIndex(root: string, workId: string): Promise<JobQueue> {
  return jsonFetch(`/works/${workId}/index`, {
    method: 'POST',
    body: JSON.stringify({ root })
  })
}

/** 手で直した章立てを保存する。範囲が変わった章の要約は消える。 */
export async function saveChapters(
  root: string,
  workId: string,
  chapters: ChapterEntry[]
): Promise<BookStructure> {
  return jsonFetch(`/works/${workId}/structure/chapters`, {
    method: 'PUT',
    body: JSON.stringify({ root, chapters })
  })
}

/** 章立てと要約の作成をキューに積む(redo で章立てから作り直す)。 */
export async function enqueueStructure(
  root: string,
  workId: string,
  redo = false
): Promise<JobQueue> {
  return jsonFetch(`/works/${workId}/structure`, {
    method: 'POST',
    body: JSON.stringify({ root, redo })
  })
}

/** 本文中の図(本フォルダ figures/ の切り抜き画像)の URL。 */
export function figureUrl(root: string, workId: string, name: string): string {
  return imageUrl(`/works/${workId}/figures/${encodeURIComponent(name)}?root=${encodeURIComponent(root)}`)
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** 思考(reasoning)過程。表示用。送信時は除外する。 */
  reasoning?: string
  /** 応答の材料にした本文(参照の表示用。送信時は除外する)。 */
  sources?: ChatSources
}

/** チャットの応答の材料にした本文。ページは 0 始まり。 */
export interface ChatSources {
  /** 今のページ付近として渡した範囲 [最初, 最後]。本文が無ければ null。 */
  nearby: [number, number] | null
  /** 質問の語が出てくるページ(キーワード検索) */
  keyword: number[]
  /** 質問に近いページ(本文検索) */
  search: number[]
  /** 渡した章の要約の数 */
  summaries: number
}

interface ChatOpts {
  currentPage?: number
  includeImage?: boolean
  pageFocus?: boolean
  /** 本文に無いことも一般知識で補って答えるか */
  generalKnowledge?: boolean
  /** ネタバレ防止(本ごと)。false なら章の要約・検索を本全体から取る */
  spoilerGuard?: boolean
  systemPrompt?: string
  think?: boolean
  /** 本文を渡す上限(文字数)。省略時は backend の既定 */
  contextChars?: number
  /** 本文検索(埋め込みの索引)も使うか。省略時は検索しない */
  search?: boolean
}

function chatBody(root: string, messages: ChatTurn[], opts?: ChatOpts): string {
  return JSON.stringify({
    root,
    // 送信は role/content のみ(reasoning は表示専用)。
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    current_page: opts?.currentPage ?? null,
    include_image: opts?.includeImage ?? false,
    page_focus: opts?.pageFocus ?? false,
    general_knowledge: opts?.generalKnowledge ?? true,
    spoiler_guard: opts?.spoilerGuard ?? true,
    system_prompt: opts?.systemPrompt ?? null,
    context_chars: opts?.contextChars ?? null,
    search: opts?.search ?? false,
    think: opts?.think ?? false
  })
}

/** 本チャットのストリーム版。SSE を読み、reasoning / content の差分をコールバックする。 */
export async function chatAboutWorkStream(
  root: string,
  workId: string,
  messages: ChatTurn[],
  opts: ChatOpts | undefined,
  handlers: {
    onReasoning?: (t: string) => void
    onContent?: (t: string) => void
    onSources?: (s: ChatSources) => void
  },
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(api(`/works/${workId}/chat/stream`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
    body: chatBody(root, messages, opts),
    signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} ${text}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        void reader.cancel().catch(() => {})
        return
      }
      let delta: { type?: string; text?: string } & Partial<ChatSources>
      try {
        delta = JSON.parse(payload)
      } catch {
        continue
      }
      if (delta.type === 'sources') {
        handlers.onSources?.({
          nearby: delta.nearby ?? null,
          keyword: delta.keyword ?? [],
          search: delta.search ?? [],
          summaries: delta.summaries ?? 0
        })
      } else if (delta.type === 'reasoning' && delta.text) handlers.onReasoning?.(delta.text)
      else if (delta.type === 'content' && delta.text) handlers.onContent?.(delta.text)
      else if (delta.type === 'error') {
        void reader.cancel().catch(() => {})
        throw new Error(delta.text || 'LLM エラー')
      }
    }
  }
}

/** 状況に合った質問候補を作る(チャット末尾のチップに混ぜる)。
 *  候補は付加機能なので、モデル未起動・生成失敗はサーバ側で空配列になる。 */
export async function suggestChatQuestions(
  root: string,
  workId: string,
  messages: ChatTurn[],
  opts?: ChatOpts,
  signal?: AbortSignal
): Promise<string[]> {
  const data = await jsonFetch<{ questions: string[] }>(`/works/${workId}/chat/suggest`, {
    method: 'POST',
    body: chatBody(root, messages, opts),
    signal
  })
  return data.questions ?? []
}

/** その本のジョブを止める(待機中は取り消し、実行中は次の区切りで中断)。 */
export async function cancelJob(workId: string): Promise<JobQueue> {
  return jsonFetch(`/queue/cancel`, { method: 'POST', body: JSON.stringify({ work_id: workId }) })
}

/** 待機中のジョブをすべて取り消す(実行中のものも中断する)。 */
export async function clearQueue(): Promise<JobQueue> {
  return jsonFetch(`/queue/clear`, { method: 'POST' })
}

export interface LlmModel {
  name: string
  path: string
  mmproj: string | null
  dir: string
  size: number
  vision: boolean
}

export interface LlmStatus {
  running: boolean
  /** 読み込み中(起動確認の待ち)。 */
  loading?: boolean
  model: string | null
  base_url: string | null
}

export interface LlmModelList {
  models: LlmModel[]
  status: LlmStatus
  /** 実際に走査したフォルダ(未指定なら既定の models/)。 */
  models_dir: string
  /** そのフォルダが存在するか。false なら指定ミスを UI で示す。 */
  exists: boolean
}

/** モデル一覧を取得する。modelsDir が空なら backend 既定の models/ を走査する。 */
export async function listLlmModels(modelsDir = ''): Promise<LlmModelList> {
  return jsonFetch(`/llm/models?models_dir=${encodeURIComponent(modelsDir)}`)
}

export async function getLlmStatus(): Promise<LlmStatus> {
  return jsonFetch(`/llm/status`)
}

export async function loadLlmModel(opts: {
  modelPath: string
  mmprojPath: string | null
  serverPath: string
  ctxSize: number
  baseUrl: string
}): Promise<LlmStatus> {
  return jsonFetch(`/llm/load`, {
    method: 'POST',
    body: JSON.stringify({
      model_path: opts.modelPath,
      mmproj_path: opts.mmprojPath,
      server_path: opts.serverPath,
      ctx_size: opts.ctxSize,
      base_url: opts.baseUrl
    })
  })
}

export async function unloadLlmModel(): Promise<LlmStatus> {
  return jsonFetch(`/llm/unload`, { method: 'POST' })
}

export interface InstalledBuild {
  name: string
  server_path: string
}

export interface ReleaseBuild {
  name: string
  label: string
  kind: string
  url: string
  size: number
  cudart_url: string | null
}

export async function listLlamaBuilds(): Promise<{
  installed: InstalledBuild[]
  auto_detected: string | null
}> {
  return jsonFetch(`/llm/builds`)
}

export async function listLatestLlamaReleases(): Promise<{ tag: string; builds: ReleaseBuild[] }> {
  return jsonFetch(`/llm/builds/latest`)
}

export async function downloadLlamaBuild(
  build: ReleaseBuild
): Promise<{ name: string; server_path: string }> {
  return jsonFetch(`/llm/builds/download`, {
    method: 'POST',
    body: JSON.stringify({ url: build.url, name: build.name, cudart_url: build.cudart_url })
  })
}

/** 本サムネイルの URL。<img src> に直接渡す。 */
export function thumbnailUrl(root: string, workId: string): string {
  return imageUrl(`/works/${workId}/thumbnail?root=${encodeURIComponent(root)}`)
}

// ---- 音声読み上げ(Irodori-TTS) ----

/** 読み上げサーバーの状態。 */
export interface TtsStatus {
  installed: boolean
  server_dir: string
  server_dir_default: string
  models_dir: string
  base_url: string
  uv: boolean
  /** 合成できる(動いていてモデルも読み込み済み) */
  running: boolean
  /** 起動・モデルの読み込み中 */
  starting: boolean
  /** 別のアプリが起動したサーバーを使っている(止められない) */
  external: boolean
  checkpoint: string | null
  error: string | null
  log_path: string
  install: { phase: 'step' | 'done' | 'error'; label: string; lines: string[]; error: string | null } | null
}

/** 読み上げサーバーの置き場と接続先(設定の値)。 */
export interface TtsServerOpts {
  serverDir: string
  modelsDir: string
  baseUrl: string
}

function ttsQuery(o: TtsServerOpts): string {
  const q = new URLSearchParams({ server_dir: o.serverDir, models_dir: o.modelsDir, base_url: o.baseUrl })
  return q.toString()
}

function ttsBody(o: TtsServerOpts): string {
  return JSON.stringify({ server_dir: o.serverDir, models_dir: o.modelsDir, base_url: o.baseUrl })
}

export async function getTtsStatus(o: TtsServerOpts): Promise<TtsStatus> {
  return jsonFetch(`/tts/status?${ttsQuery(o)}`)
}

/** サーバーを起動する(待たずに返る。準備ができたかは getTtsStatus で見る)。 */
export async function startTts(o: TtsServerOpts): Promise<TtsStatus> {
  return jsonFetch('/tts/start', { method: 'POST', body: ttsBody(o) })
}

export async function stopTts(): Promise<TtsStatus> {
  return jsonFetch('/tts/stop', { method: 'POST' })
}

/** Irodori-TTS-Server を入れる(背後で実行。進み具合は getTtsStatus の install)。 */
export async function installTts(o: TtsServerOpts): Promise<TtsStatus> {
  return jsonFetch('/tts/install', { method: 'POST', body: ttsBody(o) })
}

/** 声の指定(設定の値)。 */
export interface TtsVoice {
  caption: string
  /** 参照音声のパス(空なら声の説明だけで声を作る) */
  refWav: string
  seed: number | null
}

/** 設定の tts から、今の読み上げに使う声を組む(参照音声は ON で選んだものだけ)。 */
export function ttsVoiceOf(t: AppSettings['tts']): TtsVoice {
  const ref = t.refWavEnabled ? t.refWavs.find((r) => r.id === t.refWavId) : undefined
  return { caption: t.caption, refWav: ref?.path ?? '', seed: t.seed }
}

async function blobFetch(url: string, init?: RequestInit): Promise<Blob> {
  if (!baseUrl) throw new Error('バックエンドに接続していません')
  const res = await fetch(url, { ...init, headers: { [TOKEN_HEADER]: token, ...(init?.headers ?? {}) } })
  if (!res.ok) {
    let detail = await res.text().catch(() => '')
    try {
      detail = String(JSON.parse(detail).detail ?? detail)
    } catch {
      // そのまま
    }
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  const type = (res.headers.get('content-type') ?? 'audio/ogg').split(';')[0].trim()
  return new Blob([await res.arrayBuffer()], { type })
}

/** 参照音声(ローカルの音声ファイル)を試聴のために取り出す。 */
export async function fetchTtsRefAudio(path: string): Promise<Blob> {
  return blobFetch(api(`/tts/ref-audio?path=${encodeURIComponent(path)}`))
}

/** 本文を音声にする(opus か wav の Blob)。 */
export async function ttsSpeak(ttsBaseUrl: string, text: string, voice: TtsVoice): Promise<Blob> {
  return blobFetch(api('/tts/speak'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: ttsBaseUrl,
      text,
      caption: voice.caption,
      ref_wav: voice.refWav,
      seed: voice.seed
    })
  })
}
