import clsx from 'clsx'
import { useMemo, useState } from 'react'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  IconClose,
  IconGlobe,
  IconLayers,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTrash,
} from '../base/icons.tsx'
import { HighlightText } from '../chat/MarkdownText.tsx'
import styles from './Sider.module.css'

function extractSnippet(text: string, query: string): string {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  if (idx < 0) return text.slice(0, 36)
  const start = Math.max(0, idx - 10)
  const end = Math.min(text.length, idx + query.length + 24)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`
}

const SiderInner = ({ mobile }: { mobile: boolean }) => {
  const [search, setSearch] = useState('')

  const sessions = useAppStore((s) => s.sessions)
  const components = useAppStore((s) => s.components)
  const messagesBySession = useAppStore((s) => s.messagesBySession)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const createSession = useAppStore((s) => s.createSession)
  const selectSession = useAppStore((s) => s.selectSession)
  const openSessionWithSearch = useAppStore((s) => s.openSessionWithSearch)
  const loadAllMessagesForSearch = useAppStore((s) => s.loadAllMessagesForSearch)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const openLibrary = useAppStore((s) => s.openLibrary)
  const setMarketOpen = useAppStore((s) => s.setMarketOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setMobileSiderOpen = useAppStore((s) => s.setMobileSiderOpen)
  const setSiderCollapsed = useSettings((s) => s.setSiderCollapsed)

  const compMap = useMemo(() => new Map(components.map((c) => [c.id, c])), [components])
  const trimmedQuery = search.trim()
  const lowerQuery = trimmedQuery.toLowerCase()

  const filteredSessions = useMemo(() => {
    return sessions
      .map((session) => {
        const mountedNames = session.mounts
          .filter((m) => m.enabled)
          .map((m) => compMap.get(m.componentId)?.name)
          .filter((n): n is string => Boolean(n))

        if (!lowerQuery) {
          return { session, mountedNames, matchedSnippet: null as string | null }
        }

        const titleHit = session.title.toLowerCase().includes(lowerQuery)
        const mountHit = mountedNames.some((n) => n.toLowerCase().includes(lowerQuery))
        const msgs = messagesBySession[session.id] ?? []
        const hitMsg = msgs.find((m) =>
          `${m.speakerName ?? ''}\n${m.content}`.toLowerCase().includes(lowerQuery)
        )

        if (!titleHit && !mountHit && !hitMsg) {
          return null
        }

        return {
          session,
          mountedNames,
          matchedSnippet: hitMsg ? extractSnippet(hitMsg.content, trimmedQuery) : null,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }, [sessions, compMap, lowerQuery, trimmedQuery, messagesBySession])

  return (
    <aside className={styles.sider}>
      <div className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>T</span>
          <span>TavernChat</span>
        </div>
        <button
          type="button"
          className={styles.iconBtn}
          title={mobile ? '关闭侧栏' : '收起侧栏'}
          onClick={() => (mobile ? setMobileSiderOpen(false) : setSiderCollapsed(true))}
        >
          {mobile ? <IconClose /> : <IconSidebar />}
        </button>
      </div>

      <div className={styles.newChatWrap}>
        <button
          type="button"
          className={styles.newChatBtn}
          onClick={() => void createSession()}
        >
          <IconPlus size={15} />
          <span>新建对话</span>
        </button>

        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>
            <IconSearch size={14} />
          </span>
          <input
            className={styles.searchInput}
            placeholder="搜索对话或聊天记录…"
            value={search}
            onFocus={() => void loadAllMessagesForSearch()}
            onChange={(e) => {
              const val = e.target.value
              setSearch(val)
              if (val.trim()) void loadAllMessagesForSearch()
            }}
          />
          {search ? (
            <button
              type="button"
              className={styles.searchClear}
              aria-label="清空搜索"
              onClick={() => setSearch('')}
            >
              <IconClose size={12} />
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.list}>
        {filteredSessions.length === 0 ? (
          <div className={styles.emptySearch}>没有找到包含「{trimmedQuery}」的对话</div>
        ) : (
          filteredSessions.map(({ session, mountedNames, matchedSnippet }) => {
            const active = session.id === activeSessionId
            return (
              <div
                key={session.id}
                className={clsx(styles.sessionItem, active && styles.sessionActive)}
                onClick={() => {
                  if (trimmedQuery && matchedSnippet) {
                    void openSessionWithSearch(session.id, trimmedQuery)
                  } else {
                    void selectSession(session.id)
                  }
                }}
              >
                <div className={styles.sessionMain}>
                  <div className={styles.sessionTitle}>
                    <HighlightText text={session.title} query={trimmedQuery} />
                  </div>
                  {matchedSnippet ? (
                    <div className={styles.searchSnippet}>
                      <HighlightText text={matchedSnippet} query={trimmedQuery} />
                    </div>
                  ) : mountedNames.length > 0 ? (
                    <div className={styles.sessionMeta}>
                      <HighlightText text={mountedNames.join(' · ')} query={trimmedQuery} />
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={styles.deleteBtn}
                  title="删除对话"
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteSession(session.id)
                  }}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            )
          })
        )}
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.footerBtn}
          onClick={() => {
            setMobileSiderOpen(false)
            setMarketOpen(true)
          }}
        >
          <span className={styles.footerLeft}>
            <IconGlobe />
            <span>素材市场</span>
          </span>
          <span className={styles.badge}>免费</span>
        </button>
        <button
          type="button"
          className={styles.footerBtn}
          onClick={() => {
            setMobileSiderOpen(false)
            openLibrary('all')
          }}
        >
          <span className={styles.footerLeft}>
            <IconLayers />
            <span>组件库</span>
          </span>
          <span className={styles.badge}>{components.length}</span>
        </button>
        <button
          type="button"
          className={styles.footerBtn}
          onClick={() => {
            setMobileSiderOpen(false)
            setSettingsOpen(true)
          }}
        >
          <span className={styles.footerLeft}>
            <IconSettings />
            <span>设置</span>
          </span>
        </button>
      </div>
    </aside>
  )
}

export const Sider = () => <SiderInner mobile={false} />

export const MobileSider = () => {
  const open = useAppStore((s) => s.mobileSiderOpen)
  const setOpen = useAppStore((s) => s.setMobileSiderOpen)
  if (!open) return null
  return (
    <div
      className={styles.mobileMask}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      <div className={styles.mobileDrawer}>
        <SiderInner mobile />
      </div>
    </div>
  )
}
