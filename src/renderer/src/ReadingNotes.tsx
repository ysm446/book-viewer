import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, type GraphLayout } from './notesGraph'
import { cancelJob, changeNotes, enqueueNotes, getNotes, getQueue, summarizePerson,
  type ReadingNotesData, type NoteFact, type NotesChanges, type Work } from './api'

interface Props {
  root: string
  work: Work
  page: number
  llmReady: boolean
  /** 本文の名前から開いたときに、最初に絞り込む人物の名前(別表記でもよい) */
  person?: string
  onClose: () => void
  onJump: (page: number, block: number) => void
}

/** 相関図に、人物を選んでいないときに描く人数(情報の多い順)。 */
const GRAPH_PEOPLE = 15

/** 相関図の拡大率の範囲と、ボタン 1 回分の倍率。 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 2
const ZOOM_STEP = 1.25

type NotePerson = ReadingNotesData['people'][number]

/**
 * 相関図。枠の中でスクロールし、つかんで動かせる。Ctrl + ホイール(トラックパッドのピンチ)と
 * ボタンで拡大縮小する。図が変わると作り直され、等倍・左右の中央から始まる。
 */
function RelationGraph({ layout, people, onPick, onJump }: {
  layout: GraphLayout
  people: NotePerson[]
  onPick: (id: string) => void
  onJump: (relationId: string) => void
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const scaleNow = useRef(1)
  /** 拡大率を変えたあとも同じ場所が同じ位置に見えるよう、図の上の点と枠の中の位置を覚える */
  const anchor = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [peek, setPeek] = useState('')

  /** 図が枠より狭いときは中央に寄るので、その分の左の空き。 */
  const inset = (el: HTMLElement, s: number): number => Math.max(0, (el.clientWidth - layout.width * s) / 2)

  const zoomTo = (next: number, px?: number, py?: number): void => {
    const el = box.current
    if (!el) return
    const to = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    const from = scaleNow.current
    if (to === from) return
    const ax = px ?? el.clientWidth / 2
    const ay = py ?? el.clientHeight / 2
    // 描き直す前に続けて回したときは、最初に覚えた点をそのまま使う(スクロール位置がまだ古い)。
    const held = anchor.current
    anchor.current = {
      x: held ? held.x : (el.scrollLeft + ax - inset(el, from)) / from,
      y: held ? held.y : (el.scrollTop + ay) / from,
      px: ax,
      py: ay
    }
    scaleNow.current = to
    setScale(to)
  }
  useLayoutEffect(() => {
    const el = box.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollLeft = a.x * scale + inset(el, scale) - a.px
    el.scrollTop = a.y * scale - a.py
  }, [scale])

  useLayoutEffect(() => {
    const el = box.current
    if (el) el.scrollLeft = (layout.width - el.clientWidth) / 2
  }, [])

  // React の onWheel は preventDefault できないので、直接つなぐ。
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomTo(scaleNow.current * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const fit = (): void => {
    const el = box.current
    if (!el) return
    const maxHeight = parseFloat(getComputedStyle(el).maxHeight) || el.clientHeight
    // スクロールバーの分(9px)を引いて、収まったあとにバーが出ないようにする。
    zoomTo(Math.min(1, (el.clientWidth - 10) / layout.width, (maxHeight - 10) / layout.height))
  }

  const endDrag = (): void => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) return
    setDragging(false)
    // 動かしたあとのクリックは人物・線に渡さない。クリックが来なかったときのために印は次の周で消す。
    dragged.current = true
    setTimeout(() => { dragged.current = false }, 0)
  }

  const peeked = people.find(p => p.id === peek)
  const peekNode = layout.nodes.find(n => n.id === peek)
  const peekAt = peekNode && { x: (peekNode.x + NODE_WIDTH / 2) * scale, y: (peekNode.y + NODE_HEIGHT) * scale }
  const width = layout.width * scale
  const height = layout.height * scale

  return <>
    <div className="notes-graph-tools">
      <span className="notes-graph-hint">ドラッグで移動 ・ Ctrl + ホイールで拡大縮小</span>
      <button className="btn" aria-label="縮小" title="縮小" disabled={scale <= ZOOM_MIN} onClick={() => zoomTo(scale / ZOOM_STEP)}>−</button>
      <button className="btn notes-graph-zoom" title="等倍に戻す" aria-label={`拡大率 ${Math.round(scale * 100)}%。等倍に戻す`}
        disabled={scale === 1} onClick={() => zoomTo(1)}>{Math.round(scale * 100)}%</button>
      <button className="btn" aria-label="拡大" title="拡大" disabled={scale >= ZOOM_MAX} onClick={() => zoomTo(scale * ZOOM_STEP)}>＋</button>
      <button className="btn" title="図の全体が収まる大きさにする" onClick={fit}>全体</button>
    </div>
    <div ref={box} className={`notes-graph ${dragging ? 'is-dragging' : ''}`}
      onPointerDown={e => {
        if (e.button !== 0) return
        // スクロールバーの上では動かさない(バーの操作と逆向きに動いてしまう)。
        const r = e.currentTarget.getBoundingClientRect()
        if (e.clientX - r.left >= e.currentTarget.clientWidth || e.clientY - r.top >= e.currentTarget.clientHeight) return
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop, moved: false }
      }}
      onPointerMove={e => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.moved) {
          if (Math.abs(dx) + Math.abs(dy) < 5) return
          d.moved = true
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          setPeek('')
        }
        e.currentTarget.scrollLeft = d.left - dx
        e.currentTarget.scrollTop = d.top - dy
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag}
      onClickCapture={e => { if (dragged.current) { dragged.current = false; e.stopPropagation(); e.preventDefault() } }}>
      <div className="notes-graph-stage" style={{ width }}>
        <svg width={width} height={height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="人物相関図。線の説明と根拠は下の関係一覧でも確認できます">
          <defs><marker id="notes-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {layout.edges.map(e => <g key={e.id} className="notes-edge" role="button" tabIndex={0} aria-label={`${e.text}、根拠へ移動`}
            onClick={() => onJump(e.id)} onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onJump(e.id) } }}>
            <path className="notes-edge-hit" d={e.path} />
            <path d={e.path} markerEnd="url(#notes-arrow)" />
          </g>)}
          {/* 説明は線の上に載せ、後から描いて他の線に隠れないようにする */}
          {layout.edges.map(e => e.label && <g key={e.id} className="notes-edge-label" onClick={() => onJump(e.id)}>
            <rect x={e.label.x - e.label.width / 2} y={e.label.y - 9} width={e.label.width} height="18" />
            <text x={e.label.x} y={e.label.y} dominantBaseline="middle">{e.text}</text>
          </g>)}
          {layout.nodes.map(n => {
            const p = people.find(x => x.id === n.id)
            if (!p) return null
            return <g key={p.id} className="notes-node" role="button" tabIndex={0} aria-label={`${p.name}に絞る`}
              onMouseEnter={() => setPeek(p.id)} onMouseLeave={() => setPeek('')} onFocus={() => setPeek(p.id)} onBlur={() => setPeek('')}
              onClick={() => onPick(p.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(p.id) } }}>
              <rect x={n.x} y={n.y} width={NODE_WIDTH} height={NODE_HEIGHT} rx="6" />
              <text x={n.x + NODE_WIDTH / 2} y={n.y + NODE_HEIGHT / 2} dominantBaseline="middle">{p.name.length > 12 ? p.name.slice(0, 12) + '…' : p.name}</text>
            </g>
          })}
        </svg>
        {/* 紹介は拡大率に関係なく同じ大きさで出す */}
        {peeked && peekAt && !dragging && <div className="ex-popup dict-popup notes-peek" role="tooltip" style={{
          left: Math.min(Math.max(peekAt.x - 140, 8), Math.max(8, width - 288)), width: 280,
          ...(peekAt.y > height - 200 && peekAt.y > 240 ? { top: 'auto', bottom: height - peekAt.y + NODE_HEIGHT * scale + 4 } : { top: peekAt.y + 4 }) }}>
          <div className="dict-word">{peeked.name}</div>
          {peeked.aliases.length > 0 && <div className="dict-note">呼び名: {peeked.aliases.join(' / ')}</div>}
          <div className="person-popup-text">{peeked.summary || peeked.facts.filter(f => f.kind !== 'alias').slice(0, 3)
            .map(f => f.description.replace(/[。.]$/, '') + '。').join('')}</div>
          <div className="dict-note">情報 {peeked.facts.length} 件・クリックでこの人物に絞る</div>
        </div>}
      </div>
    </div>
  </>
}

