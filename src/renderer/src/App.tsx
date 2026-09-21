import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelJob,
  clearQueue,
  enqueueStructure,
  enqueueTranscribe,
  getQueue,
  getLlmStatus,
  health,
  initApi,
  inspectArchives,
  listLooseArchives,
  listLlmModels,
  deleteWork,
  listWorks,
  loadLlmModel,
  renameWork,
  scanRoot,
  setWorksOrder,
  searchWorks,
  thumbnailUrl,
  unloadLlmModel,
  type JobQueue,
  type Direction,
  type ImportCandidate,
  type ImportResult,
  type LlmModel,
  type LlmStatus,
  type ScanResult,
  type SpreadOffset,
  type Work,
  type WritingMode
} from './api'
import { ImportDialog } from './ImportDialog'
import { Reader } from './Reader'
import { Settings } from './Settings'
import { ModelPicker } from './ModelPicker'
import { SystemResourceMonitor } from './SystemResourceMonitor'
import { Toast, type ToastState } from './Toast'
import type { AppSettings, AppSettingsPatch } from '../../preload'

/** プロセッサ(チップ)アイコン。 */
function ProcessorIcon(): JSX.Element {
  return (
    <svg
      className="model-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </svg>
  )
}

type Status = 'connecting' | 'ready' | 'error'
type ReadFilter = 'all' | 'unread' | 'reading' | 'done'
type SortKey = 'title' | 'added' | 'recent' | 'custom'

/** 取り込める拡張子(backend config.ARCHIVE_EXTENSIONS と一致させる)。 */
const ARCHIVE_EXT_RE = /\.(zip|cbz|pdf)$/i

// 手動順の比較。未設定(null)は末尾に回し、同順位はタイトル順で安定させる。
function bySortIndex(a: Work, b: Work): number {
  const ai = a.sort_index ?? Number.MAX_SAFE_INTEGER
  const bi = b.sort_index ?? Number.MAX_SAFE_INTEGER
  return ai - bi || a.title.localeCompare(b.title, 'ja')
}

const SIDEBAR_MIN = 240
const SIDEBAR_DEFAULT = 340

