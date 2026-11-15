import { useEffect, useRef, useState } from 'react'
import { getTtsStatus, startTts, stopTts, type TtsServerOpts, type TtsStatus } from './api'

/** トップバー右側で、読み上げモデルの常駐状態を切り替える。 */
export function TtsModelBar({ opts }: { opts: TtsServerOpts }): JSX.Element {
  const [status, setStatus] = useState<TtsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changing = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    let alive = true
    let timer = 0
    const poll = async (): Promise<void> => {
      const version = revision.current
      try {
        const next = await getTtsStatus(opts)
        if (alive && !changing.current && version === revision.current) setStatus(next)
      } catch {
        if (alive && !changing.current && version === revision.current) setStatus(null)
      }
      if (alive) timer = window.setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [opts.serverDir, opts.modelsDir, opts.baseUrl])

  async function toggle(): Promise<void> {
    if (!status || changing.current) return
    changing.current = true
    revision.current++
    setBusy(true)
    setError(null)
    try {
      if (status.running) await stopTts()
      else await startTts(opts)
      // stop の返す既定パスではなく、設定した接続先の状態を表示する。
      setStatus(await getTtsStatus(opts))
    } catch (e) {
      setError(String(e))
    } finally {
      changing.current = false
      setBusy(false)
    }
  }

  const loading = busy || status?.starting
  const installing = status?.install?.phase === 'step'
  const unavailable = !status || (!status.installed && !status.running) || status.external || installing
  const failure = error ?? status?.error
  const label = loading ? '切り替え中…' : installing ? '導入中…' : !status ? '状態未取得'
    : status.running ? (status.external ? 'ON（外部）' : 'ON') : !status.installed ? '未導入' : 'OFF'
  const hint = failure ? `${failure}\n設定 → 読み上げで確認してください`
    : !status ? '読み上げサーバーの状態を確認しています'
      : status.external ? '別のアプリで起動したサーバーです。起動元のアプリで停止してください'
        : !status.installed ? '設定 → 読み上げからサーバーをインストールしてください'
          : status.running ? 'TTS を OFF：読み上げとサーバーを停止して VRAM を解放'
            : 'TTS を ON：読み上げモデルを読み込む（再生は本文の「読み上げ」から）'
  return (
    <button
      className={`model-bar tts-model-bar${status?.running ? ' is-on' : ''}${loading ? ' model-bar-loading' : ''}${failure ? ' is-error' : ''}`}
      disabled={Boolean(loading || unavailable)}
      aria-pressed={Boolean(status?.running)}
      aria-busy={Boolean(loading)}
      title={hint}
      onClick={() => void toggle()}
    >
      {loading && <span className="model-spinner" aria-hidden="true" />}
      <span>TTS</span>
      <span>{failure ? 'エラー' : label}</span>
    </button>
  )
}
