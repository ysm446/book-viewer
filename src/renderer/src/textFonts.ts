/** テキスト表示の本文の書体。 */
export type TextFont =
  | 'gothic'
  | 'biz-gothic'
  | 'yu-mincho'
  | 'biz-mincho'
  | 'shippori'
  | 'noto-serif'
  | 'kyokasho'

/** 書体に用意された太さ。value は CSS の font-weight、name は書体での呼び名(Regular / Bold など)。 */
export interface FontWeight {
  value: number
  name: string
}

/**
 * 選べる書体。family は CSS の font-family(null は UI と同じ書体)。
 * weights はその書体に用意されている太さ。Windows 11 に入っている書体の太さと呼び名に合わせる
 * (BIZ UD明朝の標準の字は Medium = 500。Yu Gothic UI の 350 は Semilight、游明朝の 600 は Demibold)。
 * しっぽり明朝だけアプリに同梱し(styles.css の @font-face)、ほかは Windows に入っている書体を使う。
 * 入っていない PC では、後ろに並べた似た書体へ落ちる。
 */
const W = (value: number, name: string): FontWeight => ({ value, name })
const REGULAR_BOLD = [W(400, 'Regular'), W(700, 'Bold')]

export const TEXT_FONTS: { value: TextFont; label: string; family: string | null; weights: FontWeight[] }[] = [
  {
    value: 'gothic',
    label: 'ゴシック（標準）',
    family: null,
    weights: [W(300, 'Light'), W(350, 'Semilight'), W(400, 'Regular'), W(600, 'Semibold'), W(700, 'Bold')]
  },
  {
    value: 'biz-gothic',
    label: 'BIZ UDゴシック',
    family: "'BIZ UDGothic', 'Yu Gothic UI', sans-serif",
    weights: REGULAR_BOLD
  },
  {
    value: 'yu-mincho',
    label: '游明朝',
    family: "'Yu Mincho', YuMincho, 'Hiragino Mincho ProN', 'Noto Serif JP', serif",
    weights: [W(300, 'Light'), W(400, 'Regular'), W(600, 'Demibold')]
  },
  {
    value: 'biz-mincho',
    label: 'BIZ UD明朝',
    family: "'BIZ UDMincho', 'BIZ UDMincho Medium', 'Yu Mincho', serif",
    weights: [W(500, 'Medium'), W(700, 'Bold')]
  },
  {
    value: 'shippori',
    label: 'しっぽり明朝',
    family: "'Shippori Mincho', 'Yu Mincho', serif",
    weights: [W(400, 'Regular')]
  },
  {
    value: 'noto-serif',
    label: 'Noto Serif JP',
    family: "'Noto Serif JP', 'Yu Mincho', serif",
    weights: [
      W(200, 'ExtraLight'),
      W(300, 'Light'),
      W(400, 'Regular'),
      W(500, 'Medium'),
      W(600, 'SemiBold'),
      W(700, 'Bold'),
      W(900, 'Black')
    ]
  },
  {
    value: 'kyokasho',
    label: 'UDデジタル教科書体',
    family: "'UD Digi Kyokasho N', 'UD Digi Kyokasho N-R', 'Yu Mincho', serif",
    weights: REGULAR_BOLD
  }
]

/** その書体での太さの呼び名(用意されていない太さは数値のまま)。 */
export function weightName(font: TextFont, weight: number): string {
  return textFontOf(font).weights.find((w) => w.value === weight)?.name ?? String(weight)
}

/** その書体に用意された太さのうち、weight にいちばん近いもの(同じ近さなら細い方)。 */
export function nearestWeight(font: TextFont, weight: number): number {
  const ws = textFontOf(font).weights.map((w) => w.value)
  return ws.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), ws[0])
}

export function textFontOf(value: TextFont): (typeof TEXT_FONTS)[number] {
  return TEXT_FONTS.find((f) => f.value === value) ?? TEXT_FONTS[0]
}

/** 保存値を読む。以前の「明朝」(mincho)は游明朝として引き継ぐ。 */
export function parseTextFont(v: string | null): TextFont {
  if (v === 'mincho') return 'yu-mincho'
  return TEXT_FONTS.some((f) => f.value === v) ? (v as TextFont) : 'gothic'
}
