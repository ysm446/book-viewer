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

/**
 * ウィンドウのコンテンツ領域を PNG で保存し、保存先パスを返す。
 * capturePage は画面の実ピクセルで返る(表示スケール 150% なら論理サイズの 1.5 倍)。
 * logical のときは、表示スケールをかける前の論理サイズ(100% 相当)に縮めて保存する。
 */
export async function captureWindow(
  win: BrowserWindow,
  root: string,
  logical: boolean
): Promise<string> {
  let image = await win.webContents.capturePage()
  if (image.isEmpty()) throw new Error('画面を取得できませんでした(空の画像)')
  if (logical) {
    const [width, height] = win.getContentSize()
    const size = image.getSize()
    if (size.width !== width || size.height !== height) {
      image = image.resize({ width, height, quality: 'best' })
    }
  }
  const png = image.toPNG()
  if (png.length === 0) throw new Error('画像を PNG にできませんでした')
  const path = uniquePath(ensureDir(root), stamp(), '.png')
  writeFileSync(path, png)
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
