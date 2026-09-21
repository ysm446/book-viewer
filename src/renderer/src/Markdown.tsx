import { Fragment, type ReactNode } from 'react'

/**
 * LLM 応答向けの軽量 Markdown 表示。
 *
 * 依存を増やさず(react-markdown 等を入れない)、innerHTML も使わずに React 要素へ
 * 変換するため XSS 安全。毎回全文をパースするだけなので、ストリーミング途中の
 * 未完テキスト(閉じていないコードフェンス等)もそのまま途中状態として描画できる。
 * 対応: 見出し / 箇条書き・番号リスト(1段ネスト) / コードブロック / 引用 / 表 /
 * 区切り線 / 太字・斜体・打ち消し・インラインコード・リンク / ルビ(<ruby>漢字<rt>かんじ</rt></ruby>) /
 * 画像だけの行(![キャプション](パス)。表示するかは resolveImage で決める) /
 * 図の置き場所([図: キャプション] だけの行。本文の文字起こしで使う)。
 */

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~)|\[([^\]\n]+)\]\(([^)\s]+)\)|<ruby>([^<\n]+)<rt>([^<\n]*)<\/rt><\/ruby>/g

/** 本文の文字起こしで図の位置に置く 1 行([図: キャプション])。 */
const FIGURE_RE = /^\s*\[図[:：]\s*(.*)\]\s*$/
/** 画像だけの 1 行(![キャプション](パス))。 */
const IMAGE_RE = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  // /g の正規表現は lastIndex を自身に持つため、共有インスタンスを使うと
  // 再帰呼び出し(strong の中身)が状態を巻き戻して無限ループする。毎回複製する。
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags)
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `i${k++}`
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={key}>{inline(m[2].slice(2, -2))}</strong>)
    else if (m[3]) out.push(<em key={key}>{m[3].slice(1, -1)}</em>)
    else if (m[4]) out.push(<del key={key}>{m[4].slice(2, -2)}</del>)
    else if (m[7])
      out.push(
        <ruby key={key}>
          {m[7]}
          <rt>{m[8]}</rt>
        </ruby>
      )
    else if (m[6] && /^https?:\/\//i.test(m[6]))
      out.push(
        // 外部リンクは main の setWindowOpenHandler が既定ブラウザで開く。
        // LLM 出力由来のため http/https 以外(file: 等)はリンクにしない。
        <a key={key} href={m[6]} target="_blank" rel="noreferrer">
          {m[5]}
        </a>
      )
    else out.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** 複数行を、単一改行を <br> に保ったままインライン描画する(チャット向け)。 */
function multiline(lines: string[]): ReactNode {
  return lines.map((l, j) => (
    <Fragment key={j}>
      {j > 0 && <br />}
      {inline(l)}
    </Fragment>
  ))
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

/** 段落の継続を打ち切る行(= 別ブロックの開始)か。 */
function isBlockStart(line: string): boolean {
  return (
    FIGURE_RE.test(line) ||
    IMAGE_RE.test(line) ||
    /^```/.test(line) ||
    /^#{1,4}\s/.test(line) ||
    LIST_RE.test(line) ||
    /^>\s?/.test(line) ||
    /^(-{3,}|\*{3,})\s*$/.test(line) ||
    TABLE_ROW_RE.test(line)
  )
}

export function Markdown({
  text,
  className = 'chat-md',
  resolveImage
}: {
  text: string
  /** 外側の class。既定はチャット向けの小さめの組版(chat-md)。 */
  className?: string
  /**
   * 画像のパスを表示用 URL に変える。null を返したパス(と、この関数が無いとき)は
   * 読み込まずにキャプションだけを出す(LLM 出力の外部 URL などを勝手に読みに行かない)。
   */
  resolveImage?: (src: string) => string | null
}): JSX.Element {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  const key = (): string => `b${k++}`

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    // コードフェンス。閉じが無ければ末尾まで(ストリーミング途中でも崩れない)。
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // 閉じフェンスを消費
      blocks.push(
        <pre key={key()}>
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }

    // 見出し(# 〜 ####)。サイズは CSS 側でチャット向けに抑える。
    const h = line.match(/^(#{1,4})\s+(.*)/)
    if (h) {
      const Tag = `h${h[1].length}` as 'h1' | 'h2' | 'h3' | 'h4'
      blocks.push(<Tag key={key()}>{inline(h[2])}</Tag>)
      i++
      continue
    }

    // 画像(本文中の図)。キャプションは alt に入っている。
    const image = line.match(IMAGE_RE)
    if (image) {
      const url = resolveImage?.(image[2]) ?? null
      blocks.push(
        url ? (
          <figure key={key()} className="md-image">
            <img src={url} alt={image[1]} loading="lazy" draggable={false} />
            {image[1] && <figcaption>{inline(image[1])}</figcaption>}
          </figure>
        ) : (
          <div key={key()} className="md-figure">
            図: {inline(image[1] || image[2])}
          </div>
        )
      )
      i++
      continue
    }

    // 図の置き場所(Vision LLM の文字起こしでは画像を切り抜かず、キャプションだけを残す)
    const fig = line.match(FIGURE_RE)
    if (fig) {
      blocks.push(
        <div key={key()} className="md-figure">
          図: {inline(fig[1])}
        </div>
      )
      i++
      continue
    }

    // 区切り線
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key()} />)
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push(<blockquote key={key()}>{multiline(buf)}</blockquote>)
      continue
    }

    // 表(ヘッダ行 + セパレータ行 + データ行)
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push(
        <table key={key()}>
          <thead>
            <tr>
              {head.map((c, j) => (
                <th key={j}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, j) => (
              <tr key={j}>
                {r.map((c, j2) => (
                  <td key={j2}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
      continue
    }

    // リスト。インデント 2 以上は直前項目の子リスト(1段のみ)として扱う。
    const li = line.match(LIST_RE)
    if (li) {
      const ordered = /^\d/.test(li[2])
      const items: { text: string; children: string[] }[] = []
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE)
        if (!m) break
        if (m[1].length >= 2 && items.length) items[items.length - 1].children.push(m[3])
        else items.push({ text: m[3], children: [] })
        i++
      }
      const lis = items.map((it, j) => (
        <li key={j}>
          {inline(it.text)}
          {it.children.length > 0 && (
            <ul>
              {it.children.map((c, j2) => (
                <li key={j2}>{inline(c)}</li>
              ))}
            </ul>
          )}
        </li>
      ))
      blocks.push(ordered ? <ol key={key()}>{lis}</ol> : <ul key={key()}>{lis}</ul>)
      continue
    }

    // 段落(空行か別ブロックの開始まで。段落内の単一改行は <br> で保つ)
    const buf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i])
      i++
    }
    blocks.push(<p key={key()}>{multiline(buf)}</p>)
  }

  return <div className={className}>{blocks}</div>
}
