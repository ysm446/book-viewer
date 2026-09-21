import { useEffect, useRef, useState } from 'react'
import {
  chatAboutWorkStream,
  enqueueIndex,
  getQueue,
  getIndexStatus,
  suggestChatQuestions,
  type ChatTurn,
  type IndexStatus,
  type Work
} from './api'
import { Markdown } from './Markdown'

interface ReaderChatProps {
  root: string
  work: Work
  /** 現在開いているページ(見開きなら後ろ側)。ここまでの本文を文脈に使い、画像添付にも使う。 */
  currentPage: number
  /** 本文を渡す上限(文字数)。コンテキスト長の設定から決める。 */
  contextChars: number
  /** 埋め込み用の llama-server を起動するための設定(本文検索に使う) */
  serverPath: string
  modelsDir: string
  /** 思考(reasoning)モード。設定から渡す。 */
  think: boolean
  /** チャットのシステムプロンプト(設定から差し替え可能)。 */
  systemPrompt: string
  /** 候補チップに、内容から作った質問を混ぜるか(設定から渡す)。 */
  dynamicSuggestions: boolean
  /** サイドバー幅(px)。ドラッグリサイズ用に親から渡す。 */
  width?: number
  onClose: () => void
}

// いつでも使える定番の質問。候補チップは会話と一緒にスクロールするので、
// 固定枠だった頃より多めに持っておき ⟳ で送っていく。
const TEMPLATES = [
  'このページの要点は？',
  'ここまでの内容を要約して',
  '難しいところをかみくだいて',
  '出てきた用語を整理して',
  'ここまでの流れを3行で',
  '具体例を挙げて説明して',
  '前の内容とのつながりは？',
  '大事なポイントを箇条書きで'
]
const TEMPLATE_WINDOW = 4 // 同時に見せる候補の件数
const MAX_DYNAMIC = 2 // うち、内容から作られた質問に使う枠

