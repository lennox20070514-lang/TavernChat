import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterComponent, ChatMessage } from '@tavern-chat/core'
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
  IconStop,
  IconTrash,
  IconUpload,
} from '../base/icons.tsx'
import { HighlightText, MarkdownText } from './MarkdownText.tsx'
import styles from './ChatWorkspace.module.css'

export const ChatWorkspace = () => {
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const components = useAppStore((s) => s.components)
  const messagesBySession = useAppStore((s) => s.messagesBySession)
  const streamingBySession = useAppStore((s) => s.streamingBySession)
  const compactingBySession = useAppStore((s) => s.compactingBySession)

  const sendMessage = useAppStore((s) => s.sendMessage)
  const stopStreaming = useAppStore((s) => s.stopStreaming)
  const regenerateMessage = useAppStore((s) => s.regenerateMessage)
  const continueLastMessage = useAppStore((s) => s.continueLastMessage)
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
  const [speakerId, setSpeakerId] = useState<string>('')
  const [dragging, setDragging] = useState(false)
  const [searchMatchCursor, setSearchMatchCursor] = useState(0)

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
  const compacting = activeSessionId ? compactingBySession[activeSessionId] : undefined

  const activeChars = useMemo(() => {
    if (!session) return []
    const map = new Map(components.map((c) => [c.id, c]))
    return session.mounts
      .filter((m) => m.enabled && m.kind === 'character')
      .sort((a, b) => a.order - b.order)
      .map((m) => map.get(m.componentId))
      .filter((c): c is CharacterComponent => Boolean(c && c.kind === 'character'))
  }, [session, components])

  const tokenEstimate = useMemo(() => {
    const assembled = previewCurrentPrompt(speakerId || undefined)
    return assembled?.totalTokens ?? 0
  }, [previewCurrentPrompt, speakerId, session, activePath, components])

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
    if (streaming) {
      stopStreaming()
      return
    }
    const text = draft.trim()
    // 允许空白输入时若已有角色也直接驱动角色继续发言
    if (!text && activePath.length === 0) return
    setDraft('')
    void sendMessage(text, {
      nextSpeakerId: activeChars.length > 1 && speakerId ? speakerId : undefined,
    })
  }

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      showToast('已复制到剪贴板', 'success')
    } catch {
      showToast('复制失败', 'error')
    }
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
        {!isUser ? (
          msg.speakerAvatar ? (
            <img className={styles.msgAvatar} src={msg.speakerAvatar} alt="" />
          ) : (
            <div className={styles.msgAvatar}>
              {(msg.speakerName || 'A').slice(0, 1)}
            </div>
          )
        ) : null}

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
                <MarkdownText content={msg.content} highlightQuery={hl} />
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
                  onClick={() =>
                    void regenerateMessage(
                      msg.id,
                      activeChars.length > 1 && speakerId ? speakerId : undefined
                    )
                  }
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
        accept=".png,.json,.jsonl"
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
        <div className={styles.composerCard}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={1}
            placeholder={
              activeChars.length > 0
                ? `向 ${activeChars.map((c) => c.name).join('、')} 发送消息…（Enter 发送，Shift+Enter 换行）`
                : '输入消息开始对话…（可随时点击右上角「组件」展开右侧栏）'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
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

              {activeChars.length > 1 ? (
                <select
                  className={styles.toolChip}
                  value={speakerId}
                  onChange={(e) => setSpeakerId(e.target.value)}
                  title="指定本轮由哪位角色回应"
                >
                  <option value="">自动安排发言</option>
                  {activeChars.map((c) => (
                    <option key={c.id} value={c.id}>
                      点名：{c.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            <button
              type="button"
              className={clsx(styles.sendBtn, streaming && styles.stopBtn)}
              disabled={Boolean(compacting) || (!streaming && !draft.trim() && activePath.length === 0)}
              onClick={handleSend}
              aria-label={streaming ? '停止生成' : '发送'}
            >
              {streaming ? <IconStop size={15} /> : <IconSend size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
