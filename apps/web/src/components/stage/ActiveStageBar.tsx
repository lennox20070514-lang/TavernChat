import clsx from 'clsx'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  IconMenu,
  IconPanelRight,
  IconSearch,
  IconSidebar,
} from '../base/icons.tsx'
import styles from './ActiveStageBar.module.css'

/**
 * 极简对话顶栏：
 * - 对话过程中保持画布纯净，不在顶部铺陈组件胶囊；
 * - 右侧提供「对话内搜索」与「右侧组件栏折叠开关」，平时折叠隐藏，点开即现右侧栏。
 */
export const ActiveStageBar = ({ isMobile }: { isMobile: boolean }) => {
  const siderCollapsed = useSettings((s) => s.siderCollapsed)
  const setSiderCollapsed = useSettings((s) => s.setSiderCollapsed)

  const sessions = useAppStore((s) => s.sessions)
  const components = useAppStore((s) => s.components)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const mountDrawerOpen = useAppStore((s) => s.mountDrawerOpen)
  const setMountDrawerOpen = useAppStore((s) => s.setMountDrawerOpen)
  const chatSearchOpen = useAppStore((s) => s.chatSearchOpen)
  const setChatSearchOpen = useAppStore((s) => s.setChatSearchOpen)
  const setMobileSiderOpen = useAppStore((s) => s.setMobileSiderOpen)

  const session = sessions.find((s) => s.id === activeSessionId)
  const activeCount = session?.mounts.filter((m) => m.enabled).length ?? 0
  const activeCharNames = (session?.mounts ?? [])
    .filter((m) => m.enabled && m.componentId !== session?.userCharacterId)
    .map((m) => components.find((c) => c.id === m.componentId && c.kind === 'character')?.name)
    .filter((n): n is string => Boolean(n))
  const displayTitle =
    activeCharNames.length >= 2 && session?.title === activeCharNames[0]
      ? `群聊（${activeCharNames.length} 人）· ${activeCharNames.slice(0, 2).join('、')}`
      : session?.title || 'TavernChat'

  return (
    <header className={styles.bar}>
      <div className={styles.left}>
        {isMobile ? (
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="打开侧边栏"
            onClick={() => setMobileSiderOpen(true)}
          >
            <IconMenu />
          </button>
        ) : siderCollapsed ? (
          <button
            type="button"
            className={styles.iconBtn}
            title="展开左侧对话栏"
            onClick={() => setSiderCollapsed(false)}
          >
            <IconSidebar />
          </button>
        ) : null}

        <span className={styles.title}>{displayTitle}</span>
      </div>

      <div className={styles.right}>
        <button
          type="button"
          className={clsx(styles.iconBtn, chatSearchOpen && styles.iconBtnActive)}
          title="在对话中搜索 (Ctrl+F)"
          aria-label="在对话中搜索"
          onClick={() => setChatSearchOpen(!chatSearchOpen)}
        >
          <IconSearch size={15} />
        </button>

        <button
          type="button"
          className={clsx(styles.drawerBtn, mountDrawerOpen && styles.drawerBtnActive)}
          title={mountDrawerOpen ? '折叠右侧组件栏' : '展开右侧组件栏（选入 / 移除 / 分类管理）'}
          aria-expanded={mountDrawerOpen}
          onClick={() => setMountDrawerOpen(!mountDrawerOpen)}
        >
          <IconPanelRight size={15} />
          <span>组件</span>
          {activeCount > 0 ? <span className={styles.countBadge}>{activeCount}</span> : null}
        </button>
      </div>
    </header>
  )
}
