import { Capacitor } from '@capacitor/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './app/theme.css'
import './app/global.css'
import { App } from './app/App.tsx'

// 仅在 HTTPS / localhost 网页端（含 iOS Safari PWA）注册离线壳 Service Worker，
// Android 原生 Capacitor 与 Electron 桌面端 app:// 协议不注册。
if (
  !Capacitor.isNativePlatform() &&
  !window.tavernDesktop?.isDesktop &&
  'serviceWorker' in navigator &&
  (window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1')
) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  })
}

// 网页端主动向浏览器申请持久化存储，降低 iOS Safari 清理本地 IndexedDB 的概率
if (!Capacitor.isNativePlatform() && !window.tavernDesktop?.isDesktop) {
  void navigator.storage?.persist?.().catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
