import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// 設定の読み込み(IPC)を待つ間に黒で一瞬描かれないよう、前回のテーマを先に当てておく。
try {
  const theme = localStorage.getItem('appTheme')
  if (theme) document.documentElement.dataset.theme = theme
} catch {
  // 読めなければ既定(黒)のまま
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
