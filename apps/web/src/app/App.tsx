import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useEffect, useState } from 'react'
import { ChatWorkspace } from '../components/chat/ChatWorkspace.tsx'
import { LibraryModal } from '../components/library/LibraryModal.tsx'
import { MarketModal } from '../components/market/MarketModal.tsx'
import { SettingsModal } from '../components/settings/SettingsModal.tsx'
import { MobileSider, Sider } from '../components/sider/Sider.tsx'
import { ActiveStageBar } from '../components/stage/ActiveStageBar.tsx'
import { MountDrawer } from '../components/stage/MountDrawer.tsx'
import { PromptPreviewModal } from '../components/stage/PromptPreviewModal.tsx'
import { Toast } from '../components/base/Toast.tsx'
import { applyThemeToDom, useSettings } from '../services/settings.ts'
import { useAppStore } from '../services/store.ts'
import styles from './App.module.css'

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 820
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 819px)')
    const onChange = () => setIsMobile(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isMobile
}

export const App = () => {
  const isMobile = useIsMobile()
  const theme = useSettings((s) => s.theme)
  const siderCollapsed = useSettings((s) => s.siderCollapsed) && !isMobile
  const ready = useAppStore((s) => s.ready)
  const init = useAppStore((s) => s.init)

  useEffect(() => {
    applyThemeToDom(theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onSystemChange = () => {
      if (useSettings.getState().theme === 'system') applyThemeToDom('system')
    }
    mq.addEventListener('change', onSystemChange)
    return () => mq.removeEventListener('change', onSystemChange)
  }, [theme])

  useEffect(() => {
    void init()
  }, [init])

  // 安卓 Capacitor 硬件返回键优雅逐层关闭面板
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cleanup: (() => void) | null = null
    void CapacitorApp.addListener('backButton', () => {
      const s = useAppStore.getState()
      if (s.promptPreviewOpen) return s.setPromptPreviewOpen(false)
      if (s.marketOpen) return s.setMarketOpen(false)
      if (s.settingsOpen) return s.setSettingsOpen(false)
      if (s.libraryOpen) return s.closeLibrary()
      if (s.chatSearchOpen) return s.setChatSearchOpen(false)
      if (s.mountDrawerOpen) return s.setMountDrawerOpen(false)
      if (s.mobileSiderOpen) return s.setMobileSiderOpen(false)
      void CapacitorApp.minimizeApp()
    }).then((h) => {
      cleanup = () => void h.remove()
    })
    return () => cleanup?.()
  }, [])

  if (!ready) {
    return <div className={styles.loading}>正在初始化 TavernChat 本地空间…</div>
  }

  return (
    <div className={styles.frame}>
      {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
      <div className={styles.main}>
        <ActiveStageBar isMobile={isMobile} />
        <div className={styles.body}>
          <ChatWorkspace />
          <MountDrawer isMobile={isMobile} />
        </div>
      </div>

      <LibraryModal />
      <MarketModal />
      <SettingsModal />
      <PromptPreviewModal />
      <Toast />
    </div>
  )
}
