import { spawn, spawnSync, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import { randomBytes } from 'crypto'
import { app } from 'electron'

/**
 * Python バックエンド（FastAPI / uvicorn）の起動・死活監視・終了を管理する。
 *
 * 方針:
 * - 開発時は <projectRoot>/backend/.venv の Python を使う。無ければ py / python へフォールバック。
 * - localhost の空きポートを選び、uvicorn に --port で渡す。
 * - /api/health が応答するまでポーリングして起動完了を待つ。
 */
export class BackendProcess {
  private proc: ChildProcess | null = null
  private port = 0
  /** API の合言葉。起動ごとに作り、環境変数でバックエンドへ渡す(無関係なページからの呼び出しを防ぐ)。 */
  readonly token = randomBytes(24).toString('hex')
  /** 明示的に stop() で止めている最中か(この間の exit は異常終了として通知しない)。 */
  private stopping = false
  /** バックエンドが予期せず終了したときの通知先(レンダラへ知らせる)。 */
  onUnexpectedExit: ((code: number | null) => void) | null = null

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get currentPort(): number {
    return this.port
  }

  private get backendDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'backend')
      : join(app.getAppPath(), 'backend')
  }

  /** venv の Python を優先し、無ければ system の python を返す。 */
  private resolvePython(): string {
    const venvPython =
      process.platform === 'win32'
        ? join(this.backendDir, '.venv', 'Scripts', 'python.exe')
        : join(this.backendDir, '.venv', 'bin', 'python')
    if (existsSync(venvPython)) return venvPython
    return process.platform === 'win32' ? 'py' : 'python3'
  }

  /** OS に空きポートを 1 つ割り当ててもらう。 */
  private async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer()
      srv.unref()
      srv.on('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        if (addr && typeof addr === 'object') {
          const p = addr.port
          srv.close(() => resolve(p))
        } else {
          srv.close(() => reject(new Error('ポート取得に失敗しました')))
        }
      })
    })
  }

  get isRunning(): boolean {
    return this.proc !== null
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.stopping = false
    this.port = await this.findFreePort()
    const python = this.resolvePython()

    const args =
      python === 'py'
        ? ['-3', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.port)]
        : ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(this.port)]

    this.proc = spawn(python, args, {
      cwd: this.backendDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1', BOOK_VIEWER_TOKEN: this.token }
    })

    this.proc.stdout?.on('data', (d) => console.log(`[backend] ${String(d).trimEnd()}`))
    this.proc.stderr?.on('data', (d) => console.error(`[backend] ${String(d).trimEnd()}`))
    // 'error' リスナーが無いと spawn 失敗(python が見つからない等)が
    // uncaughtException になりメインプロセスごと落ちる。
    this.proc.on('error', (err) => {
      console.error('[backend] 起動に失敗:', err)
      this.proc = null
    })
    let started = false
    this.proc.on('exit', (code) => {
      console.log(`[backend] exited with code ${code}`)
      this.proc = null
      // 起動待ちの間の終了は waitForHealth 側で失敗にする。起動後の落ちだけ通知する。
      if (!this.stopping && started) this.onUnexpectedExit?.(code)
    })

    await this.waitForHealth()
    started = true
  }

  /** 落ちたバックエンドを起動し直す(ポートは取り直す)。 */
  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  private async waitForHealth(timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // プロセスが既に死んでいたら待っても無駄なので即失敗させる。
      if (!this.proc) {
        throw new Error('バックエンドプロセスが起動できませんでした')
      }
      try {
        const res = await fetch(`${this.baseUrl}/api/health`)
        if (res.ok) return
      } catch {
        // まだ起動していない
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('バックエンドの起動確認がタイムアウトしました')
  }

  async stop(): Promise<void> {
    this.stopping = true
    // 先に llama-server を停止する(Windows では子プロセスが孤立して残るため)。
    try {
      await fetch(`${this.baseUrl}/api/llm/unload`, {
        method: 'POST',
        headers: { 'X-Book-Viewer-Token': this.token },
        signal: AbortSignal.timeout(4000)
      })
    } catch {
      // バックエンドが既に落ちている等は無視
    }
    if (this.proc) {
      if (process.platform === 'win32' && this.proc.pid) {
        // Windows の kill() は直接の子だけを終了する。py ランチャー経由などで
        // 孫プロセス(python.exe)が残らないよう、プロセスツリーごと終了する。
        spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'])
      } else {
        this.proc.kill()
      }
      this.proc = null
    }
  }
}
