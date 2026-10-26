import type { ContentBlock, Highlight, HighlightColor, HighlightPart } from './api'

/**
 * ハイライトの位置の記録と付け直し(docs/plan/plan.md「ハイライト」)。
 *
 * アプリ用の本文(content.json)は作り直されてブロックの添字が変わり、画面の番号はウィンドウの大きさで
 * 変わるので、どちらにも頼らない。ブロックは Markdown の指紋で探し、ブロックの中の範囲は文字の位置と、
 * 選んだ文字列・前後の文字列で付け直す。
 */

/** ハイライトの色(styles.css の --hl-* と ::highlight(hl-*))。 */
export const HL_COLORS: { value: HighlightColor; label: string }[] = [
  { value: 'yellow', label: '黄' },
  { value: 'green', label: '緑' },
  { value: 'pink', label: '桃' }
]

/** 前後に残す文字数。本文が少し変わっても、同じ文字列が複数あるときに見分けられるように。 */
const CONTEXT = 32
/** 指紋で見つからないとき、元のページの前後何ページで文字列を探すか。 */
const NEAR_PAGES = 3

/** ブロックの Markdown の指紋(53 bit のハッシュ。cyrb53)。 */
export function blockKey(md: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < md.length; i++) {
    const ch = md.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** 位置を数える文字のテキストノード(ルビの読みと、英語の本の訳文を除く)。 */
function textNodes(el: Element): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('rt, rp, .rf-ja') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** 選択の端(container, offset)が、数える文字の何文字目に当たるか。 */
function offsetIn(nodes: Text[], container: Node, offset: number): number {
  const at = document.createRange()
  at.setStart(container, offset)
  let total = 0
  for (const n of nodes) {
    if (n === container) return total + Math.min(offset, n.length)
    if (at.comparePoint(n, n.length) <= 0) total += n.length
    else break
  }
  return total
}

/** 数える文字の pos 文字目の位置。始まりは次のノードの先頭、終わりは前のノードの末尾に寄せる。 */
function pointAt(nodes: Text[], pos: number, isEnd: boolean): [Text, number] | null {
  let acc = 0
  for (const n of nodes) {
    if (isEnd ? pos <= acc + n.length : pos < acc + n.length) return [n, pos - acc]
    acc += n.length
  }
  const last = nodes[nodes.length - 1]
  return last ? [last, last.length] : null
}

/** 本文の選択から、ブロックごとの範囲を作る。訳文だけを出しているブロック(data-ja)と訳文の部分は除く。 */
export function partsFromRange(flow: HTMLElement, range: Range, blocks: ContentBlock[]): HighlightPart[] {
  const parts: HighlightPart[] = []
  flow.querySelectorAll<HTMLElement>('[data-b]').forEach((el) => {
    if (!range.intersectsNode(el) || el.hasAttribute('data-ja')) return
    const index = Number(el.dataset.b)
    const b = blocks[index]
    const nodes = textNodes(el)
    if (!b || nodes.length === 0) return
    const text = nodes.map((n) => n.data).join('')
    let start = el.contains(range.startContainer) ? offsetIn(nodes, range.startContainer, range.startOffset) : 0
    let end = el.contains(range.endContainer) ? offsetIn(nodes, range.endContainer, range.endOffset) : text.length
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (end <= start) return
    parts.push({
      key: blockKey(b.md),
      block: index,
      page: b.page,
      start,
      end,
      text: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT), start),
      suffix: text.slice(end, end + CONTEXT)
    })
  })
  return parts
}

/** ブロックの指紋 → 添字(同じ本文のブロックが複数あれば全部)。 */
export function buildKeyIndex(blocks: ContentBlock[]): Map<string, number[]> {
  const index = new Map<string, number[]>()
  blocks.forEach((b, i) => {
    const k = blockKey(b.md)
    const list = index.get(k)
    if (list) list.push(i)
    else index.set(k, [i])
  })
  return index
}

/** Markdown から、文字列を探すための地の文(ルビの読み・タグ・強調の記号・空白を除く)。 */
function plainOf(md: string): string {
  return md
    .replace(/<rt>[^<]*<\/rt>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~#>]/g, '')
    .replace(/\s+/g, '')
}

function nearest(cands: number[], target: number): number {
  return cands.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
}

/** 範囲がどのブロックにあるか。指紋で探し、見つからなければ近くのページで文字列を含むブロック。 */
function blockOfPart(
  p: HighlightPart,
  blocks: ContentBlock[],
  index: Map<string, number[]>,
  plain: Map<number, string>
): number | null {
  const cands = index.get(p.key)
  if (cands && cands.length > 0) return nearest(cands, p.block)
  const needle = p.text.replace(/\s+/g, '')
  if (!needle) return null
  const found: number[] = []
  blocks.forEach((b, i) => {
    if (Math.abs(b.page - p.page) > NEAR_PAGES) return
    let s = plain.get(i)
    if (s === undefined) {
      s = plainOf(b.md)
      plain.set(i, s)
    }
    if (s.includes(needle)) found.push(i)
  })
  return found.length > 0 ? nearest(found, p.block) : null
}

/** ハイライトの範囲ごとのブロック(見つからない範囲は null)。 */
export type ResolvedBlocks = (number | null)[]

/** すべてのハイライトについて、範囲ごとのブロックを決める。 */
export function resolveHighlights(
  highlights: Highlight[],
  blocks: ContentBlock[],
  index: Map<string, number[]>
): Map<number, ResolvedBlocks> {
  const plain = new Map<number, string>()
  const out = new Map<number, ResolvedBlocks>()
  for (const h of highlights) out.set(h.id, h.parts.map((p) => blockOfPart(p, blocks, index, plain)))
  return out
}

/** a の末尾と b の末尾が何文字一致するか。 */
function commonTail(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** a の先頭と b の先頭が何文字一致するか。 */
function commonHead(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/**
 * ブロックの要素の中で、範囲に当たる DOM の Range。記録した位置の文字列が同じならそのまま、違えば
 * 文字列の出現のうち前後の文字列が最も合う(同点なら記録した位置に近い)ものを選ぶ。見つからなければ null。
 */
export function rangeInBlock(el: Element, p: HighlightPart): Range | null {
  const nodes = textNodes(el)
  const text = nodes.map((n) => n.data).join('')
  let pos = -1
  if (text.slice(p.start, p.end) === p.text) {
    pos = p.start
  } else {
    let best = -Infinity
    for (let i = text.indexOf(p.text); i >= 0; i = text.indexOf(p.text, i + 1)) {
      const score =
        commonTail(text.slice(Math.max(0, i - CONTEXT), i), p.prefix) +
        commonHead(text.slice(i + p.text.length, i + p.text.length + CONTEXT), p.suffix) -
        Math.abs(i - p.start) / 100000
      if (score > best) {
        best = score
        pos = i
      }
    }
  }
  if (pos < 0) return null
  const s = pointAt(nodes, pos, false)
  const e = pointAt(nodes, pos + p.text.length, true)
  if (!s || !e) return null
  const r = document.createRange()
  r.setStart(s[0], s[1])
  r.setEnd(e[0], e[1])
  return r
}
