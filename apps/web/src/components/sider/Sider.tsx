import clsx from 'clsx'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { ChatSession } from '@tavern-chat/core'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  IconCheck,
  IconClose,
  IconEdit,
  IconGlobe,
  IconLayers,
  IconMore,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTrash,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import { HighlightText } from '../chat/MarkdownText.tsx'
import styles from './Sider.module.css'

const MENU_WIDTH = 188
const MENU_HEIGHT = 202

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
  const [menu, setMenu] = useState<{ session: ChatSession; x: number; y: number } | null>(null)
  const [renameTarget, setRenameTarget] = useState<ChatSession | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const longPressTimer = useRef<number | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const suppressClickUntil = useRef(0)

  const sessions = useAppStore((s) => s.sessions)
  const components = useAppStore((s) => s.components)
  const messagesBySession = useAppStore((s) => s.messagesBySession)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const createSession = useAppStore((s) => s.createSession)
  const selectSession = useAppStore((s) => s.selectSession)
  const openSessionWithSearch = useAppStore((s) => s.openSessionWithSearch)
  const loadAllMessagesForSearch = useAppStore((s) => s.loadAllMessagesForSearch)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const renameSession = useAppStore((s) => s.renameSession)
  const setSessionPinned = useAppStore((s) => s.setSessionPinned)
  const openLibrary = useAppStore((s) => s.openLibrary)
  const setMarketOpen = useAppStore((s) => s.setMarketOpen)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const setMobileSiderOpen = useAppStore((s) => s.setMobileSiderOpen)
  const setSiderCollapsed = useSettings((s) => s.setSiderCollapsed)

  const compMap = useMemo(() => new Map(components.map((c) => [c.id, c])), [components])
  const trimmedQuery = search.trim()
  const lowerQuery = trimmedQuery.toLowerCase()

  const orderedSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt
      ),
    [sessions]
  )

  const filteredSessions = useMemo(() => {
    return orderedSessions
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
  }, [orderedSessions, compMap, lowerQuery, trimmedQuery, messagesBySession])

  const filteredIds = filteredSessions.map(({ session }) => session.id)
  const allSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id))

  useEffect(
    () => () => {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current)
    },
    []
  )

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    pressOrigin.current = null
  }

  const openMenu = (session: ChatSession, x: number, y: number) => {
    suppressClickUntil.current = Date.now() + 700
    setMenu({ session, x, y })
  }

  const handleRowPointerDown = (event: ReactPointerEvent, session: ChatSession) => {
    if (multiSelect || event.button !== 0 || event.pointerType === 'mouse') return
    clearLongPress()
    pressOrigin.current = { x: event.clientX, y: event.clientY }
    longPressTimer.current = window.setTimeout(() => {
      const origin = pressOrigin.current
      if (!origin) return
      navigator.vibrate?.(8)
      openMenu(session, origin.x, origin.y)
      pressOrigin.current = null
      longPressTimer.current = null
    }, 480)
  }

  const handleRowPointerMove = (event: ReactPointerEvent) => {
    const origin = pressOrigin.current
    if (!origin) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
      clearLongPress()
    }
  }

  const handleRowClick = (session: ChatSession, matchedSnippet: string | null) => {
    if (Date.now() < suppressClickUntil.current) return
    if (multiSelect) {
      setSelectedIds((current) => {
        const next = new Set(current)
        if (next.has(session.id)) next.delete(session.id)
        else next.add(session.id)
        return next
      })
      return
    }
    if (trimmedQuery && matchedSnippet) {
      void openSessionWithSearch(session.id, trimmedQuery)
    } else {
      void selectSession(session.id)
    }
  }

  const startRename = (session: ChatSession) => {
    setMenu(null)
    setRenameTarget(session)
    setRenameDraft(session.title)
  }

  const saveRename = () => {
    if (!renameTarget) return
    const title = renameDraft.trim()
    if (!title) return
    void renameSession(renameTarget.id, title)
    setRenameTarget(null)
  }

  const cancelRename = () => setRenameTarget(null)

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(filteredIds))
  }

  const cancelMultiSelect = () => {
    setMultiSelect(false)
    setSelectedIds(new Set())
  }

  const handleBatchDelete = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`删除选中的 ${ids.length} 个对话？此操作不可恢复。`)) return
    for (const id of ids) {
      await deleteSession(id)
    }
    cancelMultiSelect()
  }

  const menuLeft = menu
    ? Math.min(Math.max(8, menu.x), window.innerWidth - MENU_WIDTH - 8)
    : 0
  const menuTop = menu
    ? Math.min(Math.max(8, menu.y), window.innerHeight - MENU_HEIGHT - 8)
    : 0

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

      {multiSelect ? (
        <div className={styles.multiBar}>
          <span className={styles.multiCount}>已选 {selectedIds.size}</span>
          <button type="button" className={styles.multiAction} onClick={toggleSelectAll}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <button
            type="button"
            className={styles.multiDanger}
            disabled={selectedIds.size === 0}
            onClick={() => void handleBatchDelete()}
          >
            删除
          </button>
          <button type="button" className={styles.multiAction} onClick={cancelMultiSelect}>
            取消
          </button>
        </div>
      ) : null}

      <div className={styles.list}>
        {filteredSessions.length === 0 ? (
          <div className={styles.emptySearch}>
            {trimmedQuery ? `没有找到包含「${trimmedQuery}」的对话` : '还没有对话'}
          </div>
        ) : (
          filteredSessions.map(({ session, mountedNames, matchedSnippet }) => {
            const active = session.id === activeSessionId
            const selected = selectedIds.has(session.id)
            return (
              <div
                key={session.id}
                className={clsx(
                  styles.sessionItem,
                  active && styles.sessionActive,
                  multiSelect && styles.sessionSelecting,
                  selected && styles.sessionSelected
                )}
                onClick={() => handleRowClick(session, matchedSnippet)}
                onPointerDown={(event) => handleRowPointerDown(event, session)}
                onPointerMove={handleRowPointerMove}
                onPointerUp={clearLongPress}
                onPointerCancel={clearLongPress}
                onPointerLeave={clearLongPress}
                onContextMenu={(event) => {
                  event.preventDefault()
                  openMenu(session, event.clientX, event.clientY)
                }}
              >
                {multiSelect ? (
                  <span className={clsx(styles.checkbox, selected && styles.checkboxOn)}>
                    {selected ? <IconCheck size={11} /> : null}
                  </span>
                ) : null}
                <div className={styles.sessionMain}>
                  <div className={styles.sessionTitleRow}>
                    {session.pinned ? <IconPin size={11} className={styles.pinMark} /> : null}
                    <span className={styles.sessionTitle}>
                      <HighlightText text={session.title} query={trimmedQuery} />
                    </span>
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
                {!multiSelect ? (
                  <button
                    type="button"
                    className={styles.moreBtn}
                    title="对话操作"
                    aria-label="对话操作"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      openMenu(session, rect.right - MENU_WIDTH, rect.bottom + 4)
                    }}
                  >
                    <IconMore size={14} />
                  </button>
                ) : null}
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
            <span>卡牌市场</span>
          </span>
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
            <span>卡牌库</span>
          </span>
          <span className={styles.badge}>
            {components.filter((component) => component.kind !== 'persona').length}
          </span>
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

      {menu
        ? createPortal(
            <div className={styles.menuOverlay} onPointerDown={() => setMenu(null)}>
              <div
                className={styles.menuCard}
                style={{ left: menuLeft, top: menuTop }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => startRename(menu.session)}
                >
                  <IconEdit size={15} />
                  <span>重命名</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    void setSessionPinned(menu.session.id, !menu.session.pinned)
                    setMenu(null)
                  }}
                >
                  <IconPin size={15} />
                  <span>{menu.session.pinned ? '取消置顶' : '置顶'}</span>
                </button>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    setMultiSelect(true)
                    setSelectedIds(new Set([menu.session.id]))
                    setMenu(null)
                  }}
                >
                  <IconCheck size={15} />
                  <span>多选</span>
                </button>
                <div className={styles.menuSeparator} />
                <button
                  type="button"
                  className={clsx(styles.menuItem, styles.menuDanger)}
                  onClick={() => {
                    const target = menu.session
                    setMenu(null)
                    if (window.confirm(`删除对话「${target.title}」？`)) {
                      void deleteSession(target.id)
                    }
                  }}
                >
                  <IconTrash size={15} />
                  <span>删除</span>
                </button>
              </div>
            </div>,
            document.body
          )
        : null}

      <Modal
        open={renameTarget !== null}
        title="重命名对话"
        size="sm"
        onClose={cancelRename}
      >
        <div className={styles.renameBody}>
          <input
            className={styles.renameInput}
            autoFocus
            value={renameDraft}
            maxLength={60}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveRename()
              if (event.key === 'Escape') cancelRename()
            }}
          />
          <div className={styles.renameActions}>
            <button type="button" className={styles.renameCancel} onClick={cancelRename}>
              取消
            </button>
            <button
              type="button"
              className={styles.renameSave}
              disabled={!renameDraft.trim()}
              onClick={saveRename}
            >
              保存
            </button>
          </div>
        </div>
      </Modal>
    </aside>
  )
}

export const Sider = () => <SiderInner mobile={false} />

export const MobileSider = () => {
  const open = useAppStore((s) => s.mobileSiderOpen)
  const setOpen = useAppStore((s) => s.setMobileSiderOpen)

  useEffect(() => {
    const previous = document.body.style.overflow
    if (open) document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  return createPortal(
    <div
      className={clsx(styles.mobileMask, open && styles.mobileMaskOpen)}
      aria-hidden={!open}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div className={clsx(styles.mobileDrawer, open && styles.mobileDrawerOpen)}>
        <SiderInner mobile />
      </div>
    </div>,
    document.body
  )
}
