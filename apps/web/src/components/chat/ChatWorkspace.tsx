import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  resolveGroupChatConfig,
  type CharacterComponent,
  type ChatMessage,
} from '@tavern-chat/core'
import { getActiveProvider, useSettings } from '../../services/settings.ts'
import {
  getMessageSiblings,
  resolveActivePath,
  useAppStore,
} from '../../services/store.ts'
import {
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconCopy,
  IconEdit,
  IconEye,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSend,
  IconSettings,
  IconStop,
  IconTrash,
  IconUpload,
} from '../base/icons.tsx'
import { HighlightText, MarkdownText } from './MarkdownText.tsx'
import { copyTextToClipboard } from '../../utils/clipboard.ts'
import styles from './ChatWorkspace.module.css'

export const ChatWorkspace = () => {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const components = useAppStore((s) => s.components)
  const messagesBySession = useAppStore((s) => s.messagesBySession)
  const streamingBySession = useAppStore((s) => s.streamingBySession)
  const activeGroupRoundBySession = useAppStore((s) => s.activeGroupRoundBySession)
  const compactingBySession = useAppStore((s) => s.compactingBySession)

  const sendMessage = useAppStore((s) => s.sendMessage)
  const triggerGroupRound = useAppStore((s) => s.triggerGroupRound)
  const stopStreaming = useAppStore((s) => s.stopStreaming)
  const regenerateMessage = useAppStore((s) => s.regenerateMessage)
  const continueLastMessage = useAppStore((s) => s.continueLastMessage)
  const updateGroupConfig = useAppStore((s) => s.updateGroupConfig)
  const editMessage = useAppStore((s) => s.editMessage)
  const deleteMessage = useAppStore((s) => s.deleteMessage)
  const switchMessageBranch = useAppStore((s) => s.switchMessageBranch)
  const previewCurrentPrompt = useAppStore((s) => s.previewCurrentPrompt)
  const setPromptPreviewOpen = useAppStore((s) => s.setPromptPreviewOpen)
  const setMountDrawerOpen = useAppStore((s) => s.setMountDrawerOpen)
  const chatSearchOpen = useAppStore((s) => s.chatSearchOpen)
  const setChatSearchOpen = useAppStore((s) => s.setChatSearchOpen)
  const searchQuery = useAppStore((s) => s.chatSearchQuery)
  const setSearchQuery = useAppStore((s) => s.setChatSearchQuery)
  const openLibrary = useAppStore((s) => s.openLibrary)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const importFiles = useAppStore((s) => s.importFiles)
  const showToast = useAppStore((s) => s.showToast)

  const settings = useSettings()
  const activeProvider = getActiveProvider(settings)

  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [modelPopOpen, setModelPopOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [searchMatchCursor, setSearchMatchCursor] = useState(0)
  const [autoCountdown, setAutoCountdown] = useState<number | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const msgNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const session = sessions.find((s) => s.id === activeSessionId)
  const allMessages = useMemo(
    () => (activeSessionId ? (messagesBySession[activeSessionId] ?? []) : []),
    [activeSessionId, messagesBySession]
  )
  const activePath = useMemo(
    () => (session ? resolveActivePath(allMessages, session.activeLeafId) : []),
    [allMessages, session]
  )

  const streaming = activeSessionId ? Boolean(streamingBySession[activeSessionId]) : false
  const groupRoundActive = activeSessionId
    ? Boolean(activeGroupRoundBySession[activeSessionId])
    : false
  const isBusy = streaming || groupRoundActive
  const compacting = activeSessionId ? compactingBySession[activeSessionId] : undefined

  const activeChars = useMemo(() => {
    if (!session) return []
    const map = new Map(components.map((c) => [c.id, c]))
    return session.mounts
      .filter((m) => m.enabled && m.kind === 'character' && m.componentId !== session.userCharacterId)
      .sort((a, b) => a.order - b.order)
      .map((m) => map.get(m.componentId))
      .filter((c): c is CharacterComponent => Boolean(c && c.kind === 'character'))
  }, [session, components])

  const charMountMap = useMemo(
    () => new Map((session?.mounts ?? []).map((m) => [m.componentId, m])),
    [session?.mounts]
  )
  const groupCfg = useMemo(
    () => (session ? resolveGroupChatConfig(session) : undefined),
    [session]
  )
  const visibleGroupChars = useMemo(
    () =>
      groupCfg?.hideMuted
        ? activeChars.filter((c) => !charMountMap.get(c.id)?.muted)
        : activeChars,
    [activeChars, charMountMap, groupCfg?.hideMuted]
  )

  const povCharacter = useMemo(() => {
    if (!session?.userCharacterId) return undefined
    const found = components.find(
      (c) => c.id === session.userCharacterId && c.kind === 'character'
    )
    return found as CharacterComponent | undefined
  }, [session?.userCharacterId, components])

  const tokenEstimate = useMemo(() => {
    const assembled = previewCurrentPrompt(activeChars[0]?.id)
    return assembled?.totalTokens ?? 0
  }, [previewCurrentPrompt, activeChars, session, activePath, components])

  const canAutoContinue = Boolean(
    session &&
      activeChars.length >= 2 &&
      groupCfg?.autoMode &&
      !isBusy &&
      !compacting &&
      activePath.length > 0 &&
      !draft.trim() &&
      session.multiCharMode !== 'manual' &&
      session.multiCharMode !== 'narrator' &&
      activeChars.some((c) => !charMountMap.get(c.id)?.muted)
  )

  useEffect(() => {
    if (!canAutoContinue || !groupCfg) {
      setAutoCountdown(null)
      return
    }
    const totalSec = Math.max(2, groupCfg.autoModeDelaySec || 4)
    setAutoCountdown(totalSec)
    const timer = window.setInterval(() => {
      setAutoCountdown((prev) => {
        if (prev === null) return null
        if (prev <= 1) {
          window.clearInterval(timer)
          void triggerGroupRound({ isAutoContinuation: true })
          return null
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [
    canAutoContinue,
    groupCfg?.autoModeDelaySec,
    activePath.length,
    session?.id,
    triggerGroupRound,
  ])

  const normalizedQuery = chatSearchOpen ? searchQuery.trim().toLowerCase() : ''
  const matchedMessageIds = useMemo(() => {
    if (!normalizedQuery) return []
    return activePath
      .filter((m) => {
        const hay = `${m.speakerName ?? ''}\n${m.content}\n${m.reasoning ?? ''}`.toLowerCase()
        return hay.includes(normalizedQuery)
      })
      .map((m) => m.id)
  }, [activePath, normalizedQuery])

  const activeMatchMessageId =
    matchedMessageIds.length > 0
      ? matchedMessageIds[searchMatchCursor % matchedMessageIds.length]
      : null

  // 打开搜索框时自动聚焦
  useEffect(() => {
    if (chatSearchOpen) {
      setSearchMatchCursor(0)
      requestAnimationFrame(() => searchInputRef.current?.focus())
    } else {
      setSearchMatchCursor(0)
    }
  }, [chatSearchOpen, activeSessionId])

  // Ctrl/Cmd + F 呼出对话内搜索
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const state = useAppStore.getState()
        if (state.libraryOpen || state.settingsOpen || state.promptPreviewOpen) return
        e.preventDefault()
        setChatSearchOpen(true)
        requestAnimationFrame(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setChatSearchOpen])

  // 滚动定位到当前高亮命中的消息
  useEffect(() => {
    if (!activeMatchMessageId) return
    const node = msgNodeRefs.current.get(activeMatchMessageId)
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeMatchMessageId, searchMatchCursor])

  const stepSearchMatch = (delta: number) => {
    if (matchedMessageIds.length === 0) return
    setSearchMatchCursor(
      (prev) => (prev + delta + matchedMessageIds.length) % matchedMessageIds.length
    )
  }

  useEffect(() => {
    if (chatSearchOpen && normalizedQuery) return
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [activePath.length, streaming, chatSearchOpen, normalizedQuery])

  // 自动调节输入框高度
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [draft])

  const handleSend = () => {
    if (isBusy) {
      stopStreaming()
      return
    }
    const text = draft.trim()
    // 允许空白输入时若已有消息也直接驱动下一轮互动
    if (!text && activePath.length === 0) return
    setDraft('')
    void sendMessage(text)
  }

  const handleCopy = async (content: string) => {
    const ok = await copyTextToClipboard(content)
    showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error')
  }

  const renderMessage = (msg: ChatMessage, idx: number) => {
    const isUser = msg.role === 'user'
    const siblings = getMessageSiblings(allMessages, msg)
    const sibIndex = siblings.findIndex((s) => s.id === msg.id)
    const isEditing = editingId === msg.id
    const isLast = idx === activePath.length - 1
    const isActiveMatch = activeMatchMessageId === msg.id
    const hl = chatSearchOpen ? searchQuery.trim() : undefined

    return (
      <div
        key={msg.id}
        ref={(el) => {
          if (el) msgNodeRefs.current.set(msg.id, el)
          else msgNodeRefs.current.delete(msg.id)
        }}
        className={clsx(styles.msgRow, isUser && styles.msgRowUser, isActiveMatch && styles.msgRowHit)}
      >
        {!isUser ? (() => {
          const matchedChar =
            (msg.speakerId
              ? components.find((c) => c.id === msg.speakerId && c.kind === 'character')
              : undefined) ??
            (msg.speakerName
              ? components.find((c) => c.kind === 'character' && c.name === msg.speakerName)
              : undefined) ??
            (activeChars.length === 1 ? activeChars[0] : undefined)
          const avatarSrc = matchedChar?.avatar || msg.speakerAvatar
          const avatarLabel = (matchedChar?.name || msg.speakerName || 'A').slice(0, 1)
          const avatarNode = avatarSrc ? (
            <img className={styles.msgAvatar} src={avatarSrc} alt="" />
          ) : (
            <div className={styles.msgAvatar}>{avatarLabel}</div>
          )
          return matchedChar ? (
            <button
              type="button"
              className={styles.msgAvatarBtn}
              title={`查看「${matchedChar.name}」设定详情`}
              onClick={() => openLibrary('character', matchedChar.id)}
            >
              {avatarNode}
            </button>
          ) : (
            avatarNode
          )
        })() : null}

        <div className={clsx(styles.msgBody, isUser && styles.msgBodyUser)}>
          {!isUser ? (
            <div className={styles.msgHeader}>
              <span className={styles.speakerName}>
                <HighlightText text={msg.speakerName || 'AI'} query={hl} />
              </span>
              {msg.triggeredWorld && msg.triggeredWorld.length > 0 ? (
                <span
                  className={styles.worldTag}
                  title={msg.triggeredWorld
                    .map((w) => `${w.worldName}·${w.entryName}`)
                    .join(' / ')}
                  onClick={() => setPromptPreviewOpen(true)}
                >
                  世界书 ×{msg.triggeredWorld.length}
                </span>
              ) : null}
            </div>
          ) : null}

          {!isUser && msg.reasoning ? (
            <details
              className={styles.reasoningBox}
              open={Boolean(hl && msg.reasoning.toLowerCase().includes(hl.toLowerCase())) || undefined}
            >
              <summary className={styles.reasoningSummary}>深度思考过程</summary>
              <div className={styles.reasoningText}>
                <HighlightText text={msg.reasoning} query={hl} />
              </div>
            </details>
          ) : null}

          {isEditing ? (
            <div className={styles.editBox}>
              <textarea
                className={styles.editTextarea}
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className={styles.actionPill}
                  onClick={() => {
                    void editMessage(msg.id, editingText)
                    setEditingId(null)
                  }}
                >
                  保存修改
                </button>
                <button
                  type="button"
                  className={styles.miniBtn}
                  onClick={() => setEditingId(null)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : isUser ? (
            <div className={styles.userBubble}>
              <HighlightText text={msg.content} query={hl} />
            </div>
          ) : (
            <div className={styles.assistantContent}>
              {msg.content ? (
                <>
                  <MarkdownText content={msg.content} highlightQuery={hl} />
                  {/API Key|接口地址/i.test(msg.content) && msg.content.includes('⚠️ 请求失败') ? (
                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className={styles.actionPill}
                        onClick={() => setSettingsOpen(true)}
                      >
                        <IconSettings size={13} />
                        <span>前往设置填写 API Key</span>
                      </button>
                    </div>
                  ) : null}
                </>
              ) : streaming && isLast ? (
                <span className={styles.typingDot} />
              ) : null}
            </div>
          )}

          {!isEditing && !(streaming && isLast && !isUser) ? (
            <div className={styles.msgActions}>
              {siblings.length > 1 ? (
                <span className={styles.swipeControl}>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    disabled={sibIndex <= 0}
                    onClick={() => void switchMessageBranch(siblings[sibIndex - 1]!.id)}
                    aria-label="上一版本"
                  >
                    <IconChevronLeft size={13} />
                  </button>
                  <span>
                    {sibIndex + 1}/{siblings.length}
                  </span>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    disabled={sibIndex >= siblings.length - 1}
                    onClick={() => void switchMessageBranch(siblings[sibIndex + 1]!.id)}
                    aria-label="下一版本"
                  >
                    <IconChevronRight size={13} />
                  </button>
                </span>
              ) : null}

              <button
                type="button"
                className={styles.miniBtn}
                title="复制"
                onClick={() => void handleCopy(msg.content)}
              >
                <IconCopy size={13} />
              </button>
              <button
                type="button"
                className={styles.miniBtn}
                title="编辑"
                onClick={() => {
                  setEditingId(msg.id)
                  setEditingText(msg.content)
                }}
              >
                <IconEdit size={13} />
              </button>
              {!isUser ? (
                <button
                  type="button"
                  className={styles.miniBtn}
                  title="重新生成（新增版本分支）"
                  onClick={() => void regenerateMessage(msg.id)}
                >
                  <IconRefresh size={13} />
                </button>
              ) : null}
              {!isUser && isLast ? (
                <button
                  type="button"
                  className={styles.miniBtn}
                  title="继续生成"
                  onClick={() => void continueLastMessage()}
                >
                  <span>继续</span>
                </button>
              ) : null}
              <button
                type="button"
                className={styles.miniBtn}
                title="删除此条及后续分支"
                onClick={() => void deleteMessage(msg.id)}
              >
                <IconTrash size={13} />
              </button>
            </div>
          ) : null}
        </div>

        {isUser ? (() => {
          const userAvatar = povCharacter?.avatar || msg.speakerAvatar
          const userLabel = (povCharacter?.name || msg.speakerName || '我').slice(0, 1)
          return (
            <button
              type="button"
              className={styles.msgAvatarBtn}
              title={povCharacter ? `点击编辑「${povCharacter.name}」的头像或设定` : '点击选择我的视角头像'}
              onClick={() =>
                povCharacter
                  ? openLibrary('character', povCharacter.id)
                  : setMountDrawerOpen(true)
              }
            >
              {userAvatar ? (
                <img className={styles.msgAvatar} src={userAvatar} alt="" />
              ) : (
                <div className={styles.msgAvatar}>{userLabel}</div>
              )}
            </button>
          )
        })() : null}
      </div>
    )
  }

  return (
    <div
      className={styles.workspace}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length > 0) {
          void importFiles(e.dataTransfer.files)
        }
      }}
    >
      {dragging ? (
        <div className={styles.dragOverlay}>
          <IconUpload size={28} />
          <span>松手导入 SillyTavern 角色卡 (.png) / 世界书 (.json) / 聊天记录 (.jsonl)</span>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
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

      {chatSearchOpen ? (
        <div className={styles.searchBarWrap}>
          <div className={styles.searchBar}>
            <IconSearch size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              placeholder="搜索本对话消息内容…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setSearchMatchCursor(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepSearchMatch(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  setChatSearchOpen(false)
                }
              }}
            />
            {searchQuery.trim() ? (
              <span className={styles.searchStat}>
                {matchedMessageIds.length > 0
                  ? `${(searchMatchCursor % matchedMessageIds.length) + 1} / ${matchedMessageIds.length}`
                  : '0 命中'}
              </span>
            ) : null}
            <button
              type="button"
              className={styles.searchNavBtn}
              disabled={matchedMessageIds.length === 0}
              title="上一条匹配 (Shift+Enter)"
              aria-label="上一条匹配"
              onClick={() => stepSearchMatch(-1)}
            >
              <IconChevronUp size={14} />
            </button>
            <button
              type="button"
              className={styles.searchNavBtn}
              disabled={matchedMessageIds.length === 0}
              title="下一条匹配 (Enter)"
              aria-label="下一条匹配"
              onClick={() => stepSearchMatch(1)}
            >
              <IconChevronDown size={14} />
            </button>
            <button
              type="button"
              className={styles.searchNavBtn}
              title="关闭搜索 (Esc)"
              aria-label="关闭搜索"
              onClick={() => setChatSearchOpen(false)}
            >
              <IconClose size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <div ref={scrollRef} className={styles.scrollArea}>
        {activePath.length === 0 ? (
          <div className={styles.welcome}>
            <h1 className={styles.welcomeTitle}>TavernChat</h1>
            <p className={styles.welcomeSub}>
              你的角色，你的世界，你的故事。
            </p>
            <div className={styles.welcomeActions}>
              {activeProvider.format !== 'ollama' && !activeProvider.apiKey.trim() ? (
                <button
                  type="button"
                  className={styles.actionPill}
                  onClick={() => setSettingsOpen(true)}
                >
                  <IconSettings size={14} />
                  <span>配置模型 API Key</span>
                </button>
              ) : null}
              <button
                type="button"
                className={styles.actionPill}
                onClick={() => setMountDrawerOpen(true)}
              >
                <IconPlus size={14} />
                <span>选入角色 / 世界卡</span>
              </button>
              <button
                type="button"
                className={styles.actionPill}
                onClick={() => openLibrary('character')}
              >
                <IconLayers size={14} />
                <span>打开卡牌库</span>
              </button>
              <button
                type="button"
                className={styles.actionPill}
                onClick={() => fileInputRef.current?.click()}
              >
                <IconUpload size={14} />
                <span>导入酒馆文件</span>
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.container}>
            {activePath.map((msg, idx) => renderMessage(msg, idx))}
          </div>
        )}
      </div>

      <div className={styles.composerOuter}>
        {activeChars.length >= 2 && session ? (
          <div className={styles.groupBar} aria-label="群聊在场角色点名栏">
            <div className={styles.groupBarScroll}>
              {session.multiCharMode !== 'narrator' ? (
                <button
                  type="button"
                  className={styles.groupRoundBtn}
                  disabled={isBusy || Boolean(compacting) || (activePath.length === 0 && !draft.trim())}
                  title={
                    draft.trim()
                      ? `发送消息并按「随机/设定顺序」让在场角色接力回复`
                      : '让在场角色接着刚才的话继续互聊/斗嘴'
                  }
                  onClick={() => {
                    const text = draft.trim()
                    if (text) {
                      setDraft('')
                      void sendMessage(text)
                    } else {
                      void triggerGroupRound({ isAutoContinuation: true })
                    }
                  }}
                >
                  {isBusy ? '演绎中…' : '全员接力'}
                </button>
              ) : null}

              {visibleGroupChars.map((char) => {
                const isMuted = Boolean(charMountMap.get(char.id)?.muted)
                return (
                  <button
                    key={char.id}
                    type="button"
                    disabled={isBusy || Boolean(compacting)}
                    className={clsx(styles.groupMemberChip, isMuted && styles.groupMemberMuted)}
                    title={
                      draft.trim()
                        ? `发送输入并点名「${char.name}」回应`
                        : `点名让「${char.name}」说一句`
                    }
                    onClick={() => {
                      const text = draft.trim()
                      if (text) {
                        setDraft('')
                        void sendMessage(text, { nextSpeakerId: char.id })
                      } else {
                        void triggerGroupRound({ speakerId: char.id })
                      }
                    }}
                  >
                    {char.avatar ? (
                      <img className={styles.groupMemberAvatar} src={char.avatar} alt="" />
                    ) : (
                      <span className={styles.groupMemberAvatar}>{char.name.slice(0, 1)}</span>
                    )}
                    <span className={styles.groupMemberName}>{char.name}</span>
                  </button>
                )
              })}
            </div>

            {session.multiCharMode !== 'manual' && session.multiCharMode !== 'narrator' ? (
              <button
                type="button"
                className={clsx(
                  styles.autoModeBtn,
                  groupCfg?.autoMode && styles.autoModeBtnOn
                )}
                title="开启后角色会自动互相接话推进剧情，一旦你在下方打字立刻暂停"
                onClick={() =>
                  void updateGroupConfig({ autoMode: !groupCfg?.autoMode })
                }
              >
                <span className={styles.autoDot} />
                <span>
                  {groupCfg?.autoMode
                    ? autoCountdown !== null
                      ? `续聊 ${autoCountdown}s`
                      : '自动中'
                    : '自动续聊'}
                </span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className={styles.composerCard}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={
              activeChars.length >= 2
                ? `向群聊（${activeChars.map((c) => c.name).join('、')}）发言，或直接点上方角色头像让 TA 插嘴…`
                : activeChars.length > 0
                  ? `向 ${activeChars[0]!.name} 发送消息…（Enter 发送，Shift+Enter 换行）`
                  : '输入消息开始对话…（可随时点击右上角「组件」展开右侧栏）'
            }
            value={draft}
            onChange={(e) => {
              const val = e.target.value
              setDraft(val)
              if (val.trim() && groupCfg?.autoMode) {
                void updateGroupConfig({ autoMode: false })
                showToast('检测到输入，已自动暂停自动续聊', 'info')
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
          />

          <div className={styles.toolbar}>
            {modelPopOpen ? (
              <div className={styles.popover}>
                <div className={styles.popHeader}>{activeProvider.name} · 模型</div>
                {activeProvider.models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={clsx(
                      styles.popRow,
                      activeProvider.model === m && styles.popRowActive
                    )}
                    onClick={() => {
                      settings.upsertProvider({ ...activeProvider, model: m })
                      setModelPopOpen(false)
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m}</span>
                    {activeProvider.model === m ? <IconCheck size={14} /> : null}
                  </button>
                ))}
                {settings.providers.length > 1 ? (
                  <>
                    <div className={styles.popHeader} style={{ marginTop: 4 }}>
                      切换服务商
                    </div>
                    {settings.providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={clsx(
                          styles.popRow,
                          p.id === activeProvider.id && styles.popRowActive
                        )}
                        onClick={() => {
                          settings.setActiveProvider(p.id)
                          setModelPopOpen(false)
                        }}
                      >
                        <span>{p.name}</span>
                        {p.id === activeProvider.id ? <IconCheck size={14} /> : null}
                      </button>
                    ))}
                  </>
                ) : null}
                <button
                  type="button"
                  className={styles.popRow}
                  style={{ color: 'var(--accent)', marginTop: 4 }}
                  onClick={() => {
                    setModelPopOpen(false)
                    setSettingsOpen(true)
                  }}
                >
                  <span>配置 API Key 与更多服务…</span>
                </button>
              </div>
            ) : null}

            <div className={styles.toolLeft}>
              {/* 借鉴 DeepseekChat 的内联轻模型选择器 */}
              <button
                type="button"
                className={styles.toolChip}
                onClick={() => setModelPopOpen((v) => !v)}
              >
                <span>{activeProvider.model || activeProvider.name}</span>
                <IconChevronDown size={12} />
              </button>

              <button
                type="button"
                className={styles.toolChip}
                title="查看本次组装后的完整 Prompt 与触发的世界书"
                onClick={() => setPromptPreviewOpen(true)}
              >
                <IconEye size={13} />
                <span>~{tokenEstimate} tok</span>
              </button>

              {compacting ? (
                <span className={styles.compactingChip}>
                  整理记忆
                  {compacting.total > 1 ? ` ${compacting.chunk}/${compacting.total}` : '…'}
                </span>
              ) : null}
            </div>

            <button
              type="button"
              className={clsx(styles.sendBtn, isBusy && styles.stopBtn)}
              disabled={Boolean(compacting) || (!isBusy && !draft.trim() && activePath.length === 0)}
              onClick={handleSend}
              aria-label={isBusy ? '停止生成' : '发送'}
            >
              {isBusy ? <IconStop size={15} /> : <IconSend size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
