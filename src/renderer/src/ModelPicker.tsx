import { useEffect } from 'react'
import type { LlmModel } from './api'

interface ModelPickerProps {
  models: LlmModel[]
  /** 走査したモデルフォルダ。空一覧のときにどこを見たかを示す。 */
  modelsDir: string
  loadingName: string | null
  activeModel: string | null
  error: string | null
  onLoad: (model: LlmModel) => void
  onClose: () => void
}

/** ファイル名からパラメータ数バッジ(例: 31B)を取り出す。 */
function paramBadge(name: string): string | null {
  const m = name.match(/(\d+(?:\.\d+)?)b(?![a-z])/i)
  return m ? `${m[1]}B` : null
}

/** ファイル名から量子化バッジ(例: Q6_K)を取り出す。 */
function quantBadge(name: string): string | null {
  const m = name.match(/Q\d+(?:_[A-Z0-9]+)*/i)
  return m ? m[0].toUpperCase() : null
}

function sizeGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`
}

export function ModelPicker({
  models,
  modelsDir,
  loadingName,
  activeModel,
  error,
  onLoad,
  onClose
}: ModelPickerProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal model-picker" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="mp-head">
          <span className="mp-title">モデル</span>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        {error && <div className="mp-error">{error}</div>}

        <div className="mp-list">
          {models.length === 0 ? (
            <div className="mp-empty">
              GGUF モデルが見つかりません。
              {modelsDir && <span className="mp-empty-path">{modelsDir}</span>}
              設定 &gt; ランタイム でフォルダを指定できます。
            </div>
          ) : (
            models.map((m) => {
              const param = paramBadge(m.name)
              const quant = quantBadge(m.name)
              const isLoading = loadingName === m.name
              const isActive = activeModel === m.name
              return (
                <button
                  key={m.path}
                  className={`mp-item ${isActive ? 'mp-item-active' : ''}`}
                  onClick={() => onLoad(m)}
                  disabled={loadingName !== null}
                  title={m.path}
                >
                  <span className="mp-name">{m.name}</span>
                  <span className="mp-badges">
                    {isLoading && <span className="mp-loading">読み込み中…</span>}
                    {isActive && !isLoading && <span className="mp-badge mp-badge-active">使用中</span>}
                    {m.vision && <span className="mp-badge mp-badge-vision">Vision</span>}
                    {param && <span className="mp-badge">{param}</span>}
                    {quant && <span className="mp-badge mp-badge-quant">{quant}</span>}
                    <span className="mp-size">{sizeGb(m.size)}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
