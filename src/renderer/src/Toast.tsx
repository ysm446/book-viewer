import { useEffect } from 'react'

/** 右下に一時表示する通知。保存先があればクリックでエクスプローラを開く。 */
export interface ToastState {
  /** 同じ文面を続けて出したときも再表示・タイマー再開させるための識別子。 */
  id: number
  message: string
  /** クリックで開く保存先。失敗通知など、開く先が無い場合は null。 */
  path: string | null
  error?: boolean
}

/** 自動で消えるまでの時間(ms)。 */
const DISMISS_MS = 5000

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i >= 0 ? path.slice(i + 1) : path
}

export function Toast({
  toast,
  onClose
}: {
  toast: ToastState
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const t = setTimeout(onClose, DISMISS_MS)
    return () => clearTimeout(t)
  }, [toast.id, onClose])

  const clickable = toast.path !== null

  return (
    <div className={`toast ${toast.error ? 'is-error' : ''}`} role="status">
      <button
        className="toast-body"
        onClick={() => toast.path && void window.api.showItemInFolder(toast.path)}
        disabled={!clickable}
        title={toast.path ?? undefined}
      >
        <span className="toast-msg">{toast.message}</span>
        {toast.path && (
          <>
            <span className="toast-file">{basename(toast.path)}</span>
            <span className="toast-hint">クリックで保存先を開く</span>
          </>
        )}
      </button>
      <button className="toast-x" onClick={onClose} aria-label="閉じる" title="閉じる">
        ✕
      </button>
    </div>
  )
}
