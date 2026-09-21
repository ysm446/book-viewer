import { useEffect, useState } from 'react'
import {
  downloadLlamaBuild,
  listLatestLlamaReleases,
  listLlamaBuilds,
  listLlmModels,
  type InstalledBuild,
  type ReleaseBuild
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
  '以下の「本の情報」と「本文」(読者が読んだ範囲)を根拠に、日本語で簡潔に答えてください。' +
  '本文を根拠にするときは、どのページか(p.○)を添えてください。' +
  '本文に書かれていないことは、推測や一般的な知識であると断ったうえで述べ、断定しすぎないこと。' +
  '読者がまだ読んでいない先の内容(結末や種明かしなど)には触れないでください。'

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

type SettingsTab = 'display' | 'runtime' | 'ai' | 'chat'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'display', label: '表示' },
  { id: 'runtime', label: 'ランタイム' },
  { id: 'ai', label: '文字起こし' },
  { id: 'chat', label: 'チャット' }
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

            <p className="settings-note">設定は data/settings.json に保存されます。</p>
          </div>
        </div>
      </div>
    </div>
  )
}
