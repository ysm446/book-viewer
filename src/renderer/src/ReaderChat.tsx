import { useEffect, useRef, useState } from 'react'
import {
  chatAboutWorkStream,
  enqueueIndex,
  getQueue,
  getIndexStatus,
  suggestChatQuestions,
  type ChatSources,
  type ChatTurn,
  type IndexStatus,
  type Work
} from './api'
import { Markdown } from './Markdown'

/**
 * 本ごとのネタバレ防止(localStorage)。既定は ON(今のページまでの内容だけで答える)。
 * 技術書などで先の内容も使ってほしい本だけ OFF にして覚えておく。
 */
const SPOILER_STORE = 'chatSpoilerGuard'

function loadSpoilerGuard(workId: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(SPOILER_STORE) ?? '{}')[workId] !== false
  } catch {
    return true
  }
}

function saveSpoilerGuard(workId: string, on: boolean): void {
  try {
    const all = JSON.parse(localStorage.getItem(SPOILER_STORE) ?? '{}')
    if (on) delete all[workId]
    else all[workId] = false
    localStorage.setItem(SPOILER_STORE, JSON.stringify(all))
  } catch {
    // 保存できなくても、この本を開いている間は切り替えが効く
  }
}

/** 応答の材料にした本文を 1 行で示す(答えが的外れなときに、何を見て答えたか分かるように)。 */
function sourcesLabel(s: ChatSources): string {
  const pages = (ps: number[]): string =>
    [...ps]
      .sort((a, b) => a - b)
      .map((p) => `p.${p + 1}`)
      .join(', ')
  const parts: string[] = []
  if (s.nearby) parts.push(`今のページ付近 p.${s.nearby[0] + 1}〜${s.nearby[1] + 1}`)
  if (s.keyword.length > 0) parts.push(`語の一致 ${pages(s.keyword)}`)
  if (s.search.length > 0) parts.push(`本文検索 ${pages(s.search)}`)
  if (s.summaries > 0) parts.push(`章の要約 ${s.summaries} 章`)
  return parts.length > 0 ? `参照: ${parts.join(' ・ ')}` : '参照: 本文なし'
}