/** 本について会話するサイドチャット。履歴はセッションのみ(本を切り替えると消える)。 */
export function ReaderChat({
  root,
  work,
  currentPage,
  contextChars,
  serverPath,
  modelsDir,
  think,
  systemPrompt,
  dynamicSuggestions,
  width,
  onClose
}: ReaderChatProps): JSX.Element {
  const [messages, setMessages] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [includeImage, setIncludeImage] = useState(false)
  const [pageFocus, setPageFocus] = useState(false)
  // 本文検索(索引があるときだけ使える)
  const [useSearch, setUseSearch] = useState(true)
  const [index, setIndex] = useState<IndexStatus | null>(null)
  const [indexJob, setIndexJob] = useState<{ current: number; total: number } | null>(null)
  // 内容から作られた質問。取れなければ空のまま(固定の候補だけになる)。
  const [dynamicQuestions, setDynamicQuestions] = useState<string[]>([])
  // 固定の候補は窓を切って出し、⟳ で次の並びへ送る(ランダムではなく決まった順)。
  const [templateOffset, setTemplateOffset] = useState(0)
  const logRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // ストリーミング中の fetch を中断するためのコントローラ。
  const abortRef = useRef<AbortController | null>(null)
  // 候補生成の中断用。本を切り替えたら古い応答は捨てる。
  const suggestAbortRef = useRef<AbortController | null>(null)
  // ログが末尾付近にあるときだけ自動スクロールする(過去ログ閲覧中は引き戻さない)。
  const stickToBottomRef = useRef(true)

  // 入力の行数に合わせて高さを自動調整する(上限は CSS の max-height)。
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [input])

  const dynamicShown = dynamicSuggestions ? dynamicQuestions.slice(0, MAX_DYNAMIC) : []
  // 残りの枠を固定の候補で埋める(固定が上、生成された質問が下=入力欄側)。
  const chips = [
    ...Array.from({ length: Math.max(TEMPLATE_WINDOW - dynamicShown.length, 0) }, (_, i) => ({
      text: TEMPLATES[(templateOffset + i) % TEMPLATES.length],
      dynamic: false
    })),
    ...dynamicShown.map((text) => ({ text, dynamic: true }))
  ]
  const chipsKey = chips.map((c) => c.text).join('\n')

  /** 状況に合った質問候補を取り直す。設定オフ・モデル未起動・失敗はすべて
   *  黙って諦める(候補は無くても会話はできる)。 */
  async function refreshSuggestions(history: ChatTurn[]): Promise<void> {
    if (!dynamicSuggestions) return
    suggestAbortRef.current?.abort()
    const controller = new AbortController()
    suggestAbortRef.current = controller
    try {
      const questions = await suggestChatQuestions(
        root,
        work.id,
        history,
        { currentPage },
        controller.signal
      )
      if (!controller.signal.aborted && questions.length > 0) setDynamicQuestions(questions)
    } catch {
      /* 候補は付加機能なので、失敗しても何も出さない */
    }
  }

  // パネルを閉じる・本を切り替える(アンマウント)時は生成を打ち切る。
  // 放置するとバックエンドの LLM スロットを塞ぎ続ける。
  useEffect(
    () => () => {
      abortRef.current?.abort()
      suggestAbortRef.current?.abort()
    },
    []
  )

  // 本が変わったら会話をリセットし(履歴はセッションのみ)、候補を取り直す。
  useEffect(() => {
    setMessages([])
    setError(null)
    setInput('')
    setDynamicQuestions([])
    setTemplateOffset(0)
    void refreshSuggestions([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.id, dynamicSuggestions])

  // 新しい発言が来たら末尾までスクロールする(末尾付近にいるときのみ)。
  // 候補チップも会話の末尾にあるので、差し替わったときも下端へ寄せる。
  useEffect(() => {
    const el = logRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, busy, chipsKey])

  // 索引の状態を今すぐ取り直す(作成開始の直後に使う)。
  const refreshIndexRef = useRef<() => void>(() => {})
  // 本文検索の索引の状態を取る。作成中なら進み具合を追い、終わったら取り直す。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = async (): Promise<void> => {
      try {
        const [st, q] = await Promise.all([
          getIndexStatus(root, work.id, modelsDir),
          getQueue()
        ])
        if (!alive) return
        setIndex(st)
        const cur = q.current?.work_id === work.id && q.current.kind === 'index' ? q.current : null
        const pending = q.pending.some((j) => j.work_id === work.id && j.kind === 'index')
        setIndexJob(cur ? { current: cur.current, total: cur.total } : pending ? { current: 0, total: 0 } : null)
        if (cur || pending) timer = setTimeout(() => void refresh(), 1500)
      } catch {
        /* 索引は付加機能なので、取れなくても会話はできる */
      }
    }
    void refresh()
    refreshIndexRef.current = () => {
      if (timer) clearTimeout(timer)
      void refresh()
    }
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [root, work.id, modelsDir])

  async function buildIndex(): Promise<void> {
    try {
      await enqueueIndex(root, work.id, serverPath, modelsDir)
      setIndexJob({ current: 0, total: 0 })
      refreshIndexRef.current()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const searchReady = !!index && index.chunks > 0

  function clearChat(): void {
    if (busy) return
    setMessages([])
    setError(null)
    setInput('')
    void refreshSuggestions([])
  }

  async function send(text: string): Promise<void> {
    const q = text.trim()
    if (!q || busy) return
    const base: ChatTurn[] = [...messages, { role: 'user', content: q }]
    // 応答用のプレースホルダを1つ足し、ストリームで埋めていく。
    setMessages([...base, { role: 'assistant', content: '', reasoning: '' }])
    setInput('')
    setBusy(true)
    setError(null)
    let content = ''
    let reasoning = ''
    const apply = (): void =>
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', content, reasoning }
        return copy
      })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await chatAboutWorkStream(
        root,
        work.id,
        base,
        {
          currentPage,
          includeImage,
          pageFocus,
          systemPrompt,
          think,
          contextChars,
          search: useSearch && searchReady ? { serverPath, modelsDir } : undefined
        },
        {
          onReasoning: (t) => {
            reasoning += t
            apply()
          },
          onContent: (t) => {
            content += t
            apply()
          }
        },
        controller.signal
      )
    } catch (e) {
      // 自分で中断した場合はエラー扱いにしない。
      if ((e as Error).name === 'AbortError') return
      setError((e as Error).message)
      // 応答が空のままならプレースホルダを取り除く。
      setMessages((m) =>
        m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content
          ? m.slice(0, -1)
          : m
      )
    } finally {
      setBusy(false)
      // 会話を踏まえたフォローアップ質問へ差し替える(中断・失敗時はそのまま)。
      if (content) void refreshSuggestions([...base, { role: 'assistant', content }])
    }
  }

  return (
    <div className="reader-chat" style={width !== undefined ? { flexBasis: width } : undefined}>
      <div className="reader-chat-head">
        <span className="reader-chat-title">✦ この本について質問</span>
        <button
          className="btn reader-chat-clear"
          onClick={clearChat}
          disabled={busy || messages.length === 0}
          title="会話をクリア"
        >
          クリア
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="閉じる">
          ×
        </button>
      </div>

      <div
        className="reader-chat-log"
        ref={logRef}
        onScroll={() => {
          const el = logRef.current
          if (el) {
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }
        }}
      >
        {messages.length === 0 && (
          <div className="reader-chat-intro">
            この本について質問にお答えします。いま開いているページまでの本文をもとに答えます（先のページは読みません）。下の候補から選ぶか、質問を入力してください。
          </div>
        )}
        {messages.map((m, i) => {
          const streaming = busy && i === messages.length - 1 && m.role === 'assistant'
          return (
            <div key={i} className={`chat-msg chat-${m.role}`}>
              {m.role === 'assistant' && m.reasoning && (
                <details className="chat-reasoning" open={streaming && !m.content}>
                  <summary>思考{streaming && !m.content ? '中…' : 'を表示'}</summary>
                  <div className="chat-reasoning-body">{m.reasoning}</div>
                </details>
              )}
              {m.content ? (
                // 応答は吹き出しにせず Markdown で描画(ストリーミング中も毎チャンク再パース)
                m.role === 'assistant' ? (
                  <Markdown text={m.content} />
                ) : (
                  m.content
                )
              ) : (
                streaming && <span className="chat-typing">考え中…</span>
              )}
            </div>
          )
        })}
        {error && <div className="reader-info-error">{error}</div>}

        {/* 候補チップは会話の一番下に置いて一緒にスクロールさせる(クリックで即送信)。
            固定枠にすると、その高さぶん会話エリアが常に狭くなるため中に入れている。 */}
        <div className="reader-chat-templates">
          {chips.map((c) => (
            <button
              key={`${c.dynamic ? 'dyn' : 'fix'}:${c.text}`}
              className={`chat-chip${c.dynamic ? ' chat-chip-dynamic' : ''}`}
              onClick={() => void send(c.text)}
              disabled={busy}
              title={c.dynamic ? `${c.text}(いまの内容から作られた質問)` : c.text}
            >
              {c.dynamic && <span className="chat-chip-mark">✦</span>}
              {c.text}
            </button>
          ))}
          {/* 候補の入れ替え。チップの並びの延長なので、入力欄ではなくここに置く。 */}
          <button
            className="chat-chip-more"
            onClick={() => setTemplateOffset((v) => (v + TEMPLATE_WINDOW) % TEMPLATES.length)}
            title="ほかの候補を見る"
          >
            ⟳ ほかの候補
          </button>
        </div>
      </div>

      <div className="reader-chat-opts">
        <label className="chat-opt" title="ここまでの流れを踏まえつつ、現在ページの内容を中心に答えます">
          <input
            type="checkbox"
            checked={pageFocus}
            onChange={(e) => setPageFocus(e.target.checked)}
          />
          このページについて
        </label>
        <label className="chat-opt" title="現在ページの画像も一緒に送る">
          <input
            type="checkbox"
            checked={includeImage}
            onChange={(e) => setIncludeImage(e.target.checked)}
          />
          画像
        </label>
        {searchReady && !indexJob && (
          <label
            className="chat-opt"
            title={`読んだ範囲の本文から、質問に関係しそうな箇所を探して答えに使います（${index?.chunks} 件）`}
          >
            <input
              type="checkbox"
              checked={useSearch}
              onChange={(e) => setUseSearch(e.target.checked)}
            />
            本文を検索
          </label>
        )}
      </div>
      {index && (indexJob || !searchReady || index.stale) && (
        <div className="chat-index">
          {indexJob ? (
            <span>
              本文検索の索引を作成中
              {indexJob.total > 0 ? ` ${indexJob.current}/${indexJob.total}` : '（順番待ち）'}
            </span>
          ) : !index.embedding_model ? (
            <span>本文検索には埋め込みモデル（例: Qwen3-Embedding）をモデル置き場に置いてください</span>
          ) : (
            <>
              <span>
                {index.stale
                  ? '本文が変わりました。本文検索の索引を作り直すと反映されます'
                  : '本文検索の索引を作ると、遠いページの内容も答えに使えます'}
              </span>
              <button
                className="btn chat-index-btn"
                onClick={() => void buildIndex()}
                title={`埋め込みモデル ${index.embedding_model} で索引を作ります`}
              >
                {index.stale ? '作り直す' : '索引を作る'}
              </button>
            </>
          )}
        </div>
      )}

      <div className="reader-chat-input">
        <textarea
          ref={inputRef}
          className="chat-textarea"
          placeholder="質問を入力"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // IME 変換確定の Enter(isComposing)では送信しない。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send(input)
            }
          }}
        />
        <button
          className="chat-send"
          onClick={() => void send(input)}
          disabled={busy || !input.trim()}
          aria-label="送信"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
