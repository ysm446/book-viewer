import type { ELK, ElkNode } from 'elkjs/lib/elk-api'

/** 相関図の人物の箱。 */
export const NODE_WIDTH = 160
export const NODE_HEIGHT = 32
const LABEL_HEIGHT = 16
const LABEL_CHARS = 14

export interface GraphNode {
  id: string
  x: number
  y: number
}
export interface GraphEdge {
  /** 代表の関係(線を押したときに根拠へ移動する)の id */
  id: string
  from: string
  to: string
  /** 直角に折れる経路(SVG の path) */
  path: string
  /** 線の説明(長いものは切り、同じ向きの関係が複数あれば「ほか n」を付ける)と、その中心 */
  text: string
  label: { x: number; y: number; width: number } | null
}
export interface GraphLayout {
  width: number
  height: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 12px の文字のおおよその幅(全角 12px、半角 7px)。 */
function textWidth(text: string): number {
  let w = 0
  for (const c of text) w += c.charCodeAt(0) < 0x2000 ? 7 : 12
  return w
}

/** 配置のライブラリは大きい(約 3 MB)ので、相関図を初めて開いたときに読み込む。 */
let engine: Promise<ELK> | null = null
function loadEngine(): Promise<ELK> {
  engine ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default())
  return engine
}

/**
 * 人物と関係を、箱が重ならず線が直角に折れる図に配置する。
 * 同じ人物から同じ人物への関係は 1 本にまとめる(すべての関係は図の下の一覧に出す)。
 */
export async function layoutGraph(
  people: { id: string }[],
  relations: { id: string; from: string; to: string; description: string }[]
): Promise<GraphLayout> {
  const ids = new Set(people.map((p) => p.id))
  const pairs = new Map<string, { id: string; from: string; to: string; text: string; count: number }>()
  for (const r of relations) {
    if (!ids.has(r.from) || !ids.has(r.to) || r.from === r.to) continue
    const key = `${r.from}>${r.to}`
    const pair = pairs.get(key)
    if (pair) pair.count++
    else pairs.set(key, { id: r.id, from: r.from, to: r.to, text: r.description, count: 1 })
  }
  const edges = [...pairs.values()].map((p) => {
    const short = p.text.length > LABEL_CHARS ? p.text.slice(0, LABEL_CHARS) + '…' : p.text
    return { ...p, text: p.count > 1 ? `${short} ほか${p.count - 1}` : short }
  })
  const input: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      'elk.spacing.nodeNode': '48',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.spacing.labelLabel': '8',
      'elk.spacing.componentComponent': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.thoroughness': '30'
    },
    children: people.map((p) => ({ id: p.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      // 説明は線の上に載せる(横に置くと、どの線の説明か分からなくなる)。
      labels: [
        {
          id: `${e.id}-label`,
          text: e.text,
          width: textWidth(e.text) + 8,
          height: LABEL_HEIGHT,
          layoutOptions: { 'elk.edgeLabels.inline': 'true' }
        }
      ]
    }))
  }
  const result = await (await loadEngine()).layout(input)
  const placed = new Map((result.edges ?? []).map((e) => [e.id, e]))
  return {
    width: result.width ?? 0,
    height: result.height ?? 0,
    nodes: (result.children ?? []).map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 })),
    edges: edges.map((e) => {
      const out = placed.get(e.id)
      const points = (out?.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint])
      const label = out?.labels?.[0]
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        text: e.text,
        path: points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '),
        label:
          label && label.x !== undefined && label.y !== undefined
            ? { x: label.x + (label.width ?? 0) / 2, y: label.y + LABEL_HEIGHT / 2, width: label.width ?? 0 }
            : null
      }
    })
  }
}