interface ReaderChatProps {
  root: string
  /** 会話用のモデルが読み込まれているか。読み込まれていなければ送信できない。 */
  llmReady: boolean
  work: Work
  /** 現在開いているページ(見開きなら後ろ側)。ここまでの本文を文脈に使い、画像添付にも使う。 */
  currentPage: number
  /** 本文を渡す上限(文字数)。コンテキスト長の設定から決める。 */
  contextChars: number
  /** 思考(reasoning)モード。設定から渡す。 */
  think: boolean
  /** チャットのシステムプロンプト(設定から差し替え可能)。 */
  systemPrompt: string
  /** 候補チップに、内容から作った質問を混ぜるか(設定から渡す)。 */
  dynamicSuggestions: boolean
  /** 本文に無いことも一般知識で補って答えるか(設定から渡す)。 */
  generalKnowledge: boolean
  /** サイドバー幅(px)。ドラッグリサイズ用に親から渡す。 */
  width?: number
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
  llmReady,
  work,
  currentPage,
  contextChars,
  think,
  systemPrompt,
  dynamicSuggestions,
  generalKnowledge,
  width
}: ReaderChatProps): JSX.Element {
  // モデル未読込のときの送信ボタン・候補の案内。
  const notReadyHint = '上部の「モデルを読み込む」でモデルを読み込むと送信できます'
  const [messages, setMessages] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // 見出しの ? で開く使い方の案内。
  const [hintOpen, setHintOpen] = useState(false)
  // ネタバレ防止(本ごと)。本が変わったら、その本の設定を読み直す。
  const [spoilerGuard, setSpoilerGuard] = useState(() => loadSpoilerGuard(work.id))
  useEffect(() => {
    setSpoilerGuard(loadSpoilerGuard(work.id))
  }, [work.id])
  function toggleSpoilerGuard(): void {
    const next = !spoilerGuard
    setSpoilerGuard(next)
    saveSpoilerGuard(work.id, next)
  }
  // 開いている間の Escape は案内だけ閉じる(リーダーの「一覧へ戻る」より先に捕まえる)。
  useEffect(() => {
    if (!hintOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setHintOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hintOpen])
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
    el.style.height = `${el.scrollHeight}px`
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
  }, [work.id])

  // 設定の「内容から質問候補を作る」が切り替わったら、会話は残したまま候補だけ取り直す。
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    setDynamicQuestions([])
    void refreshSuggestions(messages)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dynamicSuggestions])

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
          getIndexStatus(root, work.id),
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
  }, [root, work.id])

  async function buildIndex(): Promise<void> {
    try {
      await enqueueIndex(root, work.id)
      setIndexJob({ current: 0, total: 0 })
      refreshIndexRef.current()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // 別の埋め込みモデルで作った古い索引は検索に使えない(作り直しを促す)。
  const indexModelChanged = !!index && index.chunks > 0 && index.model !== index.embedding_model
  const searchReady = !!index && index.chunks > 0 && !indexModelChanged

  function clearChat(): void {
    if (busy) return
    setMessages([])
    setError(null)
    setInput('')
    void refreshSuggestions([])
  }

  async function send(text: string): Promise<void> {
    const q = text.trim()
    if (!q || busy || !llmReady) return
    const base: ChatTurn[] = [...messages, { role: 'user', content: q }]
    // 応答用のプレースホルダを1つ足し、ストリームで埋めていく。
    setMessages([...base, { role: 'assistant', content: '', reasoning: '' }])
    setInput('')
    setBusy(true)
    setError(null)
    let content = ''
    let reasoning = ''
    let sources: ChatSources | undefined
    const apply = (): void =>
      setMessages((m) => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', content, reasoning, sources }
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
          generalKnowledge,
          spoilerGuard,
          systemPrompt,
          think,
          contextChars,
          search: useSearch && searchReady
        },
        {
          onSources: (s) => {
            sources = s
            apply()
          },
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
      // 会話を踏まえたフォローアップ質問へ差し替える(中断・失敗時はそのまま。
      // パネルを閉じた直後に LLM を呼び直さないよう、中断済みなら何もしない)。
      if (content && !controller.signal.aborted) {
        void refreshSuggestions([...base, { role: 'assistant', content }])
      }
    }
  }

  return (
    <div className="reader-chat" style={width !== undefined ? { flexBasis: width } : undefined}>
      <div className="reader-chat-head">
        <span className="reader-chat-title">✦ この本について質問</span>
        {/* ネタバレ防止(本ごと)。ON は今のページまで、OFF は先の章の要約・先のページの検索も使う。 */}
        <button
          className={`btn reader-chat-spoiler ${spoilerGuard ? 'btn-active' : ''}`}
          aria-pressed={spoilerGuard}
          onClick={toggleSpoilerGuard}
          title={
            spoilerGuard
              ? 'ネタバレ防止: ON(いま開いているページまでの内容で答えます)。押すと、先のページも使って答えます(この本だけ)'
              : 'ネタバレ防止: OFF(先の章の要約や先のページの検索も使って答えます)。押すと、いま開いているページまでに戻します(この本だけ)'
          }
        >
          ネタバレ防止
        </button>
        {/* 使い方の案内。会話エリアを狭めないよう、? を押したときだけポップアップで出す。 */}
        <div className="chat-hint">
          <button
            className="icon-btn chat-hint-btn"
            onClick={() => setHintOpen((v) => !v)}
            aria-label="使い方"
            aria-expanded={hintOpen}
            title="使い方"
          >
            ?
          </button>
          {hintOpen && (
            <>
              <div className="popup-backdrop" onClick={() => setHintOpen(false)} />
              <div className="ex-popup chat-hint-popup" role="note">
                この本について質問にお答えします。
                {spoilerGuard
                  ? 'いま開いているページまでの本文をもとに答えます（先のページは読みません）。'
                  : 'ネタバレ防止が OFF なので、先の章の要約や先のページも使って答えます。'}
                下の候補から選ぶか、質問を入力してください。「ネタバレ防止」はこの本だけの切り替えです。
              </div>
            </>
          )}
        </div>
        <button
          className="btn reader-chat-clear"
          onClick={clearChat}
          disabled={busy || messages.length === 0}
          title="会話をクリア"
        >
          クリア
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
              {m.role === 'assistant' && m.sources && m.content && (
                <div
                  className="chat-sources"
                  title="この答えの材料として LLM に渡した本文(読んだ範囲のみ)。語の一致は質問の語がそのまま出てくるページ"
                >
                  {sourcesLabel(m.sources)}
                </div>
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
              disabled={busy || !llmReady}
              title={
                !llmReady
                  ? notReadyHint
                  : c.dynamic
                    ? `${c.text}(いまの内容から作られた質問)`
                    : c.text
              }
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

      {index && (indexJob || !searchReady || index.stale) && (
        <div className="chat-index">
          {indexJob ? (
            <span>
              本文検索の索引を作成中
              {indexJob.total > 0 ? ` ${indexJob.current}/${indexJob.total}` : '（順番待ち）'}
            </span>
          ) : (
            <>
              <span>
                {indexModelChanged
                  ? '埋め込みモデルが変わりました。本文検索を使うには索引を作り直してください'
                  : index.stale
                    ? '本文が変わりました。本文検索の索引を作り直すと反映されます'
                    : '本文検索の索引を作ると、遠いページの内容も答えに使えます'}
              </span>
              <button
                className="btn chat-index-btn"
                onClick={() => void buildIndex()}
                title={`埋め込みモデル ${index.embedding_model} で索引を作ります（初回はモデル約 1.2 GB を取得します）`}
              >
                {index.stale ? '作り直す' : '索引を作る'}
              </button>
            </>
          )}
        </div>
      )}

      {/* 入力欄・送信オプション・送信ボタンを 1 つの枠にまとめる。 */}
      <div className="reader-chat-input">
        <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="chat-textarea"
            placeholder={llmReady ? '質問を入力' : 'モデルを読み込むと質問できます'}
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
          <div className="chat-composer-bar">
            <div className="chat-composer-opts">
              <button
                className={`btn chat-opt-btn ${pageFocus ? 'btn-active' : ''}`}
                aria-pressed={pageFocus}
                onClick={() => setPageFocus((v) => !v)}
                title="ここまでの流れを踏まえつつ、現在ページの内容を中心に答えます"
              >
                このページ
              </button>
              <button
                className={`btn chat-opt-btn ${includeImage ? 'btn-active' : ''}`}
                aria-pressed={includeImage}
                onClick={() => setIncludeImage((v) => !v)}
                title="現在ページの画像も一緒に送る"
              >
                画像
              </button>
              {searchReady && !indexJob && (
                <button
                  className={`btn chat-opt-btn ${useSearch ? 'btn-active' : ''}`}
                  aria-pressed={useSearch}
                  onClick={() => setUseSearch((v) => !v)}
                  title={`読んだ範囲の本文から、質問に関係しそうな箇所を探して答えに使います（${index?.chunks} 件）`}
                >
                  本文検索
                </button>
              )}
            </div>
            <button
              className="chat-send"
              onClick={() => void send(input)}
              disabled={busy || !input.trim() || !llmReady}
              aria-label="送信"
              title={llmReady ? '送信' : notReadyHint}
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
      </div>
    </div>
  )
}
