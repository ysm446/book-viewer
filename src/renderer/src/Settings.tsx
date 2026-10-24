import { useCallback, useEffect, useRef, useState } from 'react'
import {
  downloadLlamaBuild,
  fetchTtsRefAudio,
  getTtsStatus,
  installTts,
  listLatestLlamaReleases,
  listLlamaBuilds,
  listLlmModels,
  startTts,
  stopTts,
  ttsSpeak,
  type InstalledBuild,
  type ReleaseBuild,
  type TtsStatus
} from './api'
import type { AppSettings, AppSettingsPatch } from '../../preload'

function sizeMb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(0)} MB`
}

// コンテキスト長スライダーの刻み(4K〜256K を倍々で)。
const CTX_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

function ctxLabel(n: number): string {
  return `${Math.round(n / 1024)}K`
}

// 現在値に最も近い刻みのインデックスを返す。
function ctxIndex(n: number): number {
  let best = 0
  for (let i = 1; i < CTX_STEPS.length; i++) {
    if (Math.abs(CTX_STEPS[i] - n) < Math.abs(CTX_STEPS[best] - n)) best = i
  }
  return best
}

// main/settings.ts の DEFAULT_CHAT_SYSTEM_PROMPT と一致させること。
const DEFAULT_CHAT_SYSTEM_PROMPT =
  'あなたは、読者がいま読んでいる本について質問に答える読書アシスタントです。' +
  '以下の「本の情報」と「本文」をもとに、日本語で簡潔に答えてください。' +
  '本文を根拠にするときは、どのページか(p.○)を添えてください。'

// main/settings.ts の DEFAULT_TTS_CAPTION と一致させること。
const DEFAULT_TTS_CAPTION = '穏やかで落ち着いた女性の声。本を朗読するように、はっきりと読む'

/** 声の説明の試聴に読ませる文。 */
const TTS_SAMPLE = 'こんにちは。この声で本を読み上げます。今日は空が高く、風の心地よい一日になりそうです。'

function PlayIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  )
}

function StopIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}

function CloseIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function ResetIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

interface SettingsProps {
  settings: AppSettings
  onChange: (patch: AppSettingsPatch) => void
  onClose: () => void
}

type SettingsTab = 'display' | 'runtime' | 'ai' | 'chat' | 'speech'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'display', label: '表示' },
  { id: 'runtime', label: 'ランタイム' },
  { id: 'ai', label: '文字起こし' },
  { id: 'chat', label: 'チャット' },
  { id: 'speech', label: '読み上げ' }
]

export function Settings({ settings, onChange, onClose }: SettingsProps): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>('display')
  const [installed, setInstalled] = useState<InstalledBuild[]>([])
  const [autoDetected, setAutoDetected] = useState<string | null>(null)
  const [releaseTag, setReleaseTag] = useState('')
  const [releases, setReleases] = useState<ReleaseBuild[] | null>(null)
  const [buildBusy, setBuildBusy] = useState<'idle' | 'checking' | 'downloading'>('idle')
  const [downloadingName, setDownloadingName] = useState<string | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  // モデルフォルダの確認結果(入力したパスが正しいかをその場で示す)。
  const [modelsInfo, setModelsInfo] = useState<{
    dir: string
    exists: boolean
    count: number
  } | null>(null)

  async function refreshBuilds(): Promise<void> {
    try {
      const r = await listLlamaBuilds()
      setInstalled(r.installed)
      setAutoDetected(r.auto_detected)
    } catch {
      // 無視
    }
  }

  useEffect(() => {
    refreshBuilds()
  }, [])

  // モデルフォルダの入力に追従して走査結果を出す。手入力中の連打を避けて少し待つ。
  const modelsDir = settings.llm.modelsDir
  useEffect(() => {
    let alive = true
    const timer = setTimeout(async () => {
      try {
        const r = await listLlmModels(modelsDir)
        if (alive) setModelsInfo({ dir: r.models_dir, exists: r.exists, count: r.models.length })
      } catch {
        if (alive) setModelsInfo(null)
      }
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [modelsDir])

  // ---- 読み上げ(Irodori-TTS) ----
  const [tts, setTts] = useState<TtsStatus | null>(null)
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsError, setTtsError] = useState<string | null>(null)
  const ttsOpts = {
    serverDir: settings.tts.serverDir,
    modelsDir: settings.tts.modelsDir,
    baseUrl: settings.tts.baseUrl
  }
  const ttsKey = `${ttsOpts.serverDir}\n${ttsOpts.modelsDir}\n${ttsOpts.baseUrl}`
  // タブを開いている間、状態を追う(インストール・起動の進み具合を見せる)。
  useEffect(() => {
    if (tab !== 'speech') return
    let alive = true
    let timer = 0
    const tick = async (): Promise<void> => {
      try {
        const st = await getTtsStatus(ttsOpts)
        if (alive) setTts(st)
      } catch {
        // 一時的な失敗は次の周期で取り直す
      }
      if (alive) timer = window.setTimeout(() => void tick(), 2000)
    }
    timer = window.setTimeout(() => void tick(), 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ttsKey])

  async function ttsAction(run: () => Promise<TtsStatus>): Promise<void> {
    setTtsBusy(true)
    setTtsError(null)
    try {
      setTts(await run())
    } catch (e) {
      setTtsError((e as Error).message)
    } finally {
      setTtsBusy(false)
    }
  }

  const ttsInstalling = tts?.install?.phase === 'step'

  // ---- 声の試聴(参照音声の再生・声の説明で合成した見本) ----
  type Preview = { key: string; phase: 'loading' | 'playing' }
  const [preview, setPreview] = useState<Preview | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const previewGen = useRef(0)
  const stopPreview = useCallback((): void => {
    previewGen.current += 1
    const a = previewAudio.current
    previewAudio.current = null
    if (a) {
      a.pause()
      URL.revokeObjectURL(a.src)
    }
    setPreview(null)
  }, [])
  useEffect(() => () => stopPreview(), [stopPreview])
  useEffect(() => {
    if (tab !== 'speech') stopPreview()
  }, [tab, stopPreview])

  /** 音声(Blob)を取ってきて鳴らす。取り方は呼び出し側が渡す。 */
  async function playPreview(key: string, load: () => Promise<Blob>): Promise<void> {
    stopPreview()
    const gen = previewGen.current
    setPreview({ key, phase: 'loading' })
    setTtsError(null)
    try {
      const blob = await load()
      if (gen !== previewGen.current) return
      const a = new Audio(URL.createObjectURL(blob))
      previewAudio.current = a
      a.onended = () => {
        if (previewAudio.current === a) stopPreview()
      }
      a.onerror = () => {
        if (previewAudio.current === a) {
          stopPreview()
          setTtsError('音声を再生できません')
        }
      }
      await a.play()
      if (gen === previewGen.current) setPreview({ key, phase: 'playing' })
    } catch (e) {
      if (gen !== previewGen.current) return
      stopPreview()
      setTtsError((e as Error).message)
    }
  }

  /** サーバーを合成できる状態にする(止まっていれば起動してモデルの読み込みを待つ)。 */
  async function ensureTtsRunning(gen: number): Promise<void> {
    let st = await getTtsStatus(ttsOpts)
    if (!st.installed) {
      throw new Error('読み上げサーバー（Irodori-TTS-Server）が入っていません。先にインストールしてください')
    }
    if (!st.running && !st.starting) st = await startTts(ttsOpts)
    while (!st.running) {
      if (st.error) throw new Error(st.error)
      if (gen !== previewGen.current) throw new Error('中止しました')
      await new Promise((r) => setTimeout(r, 1000))
      st = await getTtsStatus(ttsOpts)
    }
    setTts(st)
  }

  /** 声の説明だけで作った声の見本を聞く(参照音声は使わない)。 */
  function previewCaption(): void {
    void playPreview('caption', async () => {
      await ensureTtsRunning(previewGen.current)
      return ttsSpeak(settings.tts.baseUrl, TTS_SAMPLE, {
        caption: settings.tts.caption,
        refWav: '',
        seed: settings.tts.seed
      })
    })
  }

  function previewRef(path: string): void {
    void playPreview(`ref:${path}`, () => fetchTtsRefAudio(path))
  }

  function previewButton(key: string, title: string, onPlay: () => void): JSX.Element {
    const active = preview?.key === key
    return (
      <button
        className={active ? 'icon-btn btn-active' : 'icon-btn'}
        title={active ? '停止' : title}
        aria-label={active ? '停止' : title}
        onClick={(e) => {
          e.stopPropagation()
          if (active) stopPreview()
          else onPlay()
        }}
      >
        {active && preview?.phase === 'loading' ? (
          <span className="icon-spin">⟳</span>
        ) : active ? (
          <StopIcon />
        ) : (
          <PlayIcon />
        )}
      </button>
    )
  }

  // ---- 参照音声のストック ----
  const refWavs = settings.tts.refWavs
  async function addRefWavs(): Promise<void> {
    const paths = await window.api.selectAudioFiles()
    if (paths.length === 0) return
    const known = new Set(refWavs.map((r) => r.path))
    const stamp = Date.now().toString(36)
    const added = paths
      .filter((p) => !known.has(p))
      .map((p, i) => ({ id: `ref-${stamp}-${i}`, name: p.split(/[\\/]/).pop() || p, path: p }))
    if (added.length === 0) return
    const next = [...refWavs, ...added]
    const hasSelected = next.some((r) => r.id === settings.tts.refWavId)
    onChange({
      tts: {
        refWavs: next,
        refWavId: hasSelected ? settings.tts.refWavId : added[0].id,
        // 最初の 1 本を入れたときは、そのまま使う
        ...(refWavs.length === 0 ? { refWavEnabled: true } : {})
      }
    })
  }
  function removeRefWav(id: string): void {
    const next = refWavs.filter((r) => r.id !== id)
    const selected = next.some((r) => r.id === settings.tts.refWavId) ? settings.tts.refWavId : (next[0]?.id ?? '')
    onChange({ tts: { refWavs: next, refWavId: selected, ...(next.length === 0 ? { refWavEnabled: false } : {}) } })
  }
  function renameRefWav(id: string, name: string): void {
    onChange({ tts: { refWavs: refWavs.map((r) => (r.id === id ? { ...r, name } : r)) } })
  }
  const ttsStateLabel = !tts
    ? '確認中…'
    : ttsInstalling
      ? 'インストール中…'
      : tts.running
        ? tts.external
          ? '稼働中（別のアプリが起動したサーバー）'
          : '稼働中'
        : tts.starting
          ? '起動中…（モデルの読み込み。初回はモデルの取得で数分かかります）'
          : tts.installed
            ? '停止中'
            : '未インストール'

  async function checkLatest(): Promise<void> {
    setBuildBusy('checking')
    setBuildError(null)
    try {
      const r = await listLatestLlamaReleases()
      setReleaseTag(r.tag)
      setReleases(r.builds)
    } catch (e) {
      setBuildError((e as Error).message)
    } finally {
      setBuildBusy('idle')
    }
  }

  async function download(build: ReleaseBuild): Promise<void> {
    setBuildBusy('downloading')
    setDownloadingName(build.name)
    setBuildError(null)
    try {
      const res = await downloadLlamaBuild(build)
      await refreshBuilds()
      // ダウンロードしたビルドを使用中にする。長時間の処理後なので settings の
      // スナップショットは古い可能性がある。serverPath のみ部分パッチで送る。
      onChange({ llm: { serverPath: res.server_path } })
    } catch (e) {
      setBuildError((e as Error).message)
    } finally {
      setBuildBusy('idle')
      setDownloadingName(null)
    }
  }

  // Escape で閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h2 className="settings-title">設定</h2>
          <button className="btn" onClick={onClose} aria-label="閉じる">
            閉じる
          </button>
        </div>

        <div className="settings-main">
          <nav className="settings-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`settings-nav-item ${tab === t.id ? 'settings-nav-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-body">
            {tab === 'display' && (
              <>
          <section className="settings-section">
            <h3 className="settings-section-title">表示</h3>

            <div className="settings-row">
              <div className="settings-label">
                テーマ
                <span className="settings-desc">アプリ全体の配色。テキスト表示の本文の背景は、本ごとに「表示」で変えられます</span>
              </div>
              <div className="seg">
                {(
                  [
                    ['dark', '黒'],
                    ['light', '白'],
                    ['sepia', 'セピア']
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={`seg-btn ${(settings.theme ?? 'dark') === id ? 'seg-active' : ''}`}
                    onClick={() => onChange({ theme: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                表示モード
                <span className="settings-desc">ページの表示単位</span>
              </div>
              <div className="seg">
                <button
                  className={`seg-btn ${settings.pageMode === 'single' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ pageMode: 'single' })}
                >
                  1ページ
                </button>
                <button
                  className={`seg-btn ${settings.pageMode === 'double' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ pageMode: 'double' })}
                >
                  2ページ（見開き）
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                横長ページは単独表示
                <span className="settings-desc">
                  見開き時、横が縦より長い画像（見開き絵など）は1ページで表示する
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.singleWhenLandscape}
                  disabled={settings.pageMode !== 'double'}
                  onChange={(e) => onChange({ singleWhenLandscape: e.target.checked })}
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                最初のページ（表紙）を単独表示
                <span className="settings-desc">
                  見開きのペアを1つずらす既定値。本ごとに「ずらす」で上書きできます
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.coverAlone}
                  disabled={settings.pageMode !== 'double'}
                  onChange={(e) => onChange({ coverAlone: e.target.checked })}
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                ページめくりエフェクト
                <span className="settings-desc">ページ送り時のアニメーション</span>
              </div>
              <div className="seg">
                <button
                  className={`seg-btn ${settings.pageTransition === 'none' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ pageTransition: 'none' })}
                >
                  なし
                </button>
                <button
                  className={`seg-btn ${settings.pageTransition === 'slide' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ pageTransition: 'slide' })}
                >
                  スライド
                </button>
                <button
                  className={`seg-btn ${settings.pageTransition === 'fade' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ pageTransition: 'fade' })}
                >
                  フェード
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">読み進め方向</h3>

            <div className="settings-row">
              <div className="settings-label">
                既定の方向
                <span className="settings-desc">
                  本ごとに上書きできます（本を開いたときのバーから変更）
                </span>
              </div>
              <div className="seg">
                <button
                  className={`seg-btn ${settings.defaultDirection === 'rtl' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ defaultDirection: 'rtl' })}
                >
                  右 → 左（縦書きの本・漫画）
                </button>
                <button
                  className={`seg-btn ${settings.defaultDirection === 'ltr' ? 'seg-active' : ''}`}
                  onClick={() => onChange({ defaultDirection: 'ltr' })}
                >
                  左 → 右
                </button>
              </div>
            </div>
          </section>
              </>
            )}

            {tab === 'runtime' && (
              <>
          <section className="settings-section">
            <h3 className="settings-section-title">ランタイム（llama.cpp）</h3>

            <div className="settings-row settings-row-col">
              <div className="settings-label">
                llama.cpp ビルド
                <span className="settings-desc">
                  実行ファイルを選択、または最新版をダウンロード（gemma-4 対応には新しいビルドが必要）
                </span>
              </div>
              <div className="builds">
                <label className="build-item">
                  <input
                    type="radio"
                    name="active-build"
                    checked={settings.llm.serverPath === ''}
                    onChange={() => onChange({ llm: { ...settings.llm, serverPath: '' } })}
                  />
                  <span className="build-name">
                    自動検出
                    {autoDetected && (
                      <span className="build-auto"> → {autoDetected.split(/[\\/]/).slice(-2, -1)}</span>
                    )}
                  </span>
                </label>
                {installed.map((b) => (
                  <label key={b.server_path} className="build-item">
                    <input
                      type="radio"
                      name="active-build"
                      checked={settings.llm.serverPath === b.server_path}
                      onChange={() => onChange({ llm: { ...settings.llm, serverPath: b.server_path } })}
                    />
                    <span className="build-name">{b.name}</span>
                  </label>
                ))}

                <div className="build-actions">
                  <button className="btn" onClick={checkLatest} disabled={buildBusy !== 'idle'}>
                    {buildBusy === 'checking' ? '確認中…' : '最新を確認'}
                  </button>
                  {releaseTag && <span className="settings-desc">最新: {releaseTag}</span>}
                </div>

                {buildError && <div className="reader-info-error">{buildError}</div>}

                {releases && (
                  <div className="release-list">
                    {releases.map((r) => (
                      <div key={r.name} className="release-item">
                        <span className="release-label">{r.label}</span>
                        <span className="release-size">{sizeMb(r.size)}</span>
                        <button
                          className="btn"
                          onClick={() => download(r)}
                          disabled={buildBusy !== 'idle'}
                        >
                          {downloadingName === r.name ? 'ダウンロード中…' : '取得'}
                        </button>
                      </div>
                    ))}
                    <span className="settings-desc">
                      CUDA は対応する cudart も自動取得します。GPUなしは CPU か Vulkan を選んでください。
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                llama-server のパス（手動）
                <span className="settings-desc">
                  空なら vendor/llama_cpp から自動検出
                </span>
              </div>
              <div className="settings-llm-url">
                <input
                  className="tag-input settings-text"
                  placeholder="(自動検出)"
                  value={settings.llm.serverPath}
                  onChange={(e) =>
                    onChange({ llm: { ...settings.llm, serverPath: e.target.value } })
                  }
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const f = await window.api.selectFile()
                    if (f) onChange({ llm: { serverPath: f } })
                  }}
                >
                  参照
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                コンテキスト長
                <span className="settings-desc">既定 4K・大きいほど VRAM を消費</span>
              </div>
              <div className="settings-slider">
                <input
                  type="range"
                  min={0}
                  max={CTX_STEPS.length - 1}
                  step={1}
                  value={ctxIndex(settings.llm.ctxSize)}
                  onChange={(e) =>
                    onChange({
                      llm: { ...settings.llm, ctxSize: CTX_STEPS[Number(e.target.value)] }
                    })
                  }
                />
                <span className="settings-slider-value">{ctxLabel(settings.llm.ctxSize)}</span>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                モデルフォルダ（GGUF）
                <span className="settings-desc">
                  GGUF を探す場所。サブフォルダも再帰的に見ます。空ならアプリ同梱の models/
                </span>
              </div>
              <div className="settings-llm-url">
                <input
                  className="tag-input settings-text"
                  placeholder="(既定: models/)"
                  value={settings.llm.modelsDir}
                  onChange={(e) => onChange({ llm: { ...settings.llm, modelsDir: e.target.value } })}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const d = await window.api.selectFolder()
                    if (d) onChange({ llm: { modelsDir: d } })
                  }}
                >
                  参照
                </button>
                {settings.llm.modelsDir !== '' && (
                  <button
                    className="icon-btn"
                    title="既定（models/）に戻す"
                    onClick={() => onChange({ llm: { ...settings.llm, modelsDir: '' } })}
                  >
                    <ResetIcon />
                  </button>
                )}
              </div>
            </div>

            {modelsInfo && (
              <div className="settings-row settings-row-col">
                {modelsInfo.exists ? (
                  <span className="settings-desc">
                    {modelsInfo.dir} — GGUF {modelsInfo.count} 件
                  </span>
                ) : (
                  <span className="reader-info-error">
                    フォルダが見つかりません: {modelsInfo.dir}
                  </span>
                )}
              </div>
            )}

            <div className="settings-row">
              <div className="settings-label">
                思考モード（reasoning）
                <span className="settings-desc">
                  対応モデルが回答前に推論する。品質↑だが生成は遅くなる。チャットでは思考過程を折りたたみ表示
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.llm.thinkingEnabled}
                  onChange={(e) =>
                    onChange({ llm: { ...settings.llm, thinkingEnabled: e.target.checked } })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>
          </section>
              </>
            )}

            {tab === 'ai' && (
              <>
          <section className="settings-section">
            <h3 className="settings-section-title">文字起こし</h3>
            <div className="settings-row">
              <div className="settings-label">
                エンジン
                <span className="settings-desc">
                  YomiToku（既定）は日本語の文書 OCR。字の読み違いが少なく速く、図も切り抜きます。
                  Vision LLM は読み込み済みのモデルに書き起こさせます（遅く、言い換えが混ざることがあります）
                </span>
              </div>
              <div className="seg" role="group" aria-label="文字起こしのエンジン">
                {(
                  [
                    ['yomitoku', 'YomiToku'],
                    ['vlm', 'Vision LLM']
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={`seg-btn ${(settings.transcribeEngine ?? 'yomitoku') === id ? 'seg-active' : ''}`}
                    onClick={() => onChange({ transcribeEngine: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>
              </>
            )}

            {tab === 'chat' && (
              <>
          <section className="settings-section">
            <h3 className="settings-section-title">本のチャット</h3>

            <div className="settings-row settings-row-col">
              <div className="syslabel-row">
                <span className="settings-label-text">システムプロンプト</span>
                <button
                  className="icon-btn syslabel-reset"
                  title="既定に戻す"
                  onClick={() =>
                    onChange({ llm: { ...settings.llm, chatSystemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT } })
                  }
                >
                  <ResetIcon />
                </button>
              </div>
              <span className="settings-desc">
                チャットの基本人格。本の情報・読み終えた章の要約・本文はこの後に自動で添えられます
              </span>
              <textarea
                className="system-prompt"
                rows={5}
                value={settings.llm.chatSystemPrompt}
                onChange={(e) =>
                  onChange({ llm: { ...settings.llm, chatSystemPrompt: e.target.value } })
                }
              />
            </div>

            <div className="settings-row">
              <div className="settings-label">
                本文に無いことも一般知識で補う
                <span className="settings-desc">
                  本文に書かれていないときも、そう断ったうえで一般的な知識や推測で答えます。
                  OFF なら本文に書かれていることだけで答えます(どちらも、まだ読んでいない先の展開には触れません)
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.llm.chatGeneralKnowledge}
                  onChange={(e) =>
                    onChange({ llm: { ...settings.llm, chatGeneralKnowledge: e.target.checked } })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                内容から質問候補を作る
                <span className="settings-desc">
                  会話の下に並ぶ候補に、いまの本・ページ・直近の会話に合った質問を混ぜる。
                  モデル未起動・生成失敗のときは定番の候補だけになります
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.llm.chatDynamicSuggestions}
                  onChange={(e) =>
                    onChange({ llm: { ...settings.llm, chatDynamicSuggestions: e.target.checked } })
                  }
                />
                <span className="switch-track" />
              </label>
            </div>
          </section>
              </>
            )}

            {tab === 'speech' && (
              <>
          <section className="settings-section">
            <h3 className="settings-section-title">読み上げ（Irodori-TTS）</h3>
            <span className="settings-desc">
              テキスト表示の本文を、ローカルの音声モデル Irodori-TTS（Aratako、MIT。日本語専用）で読み上げます。
              公式の OpenAI 互換サーバー Irodori-TTS-Server を別の Python 環境（uv）に入れ、読み上げのときに起動します。
              英語の本は訳文（日本語）を読みます
            </span>

            <div className="settings-row">
              <div className="settings-label">
                サーバー
                <span className="settings-desc">
                  {ttsStateLabel}
                  {tts?.running && tts.checkpoint ? ` ・ ${tts.checkpoint}` : ''}
                </span>
                {tts?.install && (
                  <span className={tts.install.phase === 'error' ? 'reader-info-error' : 'settings-desc'}>
                    {tts.install.error ?? tts.install.label}
                  </span>
                )}
                {ttsInstalling && tts?.install && tts.install.lines.length > 0 && (
                  <pre className="tts-log">{tts.install.lines.join('\n')}</pre>
                )}
                {(ttsError || tts?.error) && (
                  <span className="reader-info-error">{ttsError ?? tts?.error}</span>
                )}
              </div>
              <div className="settings-llm-url">
                {tts && !tts.installed && (
                  <button
                    className="btn btn-primary"
                    disabled={ttsBusy || ttsInstalling}
                    onClick={() => void ttsAction(() => installTts(ttsOpts))}
                    title="Irodori-TTS-Server を git clone し、uv で依存（torch を含む。約 5 GB）を入れます。数分かかります"
                  >
                    インストール
                  </button>
                )}
                {tts?.installed && !tts.running && !tts.starting && (
                  <button
                    className="btn"
                    disabled={ttsBusy || ttsInstalling}
                    onClick={() => void ttsAction(() => startTts(ttsOpts))}
                    title="読み上げサーバーを起動してモデルを読み込みます（読み上げボタンからも自動で起動します）"
                  >
                    起動
                  </button>
                )}
                {tts && (tts.starting || (tts.running && !tts.external)) && (
                  <button
                    className="btn"
                    disabled={ttsBusy}
                    onClick={() => void ttsAction(stopTts)}
                    title="読み上げサーバーを止めて VRAM を空けます"
                  >
                    停止
                  </button>
                )}
                {tts?.installed && !tts.running && !tts.starting && (
                  <button
                    className="btn"
                    disabled={ttsBusy || ttsInstalling}
                    onClick={() => {
                      if (window.confirm('Irodori-TTS-Server を削除して入れ直します（数分かかります）。よろしいですか？')) {
                        void ttsAction(() => installTts(ttsOpts))
                      }
                    }}
                    title="サーバーを削除して最新を入れ直します"
                  >
                    入れ直す…
                  </button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                サーバーのフォルダ
                <span className="settings-desc">
                  Irodori-TTS-Server を置く（置いてある）フォルダ。空なら vendor/irodori-tts-server。
                  ほかのアプリで入れたフォルダを指すと、入れ直さずに使えます
                </span>
              </div>
              <div className="settings-llm-url">
                <input
                  className="tag-input settings-text"
                  placeholder={tts ? `(既定: ${tts.server_dir_default})` : '(既定: vendor/irodori-tts-server)'}
                  value={settings.tts.serverDir}
                  onChange={(e) => onChange({ tts: { serverDir: e.target.value } })}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const d = await window.api.selectFolder()
                    if (d) onChange({ tts: { serverDir: d } })
                  }}
                >
                  参照
                </button>
                {settings.tts.serverDir !== '' && (
                  <button
                    className="icon-btn"
                    title="既定（vendor/irodori-tts-server）に戻す"
                    onClick={() => onChange({ tts: { serverDir: '' } })}
                  >
                    <ResetIcon />
                  </button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                モデルの置き場
                <span className="settings-desc">
                  音声モデル（約 3.4 GB。初回の起動で Hugging Face から取得）を、この下の hf-cache に置きます。
                  空なら D:\ai-models\tts があればそれ、無ければ Hugging Face の既定のキャッシュ
                </span>
              </div>
              <div className="settings-llm-url">
                <input
                  className="tag-input settings-text"
                  placeholder={tts?.models_dir ? `(既定: ${tts.models_dir})` : '(既定: Hugging Face のキャッシュ)'}
                  value={settings.tts.modelsDir}
                  onChange={(e) => onChange({ tts: { modelsDir: e.target.value } })}
                />
                <button
                  className="btn"
                  onClick={async () => {
                    const d = await window.api.selectFolder()
                    if (d) onChange({ tts: { modelsDir: d } })
                  }}
                >
                  参照
                </button>
                {settings.tts.modelsDir !== '' && (
                  <button
                    className="icon-btn"
                    title="既定に戻す"
                    onClick={() => onChange({ tts: { modelsDir: '' } })}
                  >
                    <ResetIcon />
                  </button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                サーバーの URL
                <span className="settings-desc">
                  この URL が応答していれば（別のアプリが起動していれば）起動せずにそれを使います
                </span>
              </div>
              <input
                className="tag-input settings-text"
                placeholder="http://127.0.0.1:8088"
                value={settings.tts.baseUrl}
                onChange={(e) => onChange({ tts: { baseUrl: e.target.value } })}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">声</h3>

            <div className="settings-row settings-row-col">
              <div className="syslabel-row">
                <span className="settings-label-text">声の説明</span>
                {previewButton(
                  'caption',
                  'この説明だけで作った声の見本を聞く（参照音声は使いません。サーバーが止まっていれば起動します）',
                  previewCaption
                )}
                <button
                  className="icon-btn syslabel-reset"
                  title="既定に戻す"
                  onClick={() => onChange({ tts: { caption: DEFAULT_TTS_CAPTION } })}
                >
                  <ResetIcon />
                </button>
              </div>
              <span className="settings-desc">
                声の性別・年齢・話し方を日本語で書くと、その声で読みます（参照音声を使わないときの声づくり）。
                変えると、同じ本文でも音声を作り直します。▶ で見本の文を合成して聞けます
              </span>
              <textarea
                className="system-prompt"
                rows={2}
                value={settings.tts.caption}
                onChange={(e) => onChange({ tts: { caption: e.target.value } })}
              />
            </div>

            <div className="settings-row">
              <div className="settings-label">
                参照音声を使う
                <span className="settings-desc">
                  真似させたい声の wav（きれいな発話を合わせて 30 秒ほど。最大 120 秒）で声を作ります。
                  OFF なら上の説明だけで声を作ります
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.tts.refWavEnabled}
                  disabled={refWavs.length === 0}
                  onChange={(e) => onChange({ tts: { refWavEnabled: e.target.checked } })}
                />
                <span className="switch-track" />
              </label>
            </div>

            <div className="settings-row settings-row-col">
              <span className="settings-label-text">参照音声のストック</span>
              <span className="settings-desc">
                いくつか入れておき、使うものを選びます。▶ でその音声を聞けます。名前は書き換えられます
              </span>
              {refWavs.length > 0 && (
                <div
                  className={settings.tts.refWavEnabled ? 'tts-ref-list' : 'tts-ref-list is-off'}
                  role="radiogroup"
                  aria-label="参照音声"
                >
                  {refWavs.map((r) => {
                    const selected = r.id === settings.tts.refWavId
                    return (
                      <div
                        key={r.id}
                        className={selected ? 'tts-ref-row is-selected' : 'tts-ref-row'}
                        role="radio"
                        aria-checked={selected}
                        tabIndex={0}
                        title={r.path}
                        onClick={() => onChange({ tts: { refWavId: r.id } })}
                        onKeyDown={(e) => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault()
                            onChange({ tts: { refWavId: r.id } })
                          }
                        }}
                      >
                        <span className="tts-ref-mark" aria-hidden="true" />
                        <div className="tts-ref-text">
                          <input
                            className="tts-ref-name"
                            value={r.name}
                            aria-label="参照音声の名前"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            onChange={(e) => renameRefWav(r.id, e.target.value)}
                          />
                          <span className="tts-ref-path">{r.path}</span>
                        </div>
                        {previewButton(`ref:${r.path}`, 'この音声を聞く', () => previewRef(r.path))}
                        <button
                          className="icon-btn"
                          title="ストックから外す"
                          aria-label="ストックから外す"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (preview?.key === `ref:${r.path}`) stopPreview()
                            removeRefWav(r.id)
                          }}
                        >
                          <CloseIcon />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              <div>
                <button className="btn" onClick={() => void addRefWavs()}>
                  追加…
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                seed
                <span className="settings-desc">
                  合成の乱数の種。決めておくと声や読み方が本文ごとにぶれにくくなります。空なら毎回変わります
                </span>
              </div>
              <input
                className="tag-input settings-text tts-seed"
                type="number"
                min={0}
                step={1}
                placeholder="(毎回変わる)"
                value={settings.tts.seed ?? ''}
                onChange={(e) =>
                  onChange({ tts: { seed: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) } })
                }
              />
            </div>
          </section>
              </>
            )}

            <p className="settings-note">設定は data/settings.json に保存されます。</p>
          </div>
        </div>
      </div>
    </div>
  )
}
