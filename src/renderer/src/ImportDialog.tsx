import { useEffect, useState } from 'react'
import {
  importBooks,
  type ImportCandidate,
  type ImportResult,
  type ScanResult,
  type WritingMode
} from './api'

type Mode = 'copy' | 'move'

interface Row {
  candidate: ImportCandidate
  checked: boolean
  title: string
  author: string
  writingMode: WritingMode
}

interface Props {
  root: string
  candidates: ImportCandidate[]
  /** 元ファイルの扱いの初期値(ルート内の未取り込みは move、外部からは copy) */
  defaultMode: Mode
  onClose: () => void
  onDone: (results: ImportResult[], scan: ScanResult) => void
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 本の取り込みダイアログ。書名・著者・書字方向を確認してから本フォルダを作る。 */
export function ImportDialog({ root, candidates, defaultMode, onClose, onDone }: Props): JSX.Element {
  const [rows, setRows] = useState<Row[]>(() =>
    candidates.map((c) => ({
      candidate: c,
      // 読めないファイルと取り込み済みの重複は初期状態で外しておく。
      checked: !c.error && !c.duplicate,
      title: c.title,
      author: '',
      writingMode: 'horizontal'
    }))
  )
  const [mode, setMode] = useState<Mode>(defaultMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = rows.filter((r) => r.checked && !r.candidate.error)
  const canImport = !busy && selected.length > 0 && selected.every((r) => r.title.trim() !== '')

  // Escape で閉じる(開いた直後は何もフォーカスされていないので window で拾う。取り込み中は無視)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  function update(i: number, patch: Partial<Row>): void {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }

  async function run(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await importBooks(
        root,
        selected.map((r) => ({
          path: r.candidate.path,
          title: r.title.trim(),
          author: r.author.trim(),
          writing_mode: r.writingMode
        })),
        mode
      )
      onDone(res.results, res.scan)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal import-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rename-head">本を取り込む（{candidates.length} 件）</div>
        <div className="import-list">
          {rows.map((r, i) => (
            <div
              key={r.candidate.path}
              className={`import-row ${r.checked && !r.candidate.error ? '' : 'import-row-off'}`}
            >
              <input
                type="checkbox"
                checked={r.checked && !r.candidate.error}
                disabled={busy || !!r.candidate.error}
                onChange={(e) => update(i, { checked: e.target.checked })}
                aria-label={`${r.candidate.name} を取り込む`}
              />
              <div className="import-fields">
                <div className="import-file" title={r.candidate.path}>
                  {r.candidate.name}
                  {r.candidate.size > 0 && (
                    <span className="import-size">{fmtSize(r.candidate.size)}</span>
                  )}
                </div>
                {r.candidate.error ? (
                  <div className="import-warn">{r.candidate.error}</div>
                ) : (
                  <>
                    <div className="import-inputs">
                      <input
                        className="import-input"
                        value={r.title}
                        placeholder="書名"
                        spellCheck={false}
                        disabled={busy || !r.checked}
                        onChange={(e) => update(i, { title: e.target.value })}
                        aria-label="書名"
                      />
                      <input
                        className="import-input import-input-author"
                        value={r.author}
                        placeholder="著者（任意）"
                        spellCheck={false}
                        disabled={busy || !r.checked}
                        onChange={(e) => update(i, { author: e.target.value })}
                        aria-label="著者"
                      />
                      <div className="seg" role="group" aria-label="書字方向">
                        {(['horizontal', 'vertical'] as const).map((m) => (
                          <button
                            key={m}
                            className={`seg-btn ${r.writingMode === m ? 'seg-active' : ''}`}
                            disabled={busy || !r.checked}
                            onClick={() => update(i, { writingMode: m })}
                          >
                            {m === 'horizontal' ? '横書き' : '縦書き'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {r.candidate.duplicate && (
                      <div className="import-warn">同じ本が既に取り込まれています。</div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        {error && <div className="import-error">取り込みに失敗しました: {error}</div>}
        <div className="import-footer">
          <span className="import-mode-label">元のファイル</span>
          <div className="seg" role="group" aria-label="元のファイルの扱い">
            <button
              className={`seg-btn ${mode === 'copy' ? 'seg-active' : ''}`}
              disabled={busy}
              onClick={() => setMode('copy')}
            >
              コピーして残す
            </button>
            <button
              className={`seg-btn ${mode === 'move' ? 'seg-active' : ''}`}
              disabled={busy}
              onClick={() => setMode('move')}
            >
              移動する
            </button>
          </div>
          <span className="import-footer-spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={() => void run()} disabled={!canImport}>
            {busy ? '取り込み中…' : `取り込む（${selected.length} 件）`}
          </button>
        </div>
      </div>
    </div>
  )
}
