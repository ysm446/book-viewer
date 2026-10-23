import { useEffect, useState } from 'react'
import { saveTranslationStyles, type TranslationStyle } from './api'

/** 編集中の種類。key は画面の中だけの識別子(保存前の新しい種類には id が無い)。 */
interface Draft {
  key: string
  id?: string
  name: string
  instructions: string
  builtin: boolean
}

interface Props {
  root: string
  styles: TranslationStyle[]
  /** 開いたときに選んでおく種類 */
  initialId: string
  onClose: () => void
  onSaved: (styles: TranslationStyle[]) => void
}

const INSTRUCTIONS_PLACEHOLDER =
  '例:\n- 村上春樹の小説のような文体で訳す。一人称や語りのリズム、乾いたユーモアを生かし、平易な言葉で淡々と。\n- 原文の意味は変えない。会話は「」で囲む。'

let draftSeq = 0
function toDraft(s: TranslationStyle): Draft {
  return { key: s.id, id: s.id, name: s.name, instructions: s.instructions, builtin: s.builtin }
}

/**
 * 訳の種類(訳し方の指示)の作成・編集。組み込みの種類は読むだけで、複製して自分の種類を作れる。
 * 書けるのは「訳し方」だけで、文の対応・強調の記号・訳語表・見出しの決まりはアプリが加える。
 * 保存先は管理ルート(本の訳が種類の id で参照するため)。
 */
export function TranslationStylesDialog({ root, styles, initialId, onClose, onSaved }: Props): JSX.Element {
  const [drafts, setDrafts] = useState<Draft[]>(() => styles.map(toDraft))
  const [selected, setSelected] = useState(() =>
    styles.some((s) => s.id === initialId) ? initialId : (styles[0]?.id ?? '')
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const current = drafts.find((d) => d.key === selected) ?? null
  const customs = drafts.filter((d) => !d.builtin)

  function update(patch: Partial<Draft>): void {
    setDrafts((ds) => ds.map((d) => (d.key === selected ? { ...d, ...patch } : d)))
  }

  function add(from?: Draft): void {
    const key = `new-${++draftSeq}`
    const draft: Draft = {
      key,
      name: from ? `${from.name}（コピー）` : '新しい訳の種類',
      instructions: from ? from.instructions : '',
      builtin: false
    }
    setDrafts((ds) => [...ds, draft])
    setSelected(key)
  }

  function remove(): void {
    if (!current || current.builtin) return
    if (
      !window.confirm(
        `「${current.name}」を消します。この種類で訳した訳は本のフォルダに残りますが、表示できなくなります。よろしいですか？`
      )
    ) {
      return
    }
    setDrafts((ds) => ds.filter((d) => d.key !== selected))
    setSelected(drafts[0]?.key ?? '')
  }

  async function save(): Promise<void> {
    const bad = customs.find((d) => !d.name.trim() || !d.instructions.trim())
    if (bad) {
      setSelected(bad.key)
      setError('名前と訳し方の指示を入れてください')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await saveTranslationStyles(
        root,
        customs.map((d) => ({ id: d.id, name: d.name.trim(), instructions: d.instructions.trim() }))
      )
      onSaved(res.styles)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal styles-modal"
        role="dialog"
        aria-modal="true"
        aria-label="訳の種類"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rename-head">訳の種類</div>
        <div className="styles-main">
          <nav className="styles-list" aria-label="訳の種類の一覧">
            {drafts.map((d) => (
              <button
                key={d.key}
                className={`settings-nav-item ${d.key === selected ? 'settings-nav-active' : ''}`}
                onClick={() => setSelected(d.key)}
                title={d.name}
              >
                <span className="styles-list-name">{d.name || '（名前なし）'}</span>
                {d.builtin && <span className="styles-list-tag">組み込み</span>}
              </button>
            ))}
            <button className="btn styles-add" onClick={() => add()} disabled={busy}>
              ＋ 新しく作る
            </button>
          </nav>
          <div className="styles-editor">
            {!current ? (
              <div className="styles-note">左の一覧から種類を選んでください。</div>
            ) : current.builtin ? (
              <>
                <div className="styles-field-label">{current.name}（組み込み）</div>
                <textarea className="text-edit-area" value={current.instructions} readOnly aria-label="訳し方の指示" />
                <div className="styles-note">
                  組み込みの種類は変えられません。複製すると、この指示をもとに自分の種類を作れます。
                </div>
                <div>
                  <button className="btn" onClick={() => add(current)} disabled={busy}>
                    複製して編集
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="styles-field-label" htmlFor="style-name">
                  名前
                </label>
                <input
                  id="style-name"
                  className="import-input styles-name"
                  value={current.name}
                  maxLength={40}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => update({ name: e.target.value })}
                />
                <label className="styles-field-label" htmlFor="style-instructions">
                  訳し方の指示
                </label>
                <textarea
                  id="style-instructions"
                  className="text-edit-area"
                  value={current.instructions}
                  placeholder={INSTRUCTIONS_PLACEHOLDER}
                  maxLength={4000}
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) => update({ instructions: e.target.value })}
                />
                <div className="styles-note">
                  文体・語調・訳し方を書きます。原文と訳を 1 文ずつ対応させる決まり、強調の記号、人名などの訳語表、
                  見出しの訳し方はアプリが加えるので、書かなくてかまいません。指示を書き直すと、前の指示で訳した段落は
                  「訳し直す」から訳し直せます。
                </div>
                <div>
                  <button className="btn" onClick={remove} disabled={busy}>
                    この種類を消す
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {error && <div className="import-error">{error}</div>}
        <div className="import-footer">
          <span className="import-footer-spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
