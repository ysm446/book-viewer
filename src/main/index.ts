import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import * as os from 'os'
import { exec } from 'child_process'
import { BackendProcess } from './backend'
import { captureWindow, savePages, type SavePageInput } from './screenshot'
import { getSettings, setSettings, type AppSettingsPatch } from './settings'

const backend = new BackendProcess()
let mainWindow: BrowserWindow | null = null

// ── システムリソース監視(CPU / RAM / GPU / VRAM) ───────────────────────────

type CpuSample = Array<{ idle: number; total: number }>

function sampleCpus(): CpuSample {
  return os.cpus().map((cpu) => {
    const total = (Object.values(cpu.times) as number[]).reduce((a, b) => a + b, 0)
    return { idle: cpu.times.idle, total }
  })
}

function computeCpuUsage(prev: CpuSample, curr: CpuSample): number {
  let totalDelta = 0
  let idleDelta = 0
  for (let i = 0; i < prev.length && i < curr.length; i++) {
    totalDelta += curr[i].total - prev[i].total
    idleDelta += curr[i].idle - prev[i].idle
  }
  return totalDelta === 0 ? 0 : (1 - idleDelta / totalDelta) * 100
}

type GpuInfo = { gpuUsage: number | null; vramUsed: number | null; vramTotal: number | null }

let nvidiaSmiAvailable: boolean | null = null

function queryNvidiaSmi(): Promise<GpuInfo> {
  return new Promise((resolve) => {
    const none: GpuInfo = { gpuUsage: null, vramUsed: null, vramTotal: null }
    // タイムアウト時はプロセスを殺す(放置するとハングした nvidia-smi が溜まる)。
    const timeout = setTimeout(() => {
      child.kill()
      resolve(none)
    }, 3000)
    const child = exec(
      'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
      (err, stdout) => {
        clearTimeout(timeout)
        if (err || !stdout) {
          nvidiaSmiAvailable = false
          resolve(none)
          return
        }
        const parts = stdout
          .trim()
          .split(',')
          .map((s) => parseFloat(s.trim()))
        if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
          nvidiaSmiAvailable = true
          resolve({ gpuUsage: parts[0], vramUsed: parts[1], vramTotal: parts[2] })
        } else {
          nvidiaSmiAvailable = false
          resolve(none)
        }
      }
    )
  })
}

let cpuSample: CpuSample = sampleCpus()
let cachedGpuInfo: GpuInfo = { gpuUsage: null, vramUsed: null, vramTotal: null }
let systemResourcesInterval: ReturnType<typeof setInterval> | null = null
let systemResourceSubscribers = 0

function stopSystemResourcePolling(): void {
  if (systemResourcesInterval) clearInterval(systemResourcesInterval)
  systemResourcesInterval = null
}