/** 保存済みの情報を表示する。本の先まで解析しても API が読書位置で絞る。 */
export function ReadingNotes({ root, work, page, llmReady, person, onClose, onJump }: Props): JSX.Element {
  const [data, setData] = useState<ReadingNotesData | null>(null)
  const [mode, setMode] = useState<'all' | 'chapter' | 'through'>('all')
  const [chapter, setChapter] = useState(0)
  const [graph, setGraph] = useState(false)
  const [selected, setSelected] = useState('')
  const wanted = useRef(person ?? '')
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
  const [graphAll, setGraphAll] = useState(false)
  const [layout, setLayout] = useState<GraphLayout | null>(null)
  const [opened, setOpened] = useState<string[]>([])
  const request = useRef(0)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => { closeButton.current?.focus() }, [])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const generation = ++request.current
    setData(null)
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

  // 本文の名前から開いたときは、最初に届いた一覧からその人物を探して絞り込む。
  // 絞り込んでいた人物がこの範囲にいなくなったら(統合・表示範囲の変更など)、絞り込みを外す。
  useEffect(() => {
    if (!data) return
    if (wanted.current) {
      const name = wanted.current
      wanted.current = ''
      const found = data.people.find(p => p.name === name || p.aliases.includes(name))
      if (found) setSelected(found.id)
    } else if (selected && !data.people.some(p => p.id === selected)) setSelected('')
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
  // 相関図は関係のある人物だけを描く。人物を選んでいないときは、情報の多い人物に絞って見やすくする。
  const ends = new Set(relations.flatMap(r => [r.from, r.to]))
  const connected = people.filter(p => ends.has(p.id))
  const few = selected || graphAll ? connected : connected.slice(0, GRAPH_PEOPLE)
  const fewIds = new Set(few.map(p => p.id))
  const drawn = relations.filter(r => fewIds.has(r.from) && fewIds.has(r.to))
  const drawnEnds = new Set(drawn.flatMap(r => [r.from, r.to]))
  const nodes = few.filter(p => drawnEnds.has(p.id))
  // 箱が重ならず線が直角に折れる配置を計算する(人物・関係が変わったときだけ)。大きい図は縦横にスクロールする。
  const graphKey = graph ? JSON.stringify([nodes.map(p => p.id), drawn.map(r => [r.id, r.description])]) : ''
  useEffect(() => {
    setLayout(null)
    if (!graphKey) return
    let alive = true
    layoutGraph(nodes, drawn).then(next => { if (alive) setLayout(next) }).catch(e => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [graphKey])
  const jump = (id: string): void => {
    const r = drawn.find(x => x.id === id)
    if (r) onJump(r.page, r.block)
  }

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
        {graph && !selected && connected.length > GRAPH_PEOPLE && <button className={`btn ${graphAll ? 'btn-active' : ''}`} aria-pressed={graphAll}
          title={`ふだんは情報の多い ${GRAPH_PEOPLE} 人までを描きます`}
          onClick={() => setGraphAll(v => !v)}>関係のある全員を描く（{connected.length}）</button>}
      </div>
      <div className="notes-body">
        {!people.length && <div className="reader-info-empty">{data.checked ? 'この範囲に人物情報はありません。表示範囲を変更できます。' : 'まだ人物情報がありません。「登場人物をまとめる」で作成できます。'}</div>}
        {graph && people.length > 0 && <>
          {!drawn.length ? <div className="reader-info-empty">この範囲に人物間の関係はありません。</div>
            : !layout ? <div className="reader-info-empty" role="status">図を配置しています…</div>
            : <RelationGraph layout={layout} people={nodes} onPick={setSelected} onJump={jump} />}
          {drawn.map(r => <article className="notes-person" key={r.id}><strong>{r.subject} → {r.target}</strong>{facts([r])}</article>)}
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
