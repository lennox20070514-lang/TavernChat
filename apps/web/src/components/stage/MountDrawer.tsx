import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  CharacterComponent,
  ComponentKind,
  MultiCharMode,
  WorldComponent,
} from '@tavern-chat/core'
import { useAppStore } from '../../services/store.ts'
import { resizeImageFileToAvatarDataUrl } from '../../utils/defaultAvatars.ts'
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconEdit,
  IconGlobe,
  IconLayers,
  IconPlus,
  IconSearch,
  IconSliders,
  IconSparkles,
  IconUpload,
} from '../base/icons.tsx'
import styles from './MountDrawer.module.css'

type DrawerKind = 'character' | 'world' | 'rule'

const CATEGORY_META: Array<{
  kind: DrawerKind
  label: string
  shortLabel: string
  dotClass: string
  mountedClass: string
}> = [
  {
    kind: 'character',
    label: '角色卡',
    shortLabel: '角色',
    dotClass: styles.dotChar,
    mountedClass: styles.cardMountedChar,
  },
  {
    kind: 'world',
    label: '世界卡',
    shortLabel: '世界',
    dotClass: styles.dotWorld,
    mountedClass: styles.cardMountedWorld,
  },
  {
    kind: 'rule',
    label: '规则预设',
    shortLabel: '规则',
    dotClass: styles.dotRule,
    mountedClass: styles.cardMountedRule,
  },
]

const MULTI_MODES: Array<{ value: MultiCharMode; label: string }> = [
  { value: 'narrator', label: '联合演绎' },
  { value: 'round_robin', label: '自动轮流' },
  { value: 'manual', label: '手动点名' },
]

const KindIcon = ({ kind }: { kind: ComponentKind }) => {
  switch (kind) {
    case 'character':
      return <IconSparkles size={15} />
    case 'world':
      return <IconGlobe size={15} />
    default:
      return <IconSliders size={15} />
  }
}

