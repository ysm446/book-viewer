/** テキスト表示の本文の書体。 */
export type TextFont =
  | 'gothic'
  | 'biz-gothic'
  | 'yu-mincho'
  | 'biz-mincho'
  | 'shippori'
  | 'noto-serif'
  | 'kyokasho'

/**
 * 選べる書体。family は CSS の font-family(null は UI と同じ書体)。
 * しっぽり明朝だけアプリに同梱し(styles.css の @font-face)、ほかは Windows に入っている書体を使う。
 * 入っていない PC では、後ろに並べた似た書体へ落ちる。
 */
export const TEXT_FONTS: { value: TextFont; label: string; family: string | null }[] = [
  { value: 'gothic', label: 'ゴシック（標準）', family: null },
  { value: 'biz-gothic', label: 'BIZ UDゴシック', family: "'BIZ UDGothic', 'Yu Gothic UI', sans-serif" },
  {
    value: 'yu-mincho',
    label: '游明朝',
    family: "'Yu Mincho', YuMincho, 'Hiragino Mincho ProN', 'Noto Serif JP', serif"
  },
  {
    value: 'biz-mincho',
    label: 'BIZ UD明朝',
    family: "'BIZ UDMincho', 'BIZ UDMincho Medium', 'Yu Mincho', serif"
  },
  { value: 'shippori', label: 'しっぽり明朝', family: "'Shippori Mincho', 'Yu Mincho', serif" },
  { value: 'noto-serif', label: 'Noto Serif JP', family: "'Noto Serif JP', 'Yu Mincho', serif" },
  {
    value: 'kyokasho',
    label: 'UDデジタル教科書体',
    family: "'UD Digi Kyokasho N', 'UD Digi Kyokasho N-R', 'Yu Mincho', serif"
  }
]

export function textFontOf(value: TextFont): (typeof TEXT_FONTS)[number] {
  return TEXT_FONTS.find((f) => f.value === value) ?? TEXT_FONTS[0]
}

/** 保存値を読む。以前の「明朝」(mincho)は游明朝として引き継ぐ。 */
export function parseTextFont(v: string | null): TextFont {
  if (v === 'mincho') return 'yu-mincho'
  return TEXT_FONTS.some((f) => f.value === v) ? (v as TextFont) : 'gothic'
}
