/** 画面の表示用の整形。 */

/** 経過時間の表示(m:ss。1 時間を超えたら h:mm:ss)。 */
export function fmtElapsed(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
