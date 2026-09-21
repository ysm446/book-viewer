/** バックエンド (FastAPI) への薄い HTTP クライアント。 */

let baseUrl = ''

export interface Work {
  id: string
  rel_path: string
  title: string
  author: string
  /** 本文の書字方向(取り込み時に指定) */
  writing_mode: WritingMode
  page_count: number
  page_direction: string
  spread_offset: string
  sort_index: number | null
  added_at: string
  last_opened_at: string | null
  last_page: number
  completed: number
  tags: string[]
}

export type WritingMode = 'horizontal' | 'vertical'

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
  return info
}

function api(path: string): string {
  return `${baseUrl}/api${path}`
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
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

/** 作品を削除する(本フォルダはごみ箱へ移動)。 */
export async function deleteWork(root: string, workId: string): Promise<void> {
  await jsonFetch(`/works/${workId}?root=${encodeURIComponent(root)}`, { method: 'DELETE' })
}

/** タイトル・あらすじ・ページ説明を横断検索し、該当 work_id を返す。 */
export async function searchWorks(root: string, q: string): Promise<string[]> {
  const data = await jsonFetch<{ work_ids: string[] }>(
    `/roots/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`
  )
  return data.work_ids
}

export async function saveReadingState(
  root: string,
  workId: string,
  lastPage: number,
  completed = false
): Promise<void> {
  await jsonFetch(`/works/${workId}/reading-state?root=${encodeURIComponent(root)}`, {
    method: 'PUT',
    body: JSON.stringify({ last_page: lastPage, completed })
  })
}

export type Direction = 'default' | 'rtl' | 'ltr'
export type SpreadOffset = 'default' | '0' | '1'

/** 作品ごとの読み進め方向の上書きを保存する。 */
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

/** 作品ごとの見開きペア境界ずらしを保存する。 */
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
  return api(`/works/${workId}/pages/${index}?root=${encodeURIComponent(root)}`)
}

/** 作品にタグを付ける(無ければ作成)。 */
export async function addWorkTag(root: string, workId: string, name: string): Promise<void> {
  await jsonFetch(`/works/${workId}/tags?root=${encodeURIComponent(root)}`, {
    method: 'POST',
    body: JSON.stringify({ name })
  })
}

/** 作品からタグを外す。 */
export async function removeWorkTag(root: string, workId: string, name: string): Promise<void> {
  await jsonFetch(
    `/works/${workId}/tags?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`,
    { method: 'DELETE' }
  )
}

export interface AnalysisResult {
  summary: string
  status: string
  model: string | null
  created_at: string | null
}

export interface PageAnalysis {
  page: number
  description: string | null
  text: string | null
  model: string | null
  created_at: string
}

/** 作品の全体解析(あらすじ)と、解析済みページ番号一覧を取得する。 */
export async function getAnalysis(
  root: string,
  workId: string
): Promise<{ analysis: AnalysisResult | null; analyzedPages: number[] }> {
  const data = await jsonFetch<{ analysis: AnalysisResult | null; analyzed_pages: number[] }>(
    `/works/${workId}/analysis?root=${encodeURIComponent(root)}`
  )
  return { analysis: data.analysis, analyzedPages: data.analyzed_pages ?? [] }
}

/** 指定ページの解析結果(無ければ null)。 */
export async function getPageAnalysis(
  root: string,
  workId: string,
  page: number
): Promise<PageAnalysis | null> {
  const data = await jsonFetch<{ analysis: PageAnalysis | null }>(
    `/works/${workId}/page-analysis?root=${encodeURIComponent(root)}&page=${page}`
  )
  return data.analysis
}

export interface AnalysisProgress {
  phase: string
  current: number
  total: number
}

/** キューのジョブ種別(解析 / 文字起こし)。 */
export type JobKind = 'analyze' | 'transcribe'

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
export interface AnalysisQueue {
  current: QueueCurrent | null
  pending: QueueItem[]
  recent: QueueRecent[]
}

export async function enqueueAnalysis(
  root: string,
  workIds: string[],
  samplePages: number,
  opts?: {
    focusPage?: number
    pages?: number[]
    systemPrompt?: string | null
    allPages?: boolean
    contextCount?: number
    summaryOnly?: boolean
    useStorySummary?: boolean
    storyEvery?: number
  }
): Promise<AnalysisQueue> {
  return jsonFetch(`/analysis/enqueue`, {
    method: 'POST',
    body: JSON.stringify({
      root,
      work_ids: workIds,
      sample_pages: samplePages,
      focus_page: opts?.focusPage ?? null,
      pages: opts?.pages ?? null,
      system_prompt: opts?.systemPrompt ?? null,
      all_pages: opts?.allPages ?? false,
      context_count: opts?.contextCount ?? 0,
      summary_only: opts?.summaryOnly ?? false,
      use_story_summary: opts?.useStorySummary ?? false,
      story_every: opts?.storyEvery ?? 5
    })
  })
}