function fmtElapsed(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>('connecting')
  const [root, setRoot] = useState<string | null>(null)
  const [works, setWorks] = useState<Work[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [current, setCurrent] = useState<Work | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [query, setQuery] = useState('')
  const [readFilter, setReadFilter] = useState<ReadFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('title')
  const [tagFilter, setTagFilter] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [searchMatches, setSearchMatches] = useState<Set<string> | null>(null)
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({ running: false, model: null, base_url: null })
  const [models, setModels] = useState<LlmModel[]>([])
  // backend が実際に走査したモデルフォルダ(空一覧のときに場所を示す)。
  const [modelsDir, setModelsDir] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [loadingModel, setLoadingModel] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  // ファイル名変更ダイアログ(Electron では window.prompt が使えないため自前で持つ)。
  const [renameTarget, setRenameTarget] = useState<Work | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [queue, setQueue] = useState<JobQueue | null>(null)
  const [currentElapsed, setCurrentElapsed] = useState(0)
  // 目次パネルの開閉は本をまたいで保持する。
  const [readerShowInfo, setReaderShowInfo] = useState(false)
  // しおり一覧は既定で常時表示。
  const [readerShowBookmarks, setReaderShowBookmarks] = useState(true)
  const [readerShowChat, setReaderShowChat] = useState(false)
  // 下部ステータスバーのリソース表示トグル(localStorage に保持)。
  const [showResources, setShowResources] = useState<boolean>(
    () => localStorage.getItem('showResources') === '1'
  )
  useEffect(() => {
    localStorage.setItem('showResources', showResources ? '1' : '0')
  }, [showResources])
  // 「管理ルートを選択」の最近フォルダドロップダウン。
  const [recentOpen, setRecentOpen] = useState(false)
  const rootPickerRef = useRef<HTMLDivElement | null>(null)
  // 右下の一時通知(スクリーンショットの保存結果など)。
  const [toast, setToast] = useState<ToastState | null>(null)
  const notify = useCallback((message: string, path: string | null, error = false): void => {
    setToast({ id: Date.now(), message, path, error })
  }, [])
  const closeToast = useCallback(() => setToast(null), [])
  // 本の取り込みダイアログ(候補と、元ファイルの扱いの初期値)。
  const [importState, setImportState] = useState<{
    candidates: ImportCandidate[]
    mode: 'copy' | 'move'
  } | null>(null)
  // 管理ルート内の未取り込みアーカイブ数(一覧上部の案内に使う)。
  const [looseCount, setLooseCount] = useState(0)
  // ファイルをウィンドウへドラッグ中か(取り込み案内の表示)。
  const [dropActive, setDropActive] = useState(false)

  // F12: ウィンドウのコンテンツ領域をキャプチャして <管理ルート>/screenshot/ に保存する。
  const captureWindow = useCallback(async (): Promise<void> => {
    if (!root) {
      notify('先に管理ルートを選択してください', null, true)
      return
    }
    // 直前の通知が写り込まないよう、消してから描画を 1 フレーム待つ。
    setToast(null)
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
    )
    try {
      const path = await window.api.captureWindow(root, current?.title ?? 'library')
      notify('ウィンドウを保存しました', path)
    } catch (e) {
      notify(`保存に失敗しました: ${(e as Error).message}`, null, true)
    }
  }, [root, current, notify])

  // main が横取りした F9 / F12 の通知。F9(ページ画像の保存)は Reader 側で処理するため、
  // ここでは本が開かれていないときの案内だけ出す。
  useEffect(() => {
    return window.api.onShortcut((name) => {
      if (name === 'capture-window') void captureWindow()
      else if (name === 'save-pages' && !current) {
        notify('本を開いてから F9 を押してください', null, true)
      }
    })
  }, [captureWindow, current, notify])

  useEffect(() => {
    ;(async () => {
      try {
        await initApi()
        await health()
        setStatus('ready')
      } catch {
        setStatus('error')
      }
      try {
        const loaded = await window.api.getSettings()
        setSettings(loaded)
        // 前回の管理ルートを自動復元する(先頭が最新)。
        const last = loaded.recentRoots[0]
        if (last) {
          setRoot(last)
          const list = await rescan(last)
          // 最後に読んでいた本を自動で開く(ページ位置は work.last_page から復元される)。
          if (loaded.lastWorkId && list) {
            const w = list.find((x) => x.id === loaded.lastWorkId)
            if (w) setCurrent(w)
          }
        }
      } catch {
        // 既定値で動かす(取得失敗時)
      }
      try {
        setLlmStatus(await getLlmStatus())
      } catch {
        // バックエンド未起動時は無視
      }
    })()
  }, [])

  // バックエンドが落ちたら知らせ、再起動できるようにする(YomiToku の OOM などで uvicorn ごと落ちることがある)。
  const [restarting, setRestarting] = useState(false)
  useEffect(
    () =>
      window.api.onBackendExited(() => {
        setStatus('error')
        setLlmStatus({ running: false, model: null, base_url: null })
        notify('バックエンドが停止しました。上部の「再起動」で起動し直せます', null, true)
      }),
    [notify]
  )
  async function restartBackend(): Promise<void> {
    if (restarting) return
    setRestarting(true)
    setStatus('connecting')
    try {
      await window.api.restartBackend()
      await initApi()
      await health()
      setStatus('ready')
      if (root) await rescan(root)
    } catch (e) {
      setStatus('error')
      notify(`バックエンドを起動できませんでした: ${(e as Error).message}`, null, true)
    } finally {
      setRestarting(false)
    }
  }

  // ジョブキューを定期取得し、ジョブ完了時は一覧(タグ等)を更新する。
  useEffect(() => {
    let lastCurrent: string | null = null
    const tick = async (): Promise<void> => {
      try {
        const q = await getQueue()
        setQueue(q)
        const cur = q.current?.work_id ?? null
        if (cur !== lastCurrent) {
          lastCurrent = cur
          if (root) {
            try {
              setWorks(await listWorks(root))
            } catch {
              // 無視
            }
          }
        }
      } catch {
        // 無視
      }
    }
    const id = setInterval(tick, 2000)
    tick()
    return () => clearInterval(id)
  }, [root])

  // 現在ジョブの経過時間を1秒ごとに補間表示(ポーリング間も滑らかに)。
  useEffect(() => {
    const cur = queue?.current
    if (!cur) {
      setCurrentElapsed(0)
      return
    }
    const base = cur.elapsed
    const at = Date.now()
    setCurrentElapsed(base)
    const id = setInterval(
      () => setCurrentElapsed(base + Math.floor((Date.now() - at) / 1000)),
      1000
    )
    return () => clearInterval(id)
  }, [queue?.current?.work_id, queue?.current?.elapsed])

  // 全文検索(あらすじ・ページ説明)をデバウンスして実行。
  useEffect(() => {
    const q = query.trim()
    if (!root || q === '') {
      setSearchMatches(null)
      return
    }
    // クエリが変わった後に届いた古い応答で上書きしないようにする。
    let stale = false
    const id = setTimeout(async () => {
      try {
        const matches = new Set(await searchWorks(root, q))
        if (!stale) setSearchMatches(matches)
      } catch {
        if (!stale) setSearchMatches(null)
      }
    }, 300)
    return () => {
      stale = true
      clearTimeout(id)
    }
  }, [query, root])

  // 章立てと要約を作る(文字起こし済みの本文から。LLM が必要)。
  async function structureWork(w: Work): Promise<void> {
    setMenuFor(null)
    if (!root) return
    try {
      setQueue(await enqueueStructure(root, w.id))
    } catch (e) {
      notify(`章立てと要約を開始できませんでした: ${(e as Error).message}`, null, true)
    }
  }

  async function transcribeWork(w: Work): Promise<void> {
    setMenuFor(null)
    if (!root) return
    try {
      setQueue(await enqueueTranscribe(root, w.id, { engine: settings?.transcribeEngine }))
    } catch (e) {
      notify(`文字起こしを開始できませんでした: ${(e as Error).message}`, null, true)
    }
  }

  async function applyRename(): Promise<void> {
    if (!root || !renameTarget) return
    const name = renameValue.trim()
    if (!name || name === renameTarget.title) {
      setRenameTarget(null)
      return
    }
    try {
      const res = await renameWork(root, renameTarget.id, name)
      setWorks((ws) =>
        ws.map((x) =>
          x.id === renameTarget.id ? { ...x, title: res.title, rel_path: res.rel_path } : x
        )
      )
      setCurrent((c) =>
        c && c.id === renameTarget.id ? { ...c, title: res.title, rel_path: res.rel_path } : c
      )
      setRenameTarget(null)
    } catch (e) {
      setRenameTarget(null)
      setMessage(`エラー: ${(e as Error).message}`)
    }
  }

  async function removeWork(w: Work): Promise<void> {
    setMenuFor(null)
    if (!root) return
    if (
      !window.confirm(
        `「${w.title}」を削除します。本フォルダ（元のファイル・生成データを含む）はごみ箱へ移動します。よろしいですか？`
      )
    ) {
      return
    }
    try {
      await deleteWork(root, w.id)
      setWorks((ws) => ws.filter((x) => x.id !== w.id))
      setCurrent((c) => (c && c.id === w.id ? null : c))
    } catch (e) {
      setMessage(`エラー: ${(e as Error).message}`)
    }
  }

  async function cancelQueueItem(id: string): Promise<void> {
    try {
      setQueue(await cancelJob(id))
    } catch {
      // 無視
    }
  }

  async function clearAllJobs(): Promise<void> {
    try {
      setQueue(await clearQueue())
    } catch {
      // 無視
    }
  }

  async function openModelPicker(): Promise<void> {
    setModelError(null)
    setShowModelPicker(true)
    try {
      const r = await listLlmModels(settings?.llm.modelsDir ?? '')
      setModels(r.models)
      setModelsDir(r.models_dir)
      setLlmStatus(r.status)
    } catch (e) {
      setModelError((e as Error).message)
    }
  }

  async function handleLoadModel(model: LlmModel): Promise<void> {
    if (!settings) return
    // 選択したらすぐウィンドウを閉じ、上部バーで読み込み中を示す。
    setLoadingModel(model.name)
    setModelError(null)
    setShowModelPicker(false)
    try {
      const status = await loadLlmModel({
        modelPath: model.path,
        mmprojPath: model.mmproj,
        serverPath: settings.llm.serverPath,
        ctxSize: settings.llm.ctxSize,
        baseUrl: settings.llm.baseUrl
      })
      setLlmStatus(status)
    } catch (e) {
      // 失敗したらエラーを見せるためピッカーを開き直す。
      setModelError((e as Error).message)
      setShowModelPicker(true)
    } finally {
      setLoadingModel(null)
    }
  }

  async function handleUnloadModel(): Promise<void> {
    try {
      setLlmStatus(await unloadLlmModel())
    } catch {
      // 無視
    }
  }

  // 最近フォルダのドロップダウンは外側クリック / Escape で閉じる。
  useEffect(() => {
    if (!recentOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rootPickerRef.current && !rootPickerRef.current.contains(e.target as Node)) {
        setRecentOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRecentOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [recentOpen])

  function changeSettings(patch: AppSettingsPatch): void {
    // 入力が即時反映されるようローカルを先に更新し、保存は背後で行う
    // (毎キーストロークの IPC 往復による IME のカーソル飛びを防ぐ)。
    // llm は部分パッチを許すため深いマージにする(main 側の保存も同様)。
    setSettings((prev) =>
      prev
        ? { ...prev, ...patch, llm: patch.llm ? { ...prev.llm, ...patch.llm } : prev.llm }
        : prev
    )
    void window.api.setSettings(patch)
  }

  // 本を開き、次回起動時に復元できるよう最後に開いた本として記録する。
  function openWork(w: Work): void {
    setCurrent(w)
    changeSettings({ lastWorkId: w.id })
  }

  function handleDirectionChange(workId: string, direction: Direction): void {
    setWorks((ws) => ws.map((w) => (w.id === workId ? { ...w, page_direction: direction } : w)))
    setCurrent((c) => (c && c.id === workId ? { ...c, page_direction: direction } : c))
  }

  function handleProgress(workId: string, page: number, completed: boolean): void {
    // 一覧の既読位置を更新(セッション中に同じ本を開き直しても復元できるように)。
    setWorks((ws) =>
      ws.map((w) =>
        w.id === workId ? { ...w, last_page: page, completed: completed ? 1 : 0 } : w
      )
    )
  }

  function handleWritingModeChange(workId: string, writingMode: WritingMode): void {
    setWorks((ws) => ws.map((w) => (w.id === workId ? { ...w, writing_mode: writingMode } : w)))
    setCurrent((c) => (c && c.id === workId ? { ...c, writing_mode: writingMode } : c))
  }

  function handleSpreadOffsetChange(workId: string, offset: SpreadOffset): void {
    setWorks((ws) => ws.map((w) => (w.id === workId ? { ...w, spread_offset: offset } : w)))
    setCurrent((c) => (c && c.id === workId ? { ...c, spread_offset: offset } : c))
  }

  function handleTagsChange(workId: string, tags: string[]): void {
    setWorks((ws) => ws.map((w) => (w.id === workId ? { ...w, tags } : w)))
    setCurrent((c) => (c && c.id === workId ? { ...c, tags } : c))
  }

  // 管理ルートを開き、最近使ったフォルダに記録する(重複除去・先頭が最新・最大8件)。
  async function openRoot(target: string): Promise<void> {
    setRoot(target)
    setCurrent(null)
    if (settings) {
      const recentRoots = [target, ...settings.recentRoots.filter((p) => p !== target)].slice(0, 8)
      setSettings({ ...settings, recentRoots, lastWorkId: null })
      void window.api.setSettings({ recentRoots, lastWorkId: null })
    }
    await rescan(target)
  }

  async function selectRoot(): Promise<void> {
    const picked = await window.api.selectFolder()
    if (picked) await openRoot(picked)
  }

  // 管理ルートを素早く切り替えたとき、遅れて返った前のルートの結果で一覧を上書きしないための世代番号。
  const scanGen = useRef(0)
  async function rescan(target: string): Promise<Work[] | null> {
    const gen = ++scanGen.current
    setBusy(true)
    setMessage('スキャン中…')
    try {
      const result = await scanRoot(target)
      const list = await listWorks(target)
      if (gen !== scanGen.current) return null
      setWorks(list)
      setLooseCount(result.loose)
      setMessage(`本 ${result.total} 冊`)
      return list
    } catch (e) {
      if (gen !== scanGen.current) return null
      setMessage(`エラー: ${(e as Error).message}`)
      return null
    } finally {
      if (gen === scanGen.current) setBusy(false)
    }
  }

  // 指定パスのアーカイブを調べて取り込みダイアログを開く。
  async function startImport(paths: string[], mode: 'copy' | 'move'): Promise<void> {
    if (!root) {
      notify('先に管理ルートを選択してください', null, true)
      return
    }
    const targets = paths.filter((p) => ARCHIVE_EXT_RE.test(p))
    if (targets.length === 0) {
      notify('取り込めるファイル（zip / cbz / pdf）がありません', null, true)
      return
    }
    try {
      setImportState({ candidates: await inspectArchives(root, targets), mode })
    } catch (e) {
      notify(`ファイルを確認できませんでした: ${(e as Error).message}`, null, true)
    }
  }

  async function pickAndImport(): Promise<void> {
    const paths = await window.api.selectArchives()
    if (paths.length > 0) await startImport(paths, 'copy')
  }

  // 管理ルート内の未取り込みアーカイブは、ルート内の整理なので移動を初期値にする。
  async function importLoose(): Promise<void> {
    if (!root) return
    try {
      const candidates = await listLooseArchives(root)
      if (candidates.length === 0) {
        setLooseCount(0)
        return
      }
      setImportState({ candidates, mode: 'move' })
    } catch (e) {
      notify(`ファイルを確認できませんでした: ${(e as Error).message}`, null, true)
    }
  }

  async function handleImportDone(results: ImportResult[], scan: ScanResult): Promise<void> {
    setImportState(null)
    setLooseCount(scan.loose)
    setMessage(`本 ${scan.total} 冊`)
    if (root) {
      try {
        setWorks(await listWorks(root))
      } catch {
        // 次回のスキャンで反映される
      }
    }
    const ok = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok)
    if (failed.length === 0) {
      notify(`${ok} 冊を取り込みました`, null)
    } else {
      notify(
        `${ok} 冊を取り込み、${failed.length} 件は失敗しました（${failed[0].error ?? '不明なエラー'}）`,
        null,
        true
      )
    }
  }

  // ウィンドウへのファイルのドラッグ&ドロップで取り込む(一覧の並び替えドラッグとは区別する)。
  function isFileDrag(e: React.DragEvent): boolean {
    return e.dataTransfer.types.includes('Files')
  }

  function handleFileDrop(e: React.DragEvent): void {
    if (!isFileDrag(e)) return
    e.preventDefault()
    setDropActive(false)
    if (importState) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.getPathForFile(f))
      .filter((p) => p !== '')
    void startImport(paths, 'copy')
  }

  // 分割境界のドラッグでサイドバー幅を変更する。
  const startDrag = useCallback(() => {
    const onMove = (e: MouseEvent): void => {
      const max = Math.round(window.innerWidth * 0.5)
      setSidebarWidth(Math.min(Math.max(e.clientX, SIDEBAR_MIN), max))
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

  // 全タグ(候補・絞り込み用)を本一覧から導出する。
  const allTags = useMemo(() => {
    const set = new Set<string>()
    works.forEach((w) => w.tags.forEach((t) => set.add(t)))
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [works])

  // 検索・絞り込み・並び替えを適用した一覧。
  const visibleWorks = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchStatus = (w: Work): boolean => {
      if (readFilter === 'unread') return w.last_page === 0 && w.completed === 0
      if (readFilter === 'reading') return w.last_page > 0 && w.completed === 0
      if (readFilter === 'done') return w.completed === 1
      return true
    }
    const filtered = works.filter(
      (w) =>
        matchStatus(w) &&
        (q === '' ||
          w.title.toLowerCase().includes(q) ||
          (searchMatches?.has(w.id) ?? false)) &&
        (tagFilter === '' || w.tags.includes(tagFilter))
    )
    const sorted = [...filtered]
    if (sortKey === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'ja'))
    } else if (sortKey === 'added') {
      sorted.sort((a, b) => b.added_at.localeCompare(a.added_at))
    } else if (sortKey === 'custom') {
      sorted.sort(bySortIndex)
    } else {
      // 最近開いた順(未読は末尾)
      sorted.sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''))
    }
    return sorted
  }, [works, query, readFilter, sortKey, tagFilter, searchMatches])

  // ---- 手動並び替え(ドラッグ) ----
  const dragIdRef = useRef<string | null>(null)
  const [dropPos, setDropPos] = useState<{ id: string; after: boolean } | null>(null)

  // 新しい全体順序をローカルに反映し、バックエンドへ保存する。
  function applyOrder(ids: string[]): void {
    const pos = new Map(ids.map((id, i) => [id, i]))
    setWorks((ws) => ws.map((w) => ({ ...w, sort_index: pos.get(w.id) ?? w.sort_index })))
    if (root) void setWorksOrder(root, ids).catch(() => {})
  }

  function handleSortChange(v: SortKey): void {
    // 初めて手動順に切り替えたときは、いま見えている順序を初期値として保存する。
    if (v === 'custom' && works.length > 0 && works.every((w) => w.sort_index == null)) {
      const visibleIds = visibleWorks.map((w) => w.id)
      const visibleSet = new Set(visibleIds)
      const rest = works.filter((w) => !visibleSet.has(w.id)).map((w) => w.id)
      applyOrder([...visibleIds, ...rest])
    }
    setSortKey(v)
  }

  function handleRowDrop(targetId: string, after: boolean): void {
    const dragId = dragIdRef.current
    dragIdRef.current = null
    setDropPos(null)
    if (!dragId || dragId === targetId) return
    const ids = [...works].sort(bySortIndex).map((w) => w.id).filter((id) => id !== dragId)
    const idx = ids.indexOf(targetId)
    if (idx < 0) return
    ids.splice(after ? idx + 1 : idx, 0, dragId)
    applyOrder(ids)
  }

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!isFileDrag(e) || importState) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropActive) setDropActive(true)
      }}
      onDragLeave={(e) => {
        // ウィンドウの外へ出たときだけ消す(子要素間の移動では relatedTarget が残る)。
        if (e.relatedTarget === null) setDropActive(false)
      }}
      onDrop={handleFileDrop}
    >
      <header className="topbar">
        <button
          className="icon-btn"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="サイドバーの開閉"
          title="サイドバーの開閉"
        >
          ☰
        </button>
        {status !== 'ready' && (
          <span className={`status status-${status}`}>
            {status === 'connecting' ? 'バックエンド接続中…' : 'バックエンド未接続'}
          </span>
        )}
        {status === 'error' && (
          <button className="btn" onClick={() => void restartBackend()} disabled={restarting}>
            再起動
          </button>
        )}
        <span className="topbar-spacer" />
        {loadingModel ? (
          <span className="model-bar model-bar-loading">
            <span className="model-spinner" aria-hidden="true" />
            <span className="model-name" title={loadingModel}>
              読み込み中… {loadingModel}
            </span>
          </span>
        ) : llmStatus.running ? (
          <span className="model-group">
            <button className="model-switch" onClick={openModelPicker} title="モデルを切り替え">
              <span className="model-cpu" aria-hidden="true">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <path d="M9 2v2" />
                  <path d="M15 2v2" />
                  <path d="M9 20v2" />
                  <path d="M15 20v2" />
                  <path d="M2 9h2" />
                  <path d="M2 15h2" />
                  <path d="M20 9h2" />
                  <path d="M20 15h2" />
                </svg>
              </span>
              <span className="model-name" title={llmStatus.model ?? ''}>
                {llmStatus.model}
              </span>
              <span className="model-caret">▾</span>
            </button>
            <button
              className="model-eject"
              onClick={handleUnloadModel}
              title="モデルをアンロード"
              aria-label="モデルをアンロード"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 13l6-7 6 7z" />
                <line x1="6" y1="18" x2="18" y2="18" />
              </svg>
            </button>
          </span>
        ) : (
          <button
            className="model-bar"
            onClick={openModelPicker}
            disabled={status !== 'ready'}
            title="モデルを読み込む"
          >
            <ProcessorIcon />
            モデルを読み込む ▾
          </button>
        )}
        <span className="topbar-spacer" />
        <button
          className="icon-btn icon-btn-lg"
          onClick={() => setShowSettings((v) => !v)}
          aria-label="設定"
          title="設定"
        >
          ⚙
        </button>
      </header>

      {showModelPicker && (
        <ModelPicker
          models={models}
          modelsDir={modelsDir}
          loadingName={loadingModel}
          activeModel={llmStatus.running ? llmStatus.model : null}
          error={modelError}
          onLoad={handleLoadModel}
          onClose={() => setShowModelPicker(false)}
        />
      )}

      {showSettings && settings && (
        <Settings
          settings={settings}
          onChange={changeSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {importState && root && (
        <ImportDialog
          root={root}
          candidates={importState.candidates}
          defaultMode={importState.mode}
          onClose={() => setImportState(null)}
          onDone={(results, scan) => void handleImportDone(results, scan)}
        />
      )}

      {dropActive && <div className="drop-overlay">ここにドロップして本を取り込む</div>}

      {renameTarget && (
        <div className="modal-backdrop" onClick={() => setRenameTarget(null)}>
          <div
            className="modal rename-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="rename-head">名前を変更</div>
            <input
              className="rename-input"
              value={renameValue}
              autoFocus
              spellCheck={false}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void applyRename()
                if (e.key === 'Escape') setRenameTarget(null)
              }}
            />
            <div className="rename-note">本フォルダの名前も合わせて変更されます。</div>
            <div className="rename-actions">
              <button className="btn" onClick={() => setRenameTarget(null)}>
                キャンセル
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void applyRename()}
                disabled={!renameValue.trim()}
              >
                変更
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="split">
        {sidebarOpen && (
        <>
        {/* エクスプローラ（左ペイン） */}
        <aside className="explorer" style={{ width: sidebarWidth }}>
          <div className="explorer-toolbar">
            <div className="root-picker" ref={rootPickerRef}>
              <button
                className="root-switcher"
                onClick={() => setRecentOpen((v) => !v)}
                disabled={busy || status !== 'ready'}
                title={root ?? '管理ルートを選択'}
                aria-expanded={recentOpen}
              >
                <span className="root-switcher-icon" aria-hidden="true">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                {root ? (
                  <span className="root-switcher-path">{root}</span>
                ) : (
                  <span className="root-switcher-placeholder">管理ルートを選択…</span>
                )}
                <span className="root-switcher-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {recentOpen && (
                <div className="root-recent-menu" role="menu">
                  <button
                    className="root-recent-item root-recent-browse"
                    onClick={() => {
                      setRecentOpen(false)
                      void selectRoot()
                    }}
                  >
                    <span className="root-recent-icon" aria-hidden="true">
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                    フォルダを選択…
                  </button>
                  {settings && settings.recentRoots.length > 0 && (
                    <>
                      <div className="root-recent-head">最近使ったフォルダ</div>
                      {settings.recentRoots.map((p) => (
                        <button
                          key={p}
                          className={`root-recent-item ${p === root ? 'root-recent-active' : ''}`}
                          title={p}
                          onClick={() => {
                            setRecentOpen(false)
                            if (p !== root) void openRoot(p)
                          }}
                        >
                          {p}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
            {root && (
              <button
                className="icon-btn"
                onClick={() => void pickAndImport()}
                disabled={busy}
                aria-label="本を取り込む"
                title="本を取り込む（zip / cbz / pdf。ウィンドウへのドロップでも可）"
              >
                ＋
              </button>
            )}
            {root && (
              <button
                className="icon-btn"
                onClick={() => rescan(root)}
                disabled={busy}
                aria-label="再スキャン"
                title="再スキャン"
              >
                <span className={busy ? 'icon-spin' : undefined}>⟳</span>
              </button>
            )}
          </div>
          {root && works.length > 0 && (
            <div className="explorer-filters">
              <input
                className="search-input"
                type="search"
                placeholder="書名・著者・要約・本文で検索…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className="filter-toggle"
                onClick={() => setFiltersOpen((v) => !v)}
                aria-expanded={filtersOpen}
              >
                <span className="filter-caret">{filtersOpen ? '▾' : '▸'}</span>
                検索オプション
              </button>
              {filtersOpen && (
                <div className="filter-options">
                  <div className="filter-row">
                    <select
                      className="filter-select"
                      value={readFilter}
                      onChange={(e) => setReadFilter(e.target.value as ReadFilter)}
                      title="既読状態で絞り込み"
                    >
                      <option value="all">すべて</option>
                      <option value="unread">未読</option>
                      <option value="reading">読みかけ</option>
                      <option value="done">読了</option>
                    </select>
                    <select
                      className="filter-select"
                      value={sortKey}
                      onChange={(e) => handleSortChange(e.target.value as SortKey)}
                      title="並び替え"
                    >
                      <option value="title">タイトル順</option>
                      <option value="added">追加が新しい順</option>
                      <option value="recent">最近開いた順</option>
                      <option value="custom">手動（ドラッグで並び替え）</option>
                    </select>
                  </div>
                  {allTags.length > 0 && (
                    <select
                      className="filter-select"
                      value={tagFilter}
                      onChange={(e) => setTagFilter(e.target.value)}
                      title="タグで絞り込み"
                    >
                      <option value="">タグ: すべて</option>
                      {allTags.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>
          )}

          {message && <div className="message">{message}</div>}

          {root && looseCount > 0 && (
            <div className="explorer-notice">
              <span>管理ルートに未取り込みのファイルが {looseCount} 件あります。</span>
              <button className="btn" onClick={() => void importLoose()}>
                取り込む…
              </button>
            </div>
          )}

          <div className="explorer-list">
            {!root && status === 'ready' && (
              <div className="explorer-empty">
                本を保存するフォルダ（管理ルート）を選んでください。
                <br />
                取り込んだ本は 1 冊ずつフォルダに分けて保存します。
              </div>
            )}
            {root && works.length === 0 && !busy && (
              <div className="explorer-empty">
                まだ本がありません。
                <br />
                上の ＋ から、またはウィンドウへ zip / cbz / pdf をドロップして取り込みます。
              </div>
            )}
            {root && works.length > 0 && visibleWorks.length === 0 && (
              <div className="explorer-empty">該当する本がありません。</div>
            )}
            {visibleWorks.map((w) => (
              <div
                key={w.id}
                className={`ex-row ${current?.id === w.id ? 'ex-row-active' : ''} ${
                  dropPos?.id === w.id ? (dropPos.after ? 'drop-after' : 'drop-before') : ''
                }`}
                draggable={sortKey === 'custom'}
                onDragStart={(e) => {
                  dragIdRef.current = w.id
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  if (sortKey !== 'custom' || !dragIdRef.current) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > r.top + r.height / 2
                  setDropPos((p) => (p?.id === w.id && p.after === after ? p : { id: w.id, after }))
                }}
                onDragLeave={() => setDropPos((p) => (p?.id === w.id ? null : p))}
                onDrop={(e) => {
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  handleRowDrop(w.id, e.clientY > r.top + r.height / 2)
                }}
                onDragEnd={() => {
                  dragIdRef.current = null
                  setDropPos(null)
                }}
              >
                <button className="ex-item" onClick={() => openWork(w)} title={w.title}>
                  <span className="ex-thumb">
                    {root && (
                      <img src={thumbnailUrl(root, w.id)} alt="" loading="lazy" draggable={false} />
                    )}
                  </span>
                  <span className="ex-body">
                    <span className="ex-title">{w.title}</span>
                    <span className="ex-meta">
                      {w.page_count}p
                      {w.last_page > 0 &&
                        ` ・ ${Math.round(((w.last_page + 1) / w.page_count) * 100)}%`}
                    </span>
                  </span>
                </button>
                <button
                  className={`ex-menu-btn ${menuFor === w.id ? 'is-open' : ''}`}
                  onClick={() => setMenuFor((v) => (v === w.id ? null : w.id))}
                  aria-label="メニュー"
                  title="メニュー"
                >
                  ⋮
                </button>
                {menuFor === w.id && (
                  <>
                    <div className="popup-backdrop" onClick={() => setMenuFor(null)} />
                    <div className="ex-popup" role="menu">
                      <button
                        className="ex-popup-item"
                        role="menuitem"
                        disabled={!llmStatus.running}
                        title={llmStatus.running ? undefined : 'モデル未読込のため実行できません'}
                        onClick={() => void structureWork(w)}
                      >
                        章立てと要約を作る
                      </button>
                      <button
                        className="ex-popup-item"
                        role="menuitem"
                        disabled={settings?.transcribeEngine === 'vlm' && !llmStatus.running}
                        title={
                          settings?.transcribeEngine === 'vlm' && !llmStatus.running
                            ? 'Vision LLM で文字起こしする設定です。モデルを読み込んでください'
                            : undefined
                        }
                        onClick={() => void transcribeWork(w)}
                      >
                        文字起こしする（未処理のページ）
                      </button>
                      <button
                        className="ex-popup-item"
                        role="menuitem"
                        onClick={() => {
                          setMenuFor(null)
                          setRenameTarget(w)
                          setRenameValue(w.title)
                        }}
                      >
                        名前を変更…
                      </button>
                      <div className="ex-popup-sep" />
                      <button
                        className="ex-popup-item ex-popup-danger"
                        role="menuitem"
                        onClick={() => void removeWork(w)}
                      >
                        削除
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* リサイズハンドル */}
        <div
          className="divider"
          onMouseDown={startDrag}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          role="separator"
          aria-orientation="vertical"
        />
        </>
        )}

        {/* ビューワ（右ペイン） */}
        <main className="viewer">
          {current && root && settings ? (
            <Reader
              key={current.id}
              root={root}
              work={current}
              settings={settings}
              onDirectionChange={handleDirectionChange}
              onProgress={handleProgress}
              onSpreadOffsetChange={handleSpreadOffsetChange}
              onWritingModeChange={handleWritingModeChange}
              allTags={allTags}
              onTagsChange={handleTagsChange}
              showInfo={readerShowInfo}
              onShowInfoChange={setReaderShowInfo}
              llmReady={llmStatus.running}
              showBookmarks={readerShowBookmarks}
              onShowBookmarksChange={setReaderShowBookmarks}
              showChat={readerShowChat}
              onShowChatChange={setReaderShowChat}
              onNotify={notify}
            />
          ) : (
            <div className="viewer-empty">
              {root ? '左の一覧から本を選択してください。' : 'まず管理ルートを選択してください。'}
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar">
        {queue && (queue.current || queue.pending.length > 0) && (
          <div className="statusbar-queue">
            {queue.current && (
              <>
                <span className="queue-spin" />
                <span className="sbq-title" title={queue.current.title}>
                  {queue.current.kind === 'transcribe'
                    ? '文字起こし: '
                    : queue.current.kind === 'structure'
                      ? '章立て・要約: '
                      : queue.current.kind === 'index'
                        ? '検索の索引: '
                        : ''}
                  {queue.current.title}
                </span>
                <span className="sbq-bar">
                  <span
                    className="sbq-bar-fill"
                    style={{
                      width:
                        queue.current.total > 0
                          ? `${Math.round((queue.current.current / queue.current.total) * 100)}%`
                          : '0%'
                    }}
                  />
                </span>
                <span className="queue-pct">
                  {queue.current.total > 0
                    ? `${Math.round((queue.current.current / queue.current.total) * 100)}%`
                    : '…'}
                </span>
                <span className="queue-elapsed">{fmtElapsed(currentElapsed)}</span>
                <button
                  className="queue-x"
                  onClick={() => cancelQueueItem(queue.current!.work_id)}
                  title="中止"
                >
                  ✕
                </button>
              </>
            )}
            {queue.pending.length > 0 && (
              <>
                <span className="sbq-pending">待機 {queue.pending.length} 件</span>
                <button className="queue-clear" onClick={clearAllJobs} title="待機中をすべて取消">
                  取消
                </button>
              </>
            )}
          </div>
        )}
        <span className="statusbar-spacer" />
        {showResources && <SystemResourceMonitor />}
        <button
          className={`statusbar-toggle ${showResources ? 'is-on' : ''}`}
          onClick={() => setShowResources((v) => !v)}
          title="システムリソースの表示"
          aria-label="システムリソースの表示"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
            aria-hidden="true"
          >
            <rect x="4" y="14" width="4" height="6" rx="1" />
            <rect x="10" y="10" width="4" height="10" rx="1" />
            <rect x="16" y="5" width="4" height="15" rx="1" />
          </svg>
        </button>
      </footer>

      {toast && <Toast toast={toast} onClose={closeToast} />}
    </div>
  )
}