function startSystemResourcePolling(): void {
  if (systemResourcesInterval) return
  cpuSample = sampleCpus()
  let gpuQueryInFlight = false
  const refreshGpu = (): void => {
    if (gpuQueryInFlight || nvidiaSmiAvailable === false) return
    gpuQueryInFlight = true
    void queryNvidiaSmi().then((info) => {
      cachedGpuInfo = info
      gpuQueryInFlight = false
    })
  }
  refreshGpu()

  systemResourcesInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const prev = cpuSample
    const curr = sampleCpus()
    cpuSample = curr
    const totalMem = os.totalmem()
    refreshGpu()
    mainWindow.webContents.send('system:resources', {
      cpuUsage: Math.round(computeCpuUsage(prev, curr)),
      ramUsed: totalMem - os.freemem(),
      ramTotal: totalMem,
      gpuUsage: cachedGpuInfo.gpuUsage !== null ? Math.round(cachedGpuInfo.gpuUsage) : null,
      vramUsed: cachedGpuInfo.vramUsed,
      vramTotal: cachedGpuInfo.vramTotal
    })
  }, 1000)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Book Viewer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 新規ウィンドウ要求(target=_blank 等)は http/https のみ既定ブラウザで開く。
  // チャット応答(LLM 生成 Markdown)由来のリンクが通るため、file: 等は拒否する。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const proto = new URL(details.url).protocol
      if (proto === 'https:' || proto === 'http:') void shell.openExternal(details.url)
    } catch {
      // 不正な URL は無視
    }
    return { action: 'deny' }
  })

  // ウィンドウ内のページ遷移(リンククリック等)は許可しない(リロードのみ許す)。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault()
  })

  // F9 / F12 はスクリーンショット用に予約する。ページへ渡す前にここで捕まえて
  // preventDefault することで、既定メニューの開発者ツール等に吸われないようにする。
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    if (input.control || input.alt || input.shift || input.meta) return
    if (input.key !== 'F9' && input.key !== 'F12') return
    e.preventDefault()
    mainWindow?.webContents.send('shortcut', input.key === 'F9' ? 'save-pages' : 'capture-window')
  })

  // electron-vite が dev サーバ URL を環境変数で渡す。無ければビルド済み HTML を読む。
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  // バックエンドの接続先をレンダラへ知らせる。
  ipcMain.handle('backend:info', () => ({
    baseUrl: backend.baseUrl,
    port: backend.currentPort,
    token: backend.token
  }))
  // バックエンドが落ちたときにレンダラから起動し直す。失敗は例外のまま返す。
  ipcMain.handle('backend:restart', async () => {
    await backend.restart()
    return { baseUrl: backend.baseUrl, port: backend.currentPort, token: backend.token }
  })
  // システムリソースの通知は、レンダラが表示している間だけ集める(nvidia-smi の起動を無駄にしない)。
  ipcMain.on('system:subscribe', () => {
    systemResourceSubscribers++
    startSystemResourcePolling()
  })
  ipcMain.on('system:unsubscribe', () => {
    systemResourceSubscribers = Math.max(0, systemResourceSubscribers - 1)
    if (systemResourceSubscribers === 0) stopSystemResourcePolling()
  })

  // 管理ルート用フォルダ選択ダイアログ。
  ipcMain.handle('dialog:selectFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '管理ルートにするフォルダを選択'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ファイル選択(llama-server 実行ファイルなど)。
  ipcMain.handle('dialog:selectFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'ファイルを選択'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // 本の取り込み用アーカイブ選択(複数可)。
  ipcMain.handle('dialog:selectArchives', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '取り込む本を選択',
      filters: [{ name: '本(zip / cbz / pdf)', extensions: ['zip', 'cbz', 'pdf'] }]
    })
    return result.canceled ? [] : result.filePaths
  })

  // 設定の取得・更新(data/settings.json)。
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: AppSettingsPatch) => setSettings(patch))

  // スクリーンショット(F12: ウィンドウ / F9: 表示中のページ画像)。
  // 保存先は <管理ルート>/screenshot/。失敗は例外のままレンダラへ返す。
  ipcMain.handle('screenshot:captureWindow', (_e, a: { root: string; title: string }) => {
    if (!mainWindow) throw new Error('ウィンドウがありません')
    return captureWindow(mainWindow, a.root, a.title)
  })
  ipcMain.handle(
    'screenshot:savePages',
    (_e, a: { root: string; title: string; pages: SavePageInput[] }) =>
      savePages(a.root, a.title, a.pages)
  )

  // 保存先をエクスプローラで開く(該当ファイルを選択した状態)。
  ipcMain.handle('shell:showItemInFolder', (_e, path: string) => shell.showItemInFolder(path))
}

// 多重起動を防ぐ(settings.json や library.db の同時書き込みを避ける)。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  registerIpc()
  try {
    await backend.start()
  } catch (err) {
    console.error('バックエンド起動失敗:', err)
  }
  createWindow()
  // レンダラの表示が消えたら購読も終わったものとして扱う(リロード時の取りこぼし対策)。
  mainWindow?.webContents.on('did-start-loading', () => {
    systemResourceSubscribers = 0
    stopSystemResourcePolling()
  })
  backend.onUnexpectedExit = (code) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend:exited', code)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let cleanedUp = false
app.on('will-quit', (e) => {
  if (cleanedUp) return
  // 終了前に llama-server とバックエンドを確実に停止する。
  e.preventDefault()
  cleanedUp = true
  stopSystemResourcePolling()
  backend.stop().finally(() => app.quit())
})