const DrawerContent = ({ open }: { open: boolean }) => {
  const [activeKind, setActiveKind] = useState<DrawerKind>('character')
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [povMenuOpen, setPovMenuOpen] = useState(false)
  const [expandedWorlds, setExpandedWorlds] = useState<Record<string, boolean>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const povAvatarFileRef = useRef<HTMLInputElement>(null)
  const povWrapRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const components = useAppStore((s) => s.components)
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const setMountDrawerOpen = useAppStore((s) => s.setMountDrawerOpen)
  const openLibrary = useAppStore((s) => s.openLibrary)
  const openLibraryCreate = useAppStore((s) => s.openLibraryCreate)
  const upsertComponent = useAppStore((s) => s.upsertComponent)
  const toggleMountComponent = useAppStore((s) => s.toggleMountComponent)
  const setMountEnabled = useAppStore((s) => s.setMountEnabled)
  const removeMount = useAppStore((s) => s.removeMount)
  const toggleWorldEntryOverride = useAppStore((s) => s.toggleWorldEntryOverride)
  const updateAuthorsNote = useAppStore((s) => s.updateAuthorsNote)
  const setMultiCharMode = useAppStore((s) => s.setMultiCharMode)
  const setUserCharacter = useAppStore((s) => s.setUserCharacter)
  const clearContextCheckpoints = useAppStore((s) => s.clearContextCheckpoints)
  const insertCharacterGreeting = useAppStore((s) => s.insertCharacterGreeting)
  const importFiles = useAppStore((s) => s.importFiles)
  const showToast = useAppStore((s) => s.showToast)

  useEffect(() => {
    if (searchOpen && open) {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [searchOpen, open])

  useEffect(() => {
    if (!open) {
      setSearchOpen(false)
      setSearch('')
      setPovMenuOpen(false)
    }
  }, [open])

  useEffect(() => {
    if (!povMenuOpen) return
    const onDown = (e: PointerEvent) => {
      if (povWrapRef.current && !povWrapRef.current.contains(e.target as Node)) {
        setPovMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [povMenuOpen])

  const session = sessions.find((s) => s.id === activeSessionId)
  if (!session) return null

  const mountByCompId = new Map(session.mounts.map((m) => [m.componentId, m]))
  const totalActive =
    session.mounts.filter((m) => m.enabled).length + (session.userCharacterId ? 1 : 0)
  const mountedCharCount = session.mounts.filter((m) => m.kind === 'character' && m.enabled).length
  const query = searchOpen ? search.trim().toLowerCase() : ''

  const povCharacters = components
    .filter((c) => c.kind === 'character')
    .sort((a, b) => {
      if (a.id === 'char_builtin_self') return -1
      if (b.id === 'char_builtin_self') return 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
  const povCharacter = povCharacters.find((c) => c.id === session.userCharacterId)

  const applyPovAvatar = async (avatarUrl?: string) => {
    if (!povCharacter) return
    await upsertComponent({ ...povCharacter, avatar: avatarUrl })
    showToast(avatarUrl ? `已更新「${povCharacter.name}」的头像` : `已恢复「${povCharacter.name}」默认头像`, 'success')
  }

  const currentMeta = CATEGORY_META.find((c) => c.kind === activeKind) ?? CATEGORY_META[0]!
  const allInCat = components.filter((c) => {
    if (c.kind !== activeKind) return false
    if (!query) return true
    return (
      c.name.toLowerCase().includes(query) ||
      c.tags.some((t) => t.toLowerCase().includes(query))
    )
  })

  // 已选入本对话的组件置顶展示，方便直观添加或移除
  const sorted = [...allInCat].sort((a, b) => {
    const aMounted = mountByCompId.has(a.id) ? 1 : 0
    const bMounted = mountByCompId.has(b.id) ? 1 : 0
    if (aMounted !== bMounted) return bMounted - aMounted
    return b.updatedAt - a.updatedAt
  })

  const mountedInCat = allInCat.filter((c) => mountByCompId.get(c.id)?.enabled).length

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".png,.json,.jsonl,.charx,.zip,.lorebook,.card"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            void importFiles(e.target.files)
            e.target.value = ''
          }
        }}
      />

      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.title}>对话组件</span>
          <span className={styles.titleCount}>已选 {totalActive}</span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            title="导入酒馆 PNG / JSON 文件"
            onClick={() => fileRef.current?.click()}
          >
            <IconUpload size={15} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="收起右侧组件栏"
            aria-label="收起右侧组件栏"
            onClick={() => setMountDrawerOpen(false)}
          >
            <IconClose size={15} />
          </button>
        </div>
      </div>

      <div className={styles.controls}>
        <div className={styles.tabsBar}>
          <div className={styles.tabs}>
            {CATEGORY_META.map((cat) => {
              const count = session.mounts.filter((m) => m.kind === cat.kind && m.enabled).length
              return (
                <button
                  key={cat.kind}
                  type="button"
                  className={clsx(styles.tab, activeKind === cat.kind && styles.tabActive)}
                  onClick={() => setActiveKind(cat.kind)}
                >
                  {cat.shortLabel}
                  {count > 0 ? ` · ${count}` : ''}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className={clsx(styles.iconBtn, searchOpen && styles.iconBtnActive)}
            title={searchOpen ? '收起搜索' : '搜索组件'}
            aria-label="搜索组件"
            onClick={() => {
              if (searchOpen) setSearch('')
              setSearchOpen(!searchOpen)
            }}
          >
            <IconSearch size={14} />
          </button>
        </div>

        {searchOpen ? (
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>
              <IconSearch size={13} />
            </span>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              placeholder={`筛选${currentMeta.label}名称或标签…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('')
                  setSearchOpen(false)
                }
              }}
            />
            {search ? (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearch('')}
                aria-label="清除筛选"
              >
                <IconClose size={12} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={styles.povBox} ref={povWrapRef}>
        <input
          ref={povAvatarFileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file && povCharacter) {
              void resizeImageFileToAvatarDataUrl(file)
                .then((url) => applyPovAvatar(url))
                .catch(() => showToast('读取头像失败', 'error'))
            }
            e.target.value = ''
          }}
        />
        <div className={styles.povText}>
          <span className={styles.povTitle}>我的视角</span>
          {povCharacter ? (
            <div className={styles.povAvatarActions}>
              <button
                type="button"
                className={styles.povAvatarAction}
                onClick={() => {
                  setPovMenuOpen(false)
                  povAvatarFileRef.current?.click()
                }}
              >
                相册上传头像
              </button>
              {povCharacter.avatar ? (
                <button
                  type="button"
                  className={styles.povAvatarReset}
                  onClick={() => void applyPovAvatar(undefined)}
                >
                  恢复默认
                </button>
              ) : null}
            </div>
          ) : (
            <span className={styles.povHint}>以所选角色卡身份和称呼参与对话</span>
          )}
        </div>

        <div className={styles.povDropdownWrap}>
          <button
            type="button"
            className={styles.povTrigger}
            aria-expanded={povMenuOpen}
            onClick={() => setPovMenuOpen((v) => !v)}
          >
            <span className={styles.povTriggerLeft}>
              {povCharacter?.avatar ? (
                <img className={styles.povMiniAvatar} src={povCharacter.avatar} alt="" />
              ) : (
                <span className={styles.povMiniAvatarFallback}>
                  {(povCharacter?.name || '我').slice(0, 1)}
                </span>
              )}
              <span className={styles.povTriggerName}>
                {povCharacter ? povCharacter.name : '默认用户（不指定角色）'}
              </span>
            </span>
            <IconChevronDown size={14} />
          </button>

          {povMenuOpen ? (
            <div className={styles.povMenu} role="listbox">
              {povCharacters.map((character) => {
                const selected = character.id === povCharacter?.id
                return (
                  <button
                    key={character.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={clsx(styles.povMenuItem, selected && styles.povMenuItemActive)}
                    onClick={() => {
                      void setUserCharacter(character.id)
                      setPovMenuOpen(false)
                    }}
                  >
                    <span className={styles.povTriggerLeft}>
                      {character.avatar ? (
                        <img className={styles.povMiniAvatar} src={character.avatar} alt="" />
                      ) : (
                        <span className={styles.povMiniAvatarFallback}>
                          {character.name.slice(0, 1)}
                        </span>
                      )}
                      <span className={styles.povTriggerName}>{character.name}</span>
                    </span>
                    {selected ? <IconCheck size={13} /> : null}
                  </button>
                )
              })}
              <div className={styles.povMenuDivider} />
              <button
                type="button"
                role="option"
                aria-selected={!povCharacter}
                className={clsx(styles.povMenuItem, !povCharacter && styles.povMenuItemActive)}
                onClick={() => {
                  void setUserCharacter(null)
                  setPovMenuOpen(false)
                }}
              >
                <span className={styles.povTriggerName}>不使用视角角色</span>
                {!povCharacter ? <IconCheck size={13} /> : null}
              </button>
            </div>
          ) : null}
        </div>

        {povCharacter ? (
          <span className={styles.povActive}>
            当前以「{povCharacter.name}」的身份参与对话（可在卡牌库修改头像或设定）。
          </span>
        ) : null}
      </div>

      <div className={styles.body}>
        <div className={styles.sectionTop}>
          <span className={styles.sectionInfo}>
            <span className={clsx(styles.dot, currentMeta.dotClass)} />
            <span>{currentMeta.label}</span>
            <span className={styles.groupStat}>
              {mountedInCat > 0 ? `已选 ${mountedInCat} / ` : ''}
              {allInCat.length}
            </span>
          </span>
          <button
            type="button"
            className={styles.groupAddBtn}
            onClick={() => openLibraryCreate(activeKind)}
          >
            <IconPlus size={12} />
            <span>新建</span>
          </button>
        </div>

        {sorted.length === 0 ? (
          <div className={styles.groupEmpty}>
            <span>{query ? '无匹配组件' : `暂无${currentMeta.label}`}</span>
            {!query ? (
              <button
                type="button"
                className={styles.addChip}
                onClick={() => openLibraryCreate(activeKind)}
              >
                <IconPlus size={11} />
                <span>创建</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className={styles.groupList}>
            {sorted.map((item) => {
              const mount = mountByCompId.get(item.id)
              const isMounted = Boolean(mount)
              const isPaused = Boolean(mount && !mount.enabled)
              const isPov = item.kind === 'character' && session.userCharacterId === item.id
              const desc =
                item.kind === 'character'
                  ? (item as CharacterComponent).payload.description || '角色设定'
                  : item.kind === 'world'
                    ? `${(item as WorldComponent).payload.entries.length} 条设定`
                    : item.payload.description || currentMeta.label

              return (
                <div
                  key={item.id}
                  className={clsx(
                    styles.card,
                    isMounted && styles.cardMounted,
                    isMounted && currentMeta.mountedClass,
                    isPaused && styles.cardPaused,
                    isPov && styles.cardPov
                  )}
                >
                  <div className={styles.cardRow}>
                    {isMounted ? (
                      <input
                        type="checkbox"
                        checked={!isPaused}
                        title={isPaused ? '恢复生效' : '暂时停用（保留在列表）'}
                        onChange={(e) => void setMountEnabled(item.id, e.target.checked)}
                      />
                    ) : null}

                    {item.avatar ? (
                      <img className={styles.avatar} src={item.avatar} alt="" />
                    ) : (
                      <span className={styles.avatar}>
                        <KindIcon kind={item.kind} />
                      </span>
                    )}

                    <div
                      className={styles.cardInfo}
                      onClick={() =>
                        isMounted || isPov
                          ? openLibrary(item.kind, item.id)
                          : void toggleMountComponent(item.id)
                      }
                    >
                      <div className={styles.cardName}>{item.name}</div>
                      <div className={styles.cardDesc}>{desc}</div>
                    </div>

                    <div className={styles.cardOps}>
                      <button
                        type="button"
                        className={styles.opIcon}
                        title="编辑卡牌"
                        onClick={() => openLibrary(item.kind, item.id)}
                      >
                        <IconEdit size={13} />
                      </button>
                      {isPov ? (
                        <span className={styles.povBadge}>我的视角</span>
                      ) : isMounted ? (
                        <button
                          type="button"
                          className={styles.removeChip}
                          title="从当前对话移除"
                          onClick={() => void removeMount(item.id)}
                        >
                          <IconClose size={11} />
                          <span>移除</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={styles.addChip}
                          title="添加到当前对话"
                          onClick={() => void toggleMountComponent(item.id)}
                        >
                          <IconPlus size={11} />
                          <span>添加</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 已选入角色卡：提供一键插入开场白 */}
                  {isMounted && !isPaused && item.kind === 'character' ? (() => {
                    const char = item as CharacterComponent
                    const greetings = [
                      char.payload.firstMessage,
                      ...char.payload.alternateGreetings,
                    ].filter((g) => g.trim())
                    if (greetings.length === 0) return null
                    return (
                      <div className={styles.subSection}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                          {greetings.map((_g, idx) => (
                            <button
                              key={idx}
                              type="button"
                              className={styles.smallBtn}
                              onClick={() => void insertCharacterGreeting(char.id, idx)}
                            >
                              插入开场白{greetings.length > 1 ? ` #${idx + 1}` : ''}
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })() : null}

                  {/* 已选入世界卡：可折叠按条临时开关（不污染卡牌库母版） */}
                  {isMounted && !isPaused && item.kind === 'world' ? (() => {
                    const world = item as WorldComponent
                    if (world.payload.entries.length === 0) return null
                    const expanded = Boolean(expandedWorlds[world.id])
                    const disabledSet = new Set(mount?.disabledWorldEntryIds ?? [])
                    const activeEntries = world.payload.entries.filter(
                      (e) => e.enabled && !disabledSet.has(e.id)
                    ).length
                    return (
                      <div className={styles.subSection}>
                        <button
                          type="button"
                          className={styles.groupToggle}
                          style={{ fontSize: 11.5, padding: 0 }}
                          onClick={() =>
                            setExpandedWorlds((prev) => ({
                              ...prev,
                              [world.id]: !prev[world.id],
                            }))
                          }
                        >
                          {expanded ? (
                            <IconChevronDown size={12} />
                          ) : (
                            <IconChevronRight size={12} />
                          )}
                          <span>
                            条目细调（{activeEntries}/{world.payload.entries.length} 生效）
                          </span>
                        </button>
                        {expanded
                          ? world.payload.entries.map((entry) => {
                              const active = entry.enabled && !disabledSet.has(entry.id)
                              return (
                                <label key={entry.id} className={styles.entryRow}>
                                  <span
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 6,
                                      minWidth: 0,
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={active}
                                      disabled={!entry.enabled}
                                      onChange={() =>
                                        void toggleWorldEntryOverride(world.id, entry.id)
                                      }
                                    />
                                    <span
                                      style={{
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        opacity: active ? 1 : 0.45,
                                      }}
                                    >
                                      {entry.name}
                                    </span>
                                  </span>
                                  <span className={styles.entryTag}>
                                    {entry.constant ? '蓝灯常驻' : `${entry.keys.length} 词`}
                                  </span>
                                </label>
                              )
                            })
                          : null}
                      </div>
                    )
                  })() : null}
                </div>
              )
            })}
          </div>
        )}

        {mountedCharCount >= 2 ? (
          <div className={styles.noteBox}>
            <div className={styles.sectionLabel}>
              <span>多角色协同模式（{mountedCharCount} 位在场）</span>
            </div>
            <div className={styles.modeGroup}>
              {MULTI_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={clsx(
                    styles.modeBtn,
                    session.multiCharMode === m.value && styles.modeBtnActive
                  )}
                  onClick={() => void setMultiCharMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.noteBox}>
          <div className={styles.sectionLabel}>
            <span>本对话剧情便签（Author&apos;s Note）</span>
            <span style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}>
              深度 {session.authorsNoteDepth}
            </span>
          </div>
          <textarea
            className={styles.textarea}
            placeholder="仅对当前对话生效，例如：氛围、主线方向或字数风格要求……"
            value={session.authorsNote}
            onChange={(e) => void updateAuthorsNote(e.target.value)}
          />
        </div>

        {session.contextCheckpoints?.length ? (
          <div className={styles.noteBox}>
            <div className={styles.sectionLabel}>
              <span>上下文记忆</span>
              <button
                type="button"
                className={styles.smallBtn}
                onClick={() => void clearContextCheckpoints(session.id)}
              >
                清除
              </button>
            </div>
            <div className={styles.povHint} style={{ textAlign: 'left' }}>
              已把 {session.contextCheckpoints.at(-1)?.coveredRounds ?? 0} 轮早期对话压缩成结构化记忆；
              原始消息仍保留在本地。
            </div>
          </div>
        ) : null}
      </div>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.footerBtn}
          onClick={() => openLibrary(activeKind)}
        >
          <IconLayers size={14} />
          <span>打开完整卡牌库</span>
        </button>
      </div>
    </>
  )
}

export const MountDrawer = ({ isMobile }: { isMobile: boolean }) => {
  const open = useAppStore((s) => s.mountDrawerOpen)
  const setOpen = useAppStore((s) => s.setMountDrawerOpen)

  useEffect(() => {
    if (!isMobile || !open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [isMobile, open])

  if (isMobile) {
    return createPortal(
      <div
        className={clsx(styles.mobileBackdrop, open && styles.mobileBackdropOpen)}
        aria-hidden={!open}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setOpen(false)
        }}
      >
        <div className={clsx(styles.mobileSheet, open && styles.mobileSheetOpen)}>
          <DrawerContent open={open} />
        </div>
      </div>,
      document.body
    )
  }

  return (
    <aside
      className={clsx(styles.panel, open && styles.panelOpen)}
      aria-hidden={!open}
    >
      <div className={styles.panelInner}>
        <DrawerContent open={open} />
      </div>
    </aside>
  )
}
