import { type BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'

/** 保存先フォルダ名。管理ルート直下に作る(利用者が見つけやすい場所に置く)。 */
const DIR_NAME = 'screenshot'

/** ページ画像の MIME タイプ → 拡張子。アーカイブ内の元データをそのまま書き出すため。 */
const EXT_BY_MEDIA: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

/** F9 で保存する 1 枚ぶんの入力。data はレンダラが backend から取得した生バイト。 */
export interface SavePageInput {
  /** 0 始まりのページ番号。ファイル名に 1 始まりで入れる。 */
  index: number
  mediaType: string
  data: Uint8Array
}

/** ファイル名に使えない文字を落とし、長すぎる名前を詰める。 */
function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
  return (cleaned || 'untitled').slice(0, 60)
}

/** ファイル名用のタイムスタンプ(YYYYMMDD-HHmmss)。 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 同じ秒に複数回保存しても上書きしないよう、衝突時は連番を足す。 */
function uniquePath(dir: string, base: string, ext: string): string {
  let path = join(dir, `${base}${ext}`)
  for (let i = 2; existsSync(path); i++) {
    path = join(dir, `${base}-${i}${ext}`)
  }
  return path
}

function ensureDir(root: string): string {
  const dir = join(root, DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** ウィンドウのコンテンツ領域を PNG で保存し、保存先パスを返す。 */
export async function captureWindow(
  win: BrowserWindow,
  root: string,
  title: string
): Promise<string> {
  const dir = ensureDir(root)
  const image = await win.webContents.capturePage()
  const path = uniquePath(dir, `${sanitize(title)}_${stamp()}`, '.png')
  writeFileSync(path, image.toPNG())
  return path
}

/** 表示中のページ画像を無加工で保存し、保存先パスを順に返す(見開きなら 2 枚)。 */
export function savePages(root: string, title: string, pages: SavePageInput[]): string[] {
  const dir = ensureDir(root)
  const at = stamp()
  const name = sanitize(title)
  return pages.map((p) => {
    const ext = EXT_BY_MEDIA[p.mediaType] ?? '.bin'
    const base = `${name}_p${String(p.index + 1).padStart(4, '0')}_${at}`
    const path = uniquePath(dir, base, ext)
    writeFileSync(path, Buffer.from(p.data))
    return path
  })
}
