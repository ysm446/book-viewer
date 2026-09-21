import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SystemResources {
  cpuUsage: number
  ramUsed: number
  ramTotal: number
  gpuUsage: number | null
  vramUsed: number | null
  vramTotal: number | null
}

export interface AppSettings {
  pageMode: 'single' | 'double'
  singleWhenLandscape: boolean
  coverAlone: boolean
  defaultDirection: 'rtl' | 'ltr'
  pageTransition: 'none' | 'slide' | 'fade'
  recentRoots: string[]
  lastWorkId: string | null
  transcribeEngine: 'yomitoku' | 'vlm'
  llm: {
    baseUrl: string
    model: string
    serverPath: string
    modelsDir: string
    ctxSize: number
    thinkingEnabled: boolean
    chatSystemPrompt: string
    chatDynamicSuggestions: boolean
  }
}

/** F9 で保存する 1 枚ぶんの入力(バイト列はレンダラが backend から取得したもの)。 */
export interface SavePageInput {
  /** 0 始まりのページ番号。 */
  index: number
  mediaType: string
  data: Uint8Array
}

/** main が横取りしたキー(F9 / F12)の通知名。 */
export type ShortcutName = 'save-pages' | 'capture-window'

/** 設定の部分更新パッチ。llm はネストごと部分更新できる(main 側で深いマージ)。 */
export type AppSettingsPatch = Partial<Omit<AppSettings, 'llm'>> & {
  llm?: Partial<AppSettings['llm']>
}

/** レンダラへ公開する安全な API。 */
const api = {
  /** バックエンド(FastAPI)の接続先を取得する。 */
  getBackendInfo: (): Promise<{ baseUrl: string; port: number }> =>
    ipcRenderer.invoke('backend:info'),
  /** 管理ルート用フォルダ選択ダイアログを開く。キャンセル時は null。 */
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFolder'),
  /** ファイル選択ダイアログを開く。キャンセル時は null。 */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectFile'),
  /** 取り込むアーカイブ(zip / cbz / pdf)を複数選択する。キャンセル時は空配列。 */
  selectArchives: (): Promise<string[]> => ipcRenderer.invoke('dialog:selectArchives'),
  /** ドラッグ&ドロップされた File の実パスを返す(Electron 32 以降 File.path が無いため)。 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 設定(data/settings.json)を取得する。 */
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  /** 設定を部分更新し、更新後の全体を返す。 */
  setSettings: (patch: AppSettingsPatch): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:set', patch),
  /** システムリソース(CPU/RAM/GPU/VRAM)の定期通知を購読する。戻り値で解除。 */
  onSystemResources: (callback: (payload: SystemResources) => void): (() => void) => {
    const listener = (_e: unknown, payload: SystemResources): void => callback(payload)
    ipcRenderer.on('system:resources', listener)
    return () => ipcRenderer.off('system:resources', listener)
  },
  /** ウィンドウのコンテンツ領域を PNG で保存し、保存先パスを返す(F12)。 */
  captureWindow: (root: string, title: string): Promise<string> =>
    ipcRenderer.invoke('screenshot:captureWindow', { root, title }),
  /** 表示中のページ画像を無加工で保存し、保存先パスを順に返す(F9)。 */
  savePageImages: (root: string, title: string, pages: SavePageInput[]): Promise<string[]> =>
    ipcRenderer.invoke('screenshot:savePages', { root, title, pages }),
  /** 保存先をエクスプローラで開く(該当ファイルを選択した状態)。 */
  showItemInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', path),
  /** main が横取りしたキー(F9 / F12)の通知を購読する。戻り値で解除。 */
  onShortcut: (callback: (name: ShortcutName) => void): (() => void) => {
    const listener = (_e: unknown, name: ShortcutName): void => callback(name)
    ipcRenderer.on('shortcut', listener)
    return () => ipcRenderer.off('shortcut', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