export async function getAnalysisQueue(): Promise<AnalysisQueue> {
  return jsonFetch(`/analysis/queue`)
}

/** 文字起こし済みのページ番号(0 始まり)。 */
export async function getTextPages(root: string, workId: string): Promise<number[]> {
  const data = await jsonFetch<{ pages: number[] }>(
    `/works/${workId}/text?root=${encodeURIComponent(root)}`
  )
  return data.pages
}

/** ページの本文(Markdown)。未処理なら null。 */
export async function getPageText(root: string, workId: string, index: number): Promise<string | null> {
  const data = await jsonFetch<{ markdown: string | null }>(
    `/works/${workId}/text/${index}?root=${encodeURIComponent(root)}`
  )
  return data.markdown
}

/** 文字起こしをキューに積む(pages 省略時は未処理の全ページ、force で作り直し)。 */
export async function enqueueTranscribe(
  root: string,
  workId: string,
  opts?: { pages?: number[]; force?: boolean }
): Promise<AnalysisQueue> {
  return jsonFetch(`/works/${workId}/transcribe`, {
    method: 'POST',
    body: JSON.stringify({ root, pages: opts?.pages ?? null, force: opts?.force ?? false })
  })
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  /** 思考(reasoning)過程。表示用。送信時は除外する。 */
  reasoning?: string
}

interface ChatOpts {
  currentPage?: number
  includeImage?: boolean
  pageFocus?: boolean
  systemPrompt?: string
  think?: boolean
}

function chatBody(root: string, messages: ChatTurn[], opts?: ChatOpts): string {
  return JSON.stringify({
    root,
    // 送信は role/content のみ(reasoning は表示専用)。
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    current_page: opts?.currentPage ?? null,
    include_image: opts?.includeImage ?? false,
    page_focus: opts?.pageFocus ?? false,
    system_prompt: opts?.systemPrompt ?? null,
    think: opts?.think ?? false
  })
}

/** 作品について会話する(非ストリーム)。 */
export async function chatAboutWork(
  root: string,
  workId: string,
  messages: ChatTurn[],
  opts?: ChatOpts
): Promise<{ reply: string }> {
  return jsonFetch(`/works/${workId}/chat`, { method: 'POST', body: chatBody(root, messages, opts) })
}

/** 作品チャットのストリーム版。SSE を読み、reasoning / content の差分をコールバックする。 */
export async function chatAboutWorkStream(
  root: string,
  workId: string,
  messages: ChatTurn[],
  opts: ChatOpts | undefined,
  handlers: { onReasoning?: (t: string) => void; onContent?: (t: string) => void },
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(api(`/works/${workId}/chat/stream`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
      let delta: { type?: string; text?: string }
      try {
        delta = JSON.parse(payload)
      } catch {
        continue
      }
      if (delta.type === 'reasoning' && delta.text) handlers.onReasoning?.(delta.text)
      else if (delta.type === 'content' && delta.text) handlers.onContent?.(delta.text)
      else if (delta.type === 'error') throw new Error(delta.text || 'LLM エラー')
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

export async function cancelAnalysis(workId: string): Promise<AnalysisQueue> {
  return jsonFetch(`/analysis/cancel`, { method: 'POST', body: JSON.stringify({ work_id: workId }) })
}

export async function clearAnalysisQueue(): Promise<AnalysisQueue> {
  return jsonFetch(`/analysis/clear`, { method: 'POST' })
}

/** 作品の最新タグを取得する(解析後の反映用)。 */
export async function getWorkTags(root: string, workId: string): Promise<string[]> {
  const data = await jsonFetch<{ tags: string[] }>(
    `/works/${workId}?root=${encodeURIComponent(root)}`
  )
  return data.tags ?? []
}

/** 解析中の進捗を取得する。 */
export async function getAnalysisProgress(workId: string): Promise<AnalysisProgress> {
  return jsonFetch(`/works/${workId}/analysis/progress`)
}

/** LLM サーバへの到達性を確認する。 */
export async function pingLlm(baseUrl: string): Promise<boolean> {
  const data = await jsonFetch<{ ok: boolean }>(`/llm/ping`, {
    method: 'POST',
    body: JSON.stringify({ base_url: baseUrl })
  })
  return data.ok
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

/** 作品サムネイルの URL。<img src> に直接渡す。 */
export function thumbnailUrl(root: string, workId: string): string {
  return api(`/works/${workId}/thumbnail?root=${encodeURIComponent(root)}`)
}
