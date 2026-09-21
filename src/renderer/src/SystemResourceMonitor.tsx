import { useEffect, useState } from 'react'
import type { SystemResources } from '../../preload'

function ResourceBar({ label, pct, detail }: { label: string; pct: number; detail: string }): JSX.Element {
  const clamped = Math.min(100, Math.max(0, pct))
  const color = clamped > 85 ? '#ef4444' : clamped > 65 ? '#f97316' : 'var(--accent)'
  return (
    <div className="res-item">
      <span className="res-label">{label}</span>
      <span className="res-track">
        <span className="res-fill" style={{ width: `${clamped}%`, background: color }} />
      </span>
      <span className="res-detail">{detail}</span>
    </div>
  )
}

/** GB 表示(バイト入力)。1GB 未満は MB。 */
function fmtBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`
}

/** GB 表示(MB 入力。nvidia-smi は MB 単位)。 */
function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
}

/** CPU / RAM / GPU / VRAM の使用状況をステータスバーに表示する。 */
export function SystemResourceMonitor(): JSX.Element | null {
  const [res, setRes] = useState<SystemResources | null>(null)

  useEffect(() => window.api.onSystemResources(setRes), [])

  if (!res) return null

  const hasGpu = res.gpuUsage !== null
  const hasVram = res.vramUsed !== null && res.vramTotal !== null

  return (
    <div className="res-monitor">
      <ResourceBar label="CPU" pct={res.cpuUsage} detail={`${res.cpuUsage}%`} />
      <ResourceBar
        label="RAM"
        pct={(res.ramUsed / res.ramTotal) * 100}
        detail={`${fmtBytes(res.ramUsed)} / ${fmtBytes(res.ramTotal)}`}
      />
      {hasGpu && <ResourceBar label="GPU" pct={res.gpuUsage as number} detail={`${res.gpuUsage}%`} />}
      {hasVram && (
        <ResourceBar
          label="VRAM"
          pct={((res.vramUsed as number) / (res.vramTotal as number)) * 100}
          detail={`${fmtMb(res.vramUsed as number)} / ${fmtMb(res.vramTotal as number)}`}
        />
      )}
    </div>
  )
}
