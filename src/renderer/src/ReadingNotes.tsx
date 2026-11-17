import { useEffect, useRef, useState } from 'react'
import { cancelJob, changeNotes, enqueueNotes, getNotes, getQueue, summarizePerson,
  type ReadingNotesData, type NoteFact, type NotesChanges, type Work } from './api'

interface Props {
  root: string
  work: Work
  page: number
  llmReady: boolean
  /** 本文の名前から開いたときに、最初に絞り込む人物 */
  person?: string
  onClose: () => void
  onJump: (page: number, block: number) => void
}

/** 保存済みの情報を表示する。本の先まで解析しても API が読書位置で絞る。 */
export function ReadingNotes({ root, work, page, llmReady, person, onClose, onJump }: Props): JSX.Element {
  const [data, setData] = useState<ReadingNotesData | null>(null)
  const [mode, setMode] = useState<'all' | 'chapter' | 'through'>('all')
  const [chapter, setChapter] = useState(0)
  const [graph, setGraph] = useState(false)
  const [selected, setSelected] = useState(person ?? '')
  const opening = useRef(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState('')
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState<NoteFact | null>(null)
  const [draft, setDraft] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [mergePage, setMergePage] = useState(page + 1)
  const [showMinor, setShowMinor] = useState(false)
  const [splitName, setSplitName] = useState('')
  const [writing, setWriting] = useState('')
  const [peek, setPeek] = useState('')
  const [opened, setOpened] = useState<string[]>([])
  const request = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => { closeButton.current?.focus() }, [])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const generation = ++request.current
    setData(null)
    // 本文の名前から開いた直後は、その人物の絞り込みを残す。
    if (!opening.current) setSelected('')
    opening.current = false
    setEditing(null)
    setMergeTarget('')
    setSplitName('')
    const tick = async (): Promise<void> => {
      try {
        const [next, q] = await Promise.all([getNotes(root, work.id, page, chapter, mode), getQueue()])
        if (!alive || generation !== request.current) return
        setData(next)
        const current = q.current?.work_id === work.id && q.current.kind === 'notes' ? q.current : null
        const pending = q.pending.some(j => j.work_id === work.id && j.kind === 'notes')
        setJob(current ? `作成中 ${current.current} / ${current.total}` : pending ? '順番待ち…' : '')
        const last = q.recent.filter(j => j.work_id === work.id && j.kind === 'notes').at(-1)
        if (!current && !pending && last?.status === 'error') setError(last.error || '作成に失敗しました')
      } catch (e) {
        if (alive) setError((e as Error).message)
      }
      if (alive) timer = setTimeout(() => void tick(), 1500)
    }
    void tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [root, work.id, page, chapter, mode, revision])

  // 絞り込んでいた人物がこの範囲にいなくなったら(統合・読書位置の違いなど)、絞り込みを外す。
  useEffect(() => {
    if (data && selected && !data.people.some(p => p.id === selected)) setSelected('')
  }, [data, selected])

  async function action(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await fn()
      setRevision(v => v + 1)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  function change(patch: NotesChanges): void {
    void action(() => changeNotes(root, work.id, patch))
  }

  function facts(items: NoteFact[]): JSX.Element {
    return <div className="notes-facts">{items.map(f => <div className="notes-fact" key={f.id}>
      {f.target && <div className="notes-help">{f.subject} → {f.target}</div>}
      <div>{f.description} <span className="text-page-badge">{f.edited ? '手修正' : f.inferred ? '推測' : '本文から'}</span></div>
      <blockquote>{f.quote}</blockquote>
      <div className="notes-actions">
        <button className="btn" onClick={() => onJump(f.page, f.block)}>根拠 p.{f.page + 1}</button>
        <button className="btn" disabled={busy} onClick={() => { setEditing(f); setDraft(f.description) }}>訂正</button>
        <button className="btn" disabled={busy} onClick={() => {
          if (window.confirm('この情報を一覧と相関図から除外しますか？')) change({ fact_id: f.id, hidden: true })
        }}>除外</button>
      </div>
    </div>)}</div>
  }

  const linked = data?.relations.filter(r => !selected || r.from === selected || r.to === selected) ?? []
  const relatedIds = new Set(linked.flatMap(r => [r.from, r.to]))
  // 人物を選んでいないときは、登場の少ない人物を畳んで主な人物を先に見せる。
  const people = data?.people.filter(p => selected ? p.id === selected || (graph && relatedIds.has(p.id)) : showMinor || !(p.minor || p.thing)) ?? []
  const shown = new Set(people.map(p => p.id))
  const relations = linked.filter(r => shown.has(r.from) && shown.has(r.to))
  const minorCount = data?.people.filter(p => p.minor || p.thing).length ?? 0
  const chosen = data?.people.find(p => p.id === selected)
  // 大きい図は横スクロール。すべての線の説明と根拠は図の下でも操作できる。
  const radius = Math.max(160, people.length * 28)
  const size = radius * 2 + 240
  const positions = new Map(people.map((p, i) => {
    const angle = i * Math.PI * 2 / Math.max(people.length, 1) - Math.PI / 2
    return [p.id, { x: size / 2 + Math.cos(angle) * radius, y: size / 2 + Math.sin(angle) * radius }]
  }))

  // 相関図で人物に乗せた・フォーカスしたときに、その場に紹介を出す。
  const peeked = graph ? people.find(p => p.id === peek) : undefined
  const peekAt = positions.get(peek)

  return <section className="notes-page" aria-label="読書ノート" onKeyDown={e => {
    e.stopPropagation()
    if (e.key === 'Escape' && !editing) onClose()
    else if (e.key === 'Escape') setEditing(null)
  }}>
    <div className="notes-toolbar">
      <strong>読書ノート</strong>
      <button ref={closeButton} className="btn" onClick={onClose}>本文へ戻る</button>
      <span className="text-toolbar-spacer" />
      <button className="btn btn-primary" disabled={busy || !!job || !llmReady || !data?.total}
        onClick={() => void action(() => enqueueNotes(root, work.id, page))}>
        {data?.checked ? '人物・関係を更新' : '登場人物をまとめる'}
      </button>
      {!!job && <button className="btn" disabled={busy} onClick={() => void action(() => cancelJob(work.id))}>この本の処理を停止</button>}
    </div>
    <div className="notes-toolbar">
      <div className="seg" aria-label="ノートの表示">
        <button className={`seg-btn ${!graph ? 'seg-active' : ''}`} onClick={() => setGraph(false)}>人物一覧</button>
        <button className={`seg-btn ${graph ? 'seg-active' : ''}`} onClick={() => setGraph(true)}>相関図</button>
      </div>
      <select className="filter-select" aria-label="表示範囲" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="all">本全体</option><option value="chapter">この章</option><option value="through">この章まで</option>
      </select>
      {mode !== 'all' && <select className="filter-select" aria-label="章" value={chapter} onChange={e => setChapter(Number(e.target.value))}>
        {data?.chapters.map(c => <option key={c.start} value={c.start}>{c.title}</option>)}
      </select>}
      <button className={`btn ${data?.spoiler_guard ? 'btn-active' : ''}`} disabled={busy || !data}
        aria-pressed={data?.spoiler_guard ?? true} onClick={() => change({ spoiler_guard: !data?.spoiler_guard })}>
        ネタバレ防止 {data ? (data.spoiler_guard ? 'ON' : 'OFF') : '…'}
      </button>
    </div>
    {error && <div className="reader-info-error" role="alert">{error} <button className="btn" onClick={() => { setError(''); setRevision(v => v + 1) }}>再読み込み</button></div>}
    {!data ? <div className="reader-info-empty" role="status">読み込み中…</div> : <>
      <div className="notes-help" role="status">
        {job || `解析済み ${data.checked} / ${data.total} 区間`}
        {' ・ '}{data.spoiler_guard ? `p.${page + 1} までの情報を表示` : '先の内容を含めて表示'}
        <div>作成・更新は文字起こし済みの本全体が対象です。ローカル LLM を使用します。主な人物の紹介文も作ります。</div>
        {!llmReady && <div>作成するには上部でモデルを読み込んでください。保存済みのノートはそのまま読めます。</div>}
        {data.pages_done < data.page_count && <div>未文字起こしのページがあります。本文が増えたら更新してください。</div>}
        {data.checked < data.total && data.checked > 0 && <div>追加・変更された本文に未解析の区間があります。</div>}
        {data.untidy > 0 && data.checked > 0 && <div>未整理の名前が {data.untidy} 件あります。「人物・関係を更新」で、別表記の統合と人物以外の判定を行います。</div>}
        <div>「この章」は章内の描写、「この章まで」は累積した描写です。関係の変化は根拠順に併記します。</div>
      </div>
      <div className="notes-toolbar">
        <select className="filter-select" aria-label="人物を絞る" value={selected} onChange={e => { setSelected(e.target.value); setMergeTarget(''); setSplitName('') }}>
          <option value="">すべての人物</option>
          {data.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span>{data.people.length - minorCount} 人物</span>
        {minorCount > 0 && <button className={`btn ${showMinor ? 'btn-active' : ''}`} aria-pressed={showMinor}
          title="登場の少ない人物と、会社・集団など人物でない項目"
          onClick={() => setShowMinor(v => !v)}>その他も表示（{minorCount}）</button>}
      </div>
      <div className="notes-body">
        {!people.length && <div className="reader-info-empty">{data.checked ? 'この範囲に人物情報はありません。表示範囲を変更できます。' : 'まだ人物情報がありません。「登場人物をまとめる」で作成できます。'}</div>}
        {graph && people.length > 0 && <>
          <div className="notes-graph"><div className="notes-graph-stage"><svgwidth={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="人物相関図。線の説明と根拠は下の関係一覧でも確認できます">
            <defs><marker id="notes-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
            {relations.map(r => {
              const a = positions.get(r.from), b = positions.get(r.to)
              if (!a || !b) return null
              const dx = b.x - a.x, dy = b.y - a.y
              const scale = Math.max(Math.abs(dx) / 84, Math.abs(dy) / 20, 1)
              const end = { x: b.x - dx / scale, y: b.y - dy / scale }
              const siblings = relations.filter(x => x.from === r.from && x.to === r.to)
              const shift = (siblings.findIndex(x => x.id === r.id) - (siblings.length - 1) / 2) * 48
              const length = Math.max(1, Math.hypot(dx, dy))
              const center = { x: (a.x + b.x) / 2 - dy / length * shift, y: (a.y + b.y) / 2 + dx / length * shift }
              const path = `M ${a.x} ${a.y} Q ${center.x} ${center.y} ${end.x} ${end.y}`
              return <g key={r.id} className="notes-edge" role="button" tabIndex={0} aria-label={`${r.subject} → ${r.target}: ${r.description}、根拠へ移動`}
                onClick={() => onJump(r.page, r.block)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(r.page, r.block) } }}>
                <title>{r.subject} → {r.target}: {r.description}</title>
                <path className="notes-edge-hit" d={path} />
                <path d={path} markerEnd="url(#notes-arrow)" />
                <text x={(a.x + end.x) / 4 + center.x / 2} y={(a.y + end.y) / 4 + center.y / 2}>{r.description.slice(0, 20)}</text>
              </g>
            })}
            {people.map(p => {
              const pos = positions.get(p.id)!
              return <g key={p.id} className="notes-node" role="button" tabIndex={0} aria-label={`${p.name}に絞る`}
                onMouseEnter={() => setPeek(p.id)} onMouseLeave={() => setPeek('')} onFocus={() => setPeek(p.id)} onBlur={() => setPeek('')}
                onClick={() => setSelected(p.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(p.id) } }}>
                <rectx={pos.x - 80} y={pos.y - 16} width="160" height="32" rx="6" />
                <text x={pos.x} y={pos.y} dominantBaseline="middle">{p.name.length > 12 ? p.name.slice(0, 12) + '…' : p.name}</text>
              </g>
            })}
          </svg>
            {peeked && peekAt && <div className="ex-popup dict-popup notes-peek" role="tooltip" style={{
              left: Math.min(Math.max(peekAt.x - 140, 8), size - 288), width: 280,
              ...(peekAt.y > size - 220 ? { top: 'auto', bottom: size - peekAt.y + 20 } : { top: peekAt.y + 20 }) }}>
              <div className="dict-word">{peeked.name}</div>
              {peeked.aliases.length > 0 && <div className="dict-note">呼び名: {peeked.aliases.join(' / ')}</div>}
              {peeked.summary ? <div>{peeked.summary}</div>
                : <ul className="dict-meanings">{peeked.facts.filter(f => f.kind !== 'alias').slice(0, 3).map(f => <li key={f.id}>{f.description}</li>)}</ul>}
              <div className="dict-note">情報 {peeked.facts.length} 件・クリックでこの人物に絞る</div>
            </div>}
          </div></div>
          {!relations.length && <div className="reader-info-empty">この範囲に人物間の関係はありません。</div>}
          {relations.map(r => <article className="notes-person" key={r.id}><strong>{r.subject} → {r.target}</strong>{facts([r])}</article>)}
        </>}
        {!graph && people.map(p => {
          // 情報の多い人物は先頭だけ見せる。人物を選ぶか「残りを表示」で全件。
          const all = !!selected || opened.includes(p.id) || p.facts.length <= 6
          return <article className="notes-person" key={p.id}>
            <h3>{p.name}{p.thing && <> <span className="text-page-badge">人物以外</span></>}</h3>{p.aliases.length > 0 && <div>呼び名: {p.aliases.join(' / ')}</div>}
            {p.summary && <p className="notes-summary">{p.summary}</p>}
            {(p.summary ? p.summary_stale : p.facts.length >= 3) && <div className="notes-actions">
                <button className="btn" disabled={busy || !llmReady} title={llmReady ? 'いま表示している情報から作ります' : '上部でモデルを読み込むと作れます'}
                  onClick={() => { setWriting(p.id); void action(() => summarizePerson(root, work.id, p.id, page, chapter, mode)).finally(() => setWriting('')) }}>
                  {writing === p.id ? '作成中…' : p.summary ? '紹介文を作り直す' : '紹介文を作る'}</button>
                {p.summary && <span className="notes-help">作成後に情報が増えています</span>}
              </div>}
            {facts(all ? p.facts : p.facts.slice(0, 5))}
            {!all && <button className="btn" onClick={() => setOpened(v => [...v, p.id])}>残り {p.facts.length - 5} 件を表示</button>}
          </article>
        })}
        {chosen && <div className="notes-person">
          <strong>同一人物として統合</strong>
          <p>「{chosen.name}」にまとめる人物と、同一人物と判明したページを指定します。</p>
          <div className="notes-actions">
            <select className="filter-select" aria-label="統合する人物" value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}>
              <option value="">人物を選択</option>{data.people.filter(p => p.id !== chosen.id).map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
            <label>判明ページ <input className="toc-edit-input notes-page-number" type="number" min={1} max={work.page_count} value={mergePage} onChange={e => setMergePage(Number(e.target.value))} /></label>
            <button className="btn" disabled={busy || !mergeTarget || mergePage < 1 || mergePage > work.page_count}
              onClick={() => change({ merge_subject: chosen.name, merge_target: mergeTarget, revealed: mergePage - 1 })}>統合</button>
          </div>
        </div>}
        {chosen && <div className="notes-person">
          <strong>自動の整理を直す</strong>
          <p>別人の呼び名がまとめられているときは分けられます。会社・集団などは「人物以外」にすると畳まれます。</p>
          <div className="notes-actions">
            {chosen.aliases.length > 0 && <>
              <select className="filter-select" aria-label="分ける呼び名" value={splitName} onChange={e => setSplitName(e.target.value)}>
                <option value="">呼び名を選択</option>{chosen.aliases.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <button className="btn" disabled={busy || !splitName}
                onClick={() => { change({ names: [splitName], apart: true }); setSplitName('') }}>別人として分ける</button>
            </>}
            <button className="btn" disabled={busy}
              onClick={() => change({ names: [chosen.name, ...chosen.aliases], person: chosen.thing })}>
              {chosen.thing ? '人物に戻す' : '人物以外にする'}</button>
          </div>
        </div>}
        <div className="notes-actions">
          <button className="btn" disabled={busy} onClick={() => change({ restore_hidden: true })}>除外した情報を戻す</button>
          <button className="btn" disabled={busy} onClick={() => {
            if (window.confirm('手動で行った人物の統合をすべて解除しますか？')) change({ clear_merges: true })
          }}>手動の統合を解除</button>
          <button className="btn" disabled={busy} onClick={() => change({ clear_apart: true })}>分けた呼び名を戻す</button>
        </div>
      </div>
    </>}
    {editing && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="人物情報の訂正" onKeyDown={e => {
      if (e.key === 'Tab') {
        const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)'))
        const first = controls[0], last = controls[controls.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
      <div className="modal notes-edit">
        <h3>情報を訂正</h3><p>根拠の位置は保持されます。この位置で分かる内容だけを記入してください。</p>
        <textarea autoFocus className="toc-edit-input" aria-label="説明" rows={5} maxLength={1000} value={draft} onChange={e => setDraft(e.target.value)} />
        <div className="notes-actions"><button className="btn" onClick={() => setEditing(null)}>キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => change({ fact_id: editing.id, description: draft.trim() })}>保存</button></div>
      </div>
    </div>}
  </section>
}
