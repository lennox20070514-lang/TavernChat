import {
  assemblePrompt,
  createBuiltinRulePresets,
  smartImportFile,
  substituteMacros,
  type AssembledPrompt,
  type CharacterComponent,
  type ChatMessage,
  type ChatSession,
  type ComponentItem,
  type ComponentKind,
  type MountedComponent,
  type MultiCharMode,
  type PersonaComponent,
} from '@tavern-chat/core'
import { create } from 'zustand'
import { streamChatCompletion } from './llm/client.ts'
import { getActiveProvider, useSettings } from './settings.ts'
import { storage } from './storage/indexedDbAdapter.ts'

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 沿着 activeLeafId 回溯父节点，得到当前分支上按时间正序的消息链
 */
export function resolveActivePath(
  allMessages: ChatMessage[],
  activeLeafId: string | null
): ChatMessage[] {
  if (allMessages.length === 0) return []
  const byId = new Map(allMessages.map((m) => [m.id, m]))
  let cursor: ChatMessage | undefined = activeLeafId ? byId.get(activeLeafId) : undefined
  if (!cursor) {
    cursor = allMessages[allMessages.length - 1]
  }
  const chain: ChatMessage[] = []
  const visited = new Set<string>()
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain
}

/**
 * 找出某条消息的所有兄弟版本（用于酒馆风格 Swipe `< 1/3 >`）
 */
export function getMessageSiblings(allMessages: ChatMessage[], target: ChatMessage): ChatMessage[] {
  return allMessages
    .filter((m) => m.parentId === target.parentId && m.role === target.role)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 从指定节点往下走到其最新的叶节点（切换分支版本时自动定位到底部）
 */
function findDeepestLatestLeaf(allMessages: ChatMessage[], startId: string): string {
  const childrenByParent = new Map<string, ChatMessage[]>()
  for (const m of allMessages) {
    if (!m.parentId) continue
    const list = childrenByParent.get(m.parentId) ?? []
    list.push(m)
    childrenByParent.set(m.parentId, list)
  }
  let current = startId
  const visited = new Set<string>([current])
  while (true) {
    const kids = childrenByParent.get(current)
    if (!kids || kids.length === 0) return current
    kids.sort((a, b) => b.updatedAt - a.updatedAt)
    const next = kids[0]!.id
    if (visited.has(next)) return current
    visited.add(next)
    current = next
  }
}

export type ToastMessage = {
  id: string
  text: string
  tone?: 'info' | 'success' | 'error'
}

type AppStoreState = {
  ready: boolean
  components: ComponentItem[]
  sessions: ChatSession[]
  activeSessionId: string | null
  messagesBySession: Record<string, ChatMessage[]>
  streamingBySession: Record<string, { messageId: string; controller: AbortController }>
  toast: ToastMessage | null

  // UI 面板开关
  libraryOpen: boolean
  libraryInitialTab: ComponentKind | 'all'
  libraryEditingId: string | null
  mountDrawerOpen: boolean
  chatSearchOpen: boolean
  chatSearchQuery: string
  settingsOpen: boolean
  promptPreviewOpen: boolean
  mobileSiderOpen: boolean

  init: () => Promise<void>
  showToast: (text: string, tone?: ToastMessage['tone']) => void
  clearToast: () => void

  // UI 控制
  openLibrary: (tab?: ComponentKind | 'all', editId?: string | null) => void
  closeLibrary: () => void
  setMountDrawerOpen: (open: boolean) => void
  setChatSearchOpen: (open: boolean) => void
  setChatSearchQuery: (query: string) => void
  openSessionWithSearch: (sessionId: string, query: string) => Promise<void>
  loadAllMessagesForSearch: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setPromptPreviewOpen: (open: boolean) => void
  setMobileSiderOpen: (open: boolean) => void

  // 组件库 CRUD
  upsertComponent: (item: ComponentItem) => Promise<void>
  deleteComponent: (id: string) => Promise<void>

  // 会话 CRUD
  createSession: (initialMounts?: MountedComponent[], title?: string) => Promise<ChatSession>
  selectSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>

  // 对话组件自由选入 / 选出
  toggleMountComponent: (componentId: string) => Promise<void>
  setMountEnabled: (componentId: string, enabled: boolean) => Promise<void>
  removeMount: (componentId: string) => Promise<void>
  toggleWorldEntryOverride: (worldComponentId: string, entryId: string) => Promise<void>
  updateAuthorsNote: (note: string, depth?: number) => Promise<void>
  setMultiCharMode: (mode: MultiCharMode) => Promise<void>
  insertCharacterGreeting: (characterId: string, greetingIndex?: number) => Promise<void>

  // 对话发送 / 流式 / 分支操作
  previewCurrentPrompt: (nextSpeakerId?: string) => AssembledPrompt | null
  sendMessage: (text: string, options?: { nextSpeakerId?: string }) => Promise<void>
  stopStreaming: (sessionId?: string) => void
  regenerateMessage: (messageId: string, nextSpeakerId?: string) => Promise<void>
  continueLastMessage: () => Promise<void>
  editMessage: (messageId: string, newContent: string) => Promise<void>
  deleteMessage: (messageId: string) => Promise<void>
  switchMessageBranch: (targetMessageId: string) => Promise<void>

  // 兼容酒馆文件导入 & 全量备份
  importFiles: (files: FileList | File[]) => Promise<string[]>
  exportFullBackupJson: () => Promise<string>
  clearAllLocalData: () => Promise<void>
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useAppStore = create<AppStoreState>((set, get) => ({
  ready: false,
  components: [],
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  streamingBySession: {},
  toast: null,

  libraryOpen: false,
  libraryInitialTab: 'all',
  libraryEditingId: null,
  mountDrawerOpen: false,
  chatSearchOpen: false,
  chatSearchQuery: '',
  settingsOpen: false,
  promptPreviewOpen: false,
  mobileSiderOpen: false,

  showToast: (text, tone = 'info') => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { id: uid('toast'), text, tone } })
    toastTimer = setTimeout(() => {
      set({ toast: null })
    }, 3200)
  },

  clearToast: () => set({ toast: null }),

  openLibrary: (tab = 'all', editId = null) =>
    set({ libraryOpen: true, libraryInitialTab: tab, libraryEditingId: editId }),
  closeLibrary: () => set({ libraryOpen: false, libraryEditingId: null }),
  setMountDrawerOpen: (mountDrawerOpen) => set({ mountDrawerOpen }),
  setChatSearchOpen: (chatSearchOpen) =>
    set((s) => ({ chatSearchOpen, chatSearchQuery: chatSearchOpen ? s.chatSearchQuery : '' })),
  setChatSearchQuery: (chatSearchQuery) => set({ chatSearchQuery }),
  openSessionWithSearch: async (sessionId, query) => {
    await get().selectSession(sessionId)
    const trimmed = query.trim()
    if (trimmed) {
      set({ chatSearchOpen: true, chatSearchQuery: trimmed })
    }
  },
  loadAllMessagesForSearch: async () => {
    const state = get()
    const missingIds = state.sessions
      .map((s) => s.id)
      .filter((id) => !Object.hasOwn(state.messagesBySession, id))
    if (missingIds.length === 0) return
    const loadedEntries = await Promise.all(
      missingIds.map(async (id) => [id, await storage.listMessages(id)] as const)
    )
    set((s) => {
      const next = { ...s.messagesBySession }
      for (const [id, msgs] of loadedEntries) {
        if (!Object.hasOwn(next, id)) {
          next[id] = msgs
        }
      }
      return { messagesBySession: next }
    })
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPromptPreviewOpen: (promptPreviewOpen) => set({ promptPreviewOpen }),
  setMobileSiderOpen: (mobileSiderOpen) => set({ mobileSiderOpen }),

  init: async () => {
    let components = await storage.listComponents()
    // 首次启动只注入 2 条干净通用的基础规则卡，绝不塞演示角色或演示世界书
    if (components.length === 0) {
      const defaults = createBuiltinRulePresets()
      for (const item of defaults) {
        await storage.upsertComponent(item)
      }
      components = defaults
    }

    let sessions = await storage.listSessions()
    let activeSessionId: string | null = sessions[0]?.id ?? null

    if (sessions.length === 0) {
      const firstSession: ChatSession = {
        id: uid('sess'),
        title: '新对话',
        mounts: [],
        authorsNote: '',
        authorsNoteDepth: 4,
        multiCharMode: 'narrator',
        activeLeafId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await storage.upsertSession(firstSession)
      sessions = [firstSession]
      activeSessionId = firstSession.id
    }

    const messagesBySession: Record<string, ChatMessage[]> = {}
    if (activeSessionId) {
      messagesBySession[activeSessionId] = await storage.listMessages(activeSessionId)
    }

    set({
      ready: true,
      components,
      sessions,
      activeSessionId,
      messagesBySession,
    })
  },

  upsertComponent: async (item) => {
    const updated: ComponentItem = { ...item, updatedAt: Date.now() }
    await storage.upsertComponent(updated)
    set((state) => {
      const exists = state.components.some((c) => c.id === updated.id)
      const components = exists
        ? state.components.map((c) => (c.id === updated.id ? updated : c))
        : [updated, ...state.components]
      return { components }
    })
  },

  deleteComponent: async (id) => {
    await storage.deleteComponent(id)
    // 同步从所有会话的挂载中清理
    const nextSessions: ChatSession[] = []
    for (const s of get().sessions) {
      if (s.mounts.some((m) => m.componentId === id)) {
        const cleaned = {
          ...s,
          mounts: s.mounts.filter((m) => m.componentId !== id),
          updatedAt: Date.now(),
        }
        await storage.upsertSession(cleaned)
        nextSessions.push(cleaned)
      } else {
        nextSessions.push(s)
      }
    }
    set((state) => ({
      components: state.components.filter((c) => c.id !== id),
      sessions: nextSessions,
    }))
  },

  createSession: async (initialMounts = [], title = '新对话') => {
    const now = Date.now()
    const session: ChatSession = {
      id: uid('sess'),
      title,
      mounts: initialMounts,
      authorsNote: '',
      authorsNoteDepth: 4,
      multiCharMode: 'narrator',
      activeLeafId: null,
      createdAt: now,
      updatedAt: now,
    }
    await storage.upsertSession(session)
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeSessionId: session.id,
      messagesBySession: { ...state.messagesBySession, [session.id]: [] },
      mobileSiderOpen: false,
    }))
    return session
  },

  selectSession: async (id) => {
    const cached = get().messagesBySession[id]
    if (!cached) {
      const loaded = await storage.listMessages(id)
      set((state) => ({
        activeSessionId: id,
        messagesBySession: { ...state.messagesBySession, [id]: loaded },
        mobileSiderOpen: false,
        chatSearchOpen: false,
        chatSearchQuery: '',
      }))
    } else {
      set({
        activeSessionId: id,
        mobileSiderOpen: false,
        chatSearchOpen: false,
        chatSearchQuery: '',
      })
    }
  },

  renameSession: async (id, title) => {
    const session = get().sessions.find((s) => s.id === id)
    if (!session) return
    const updated = { ...session, title: title.trim() || '新对话', updatedAt: Date.now() }
    await storage.upsertSession(updated)
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
    }))
  },

  deleteSession: async (id) => {
    get().stopStreaming(id)
    await storage.deleteSession(id)
    const remaining = get().sessions.filter((s) => s.id !== id)
    const nextMessages = { ...get().messagesBySession }
    delete nextMessages[id]

    if (remaining.length === 0) {
      set({ sessions: [], activeSessionId: null, messagesBySession: nextMessages })
      await get().createSession()
      return
    }

    const nextActive = get().activeSessionId === id ? remaining[0]!.id : get().activeSessionId
    set({
      sessions: remaining,
      activeSessionId: nextActive,
      messagesBySession: nextMessages,
    })
    if (nextActive && !nextMessages[nextActive]) {
      const msgs = await storage.listMessages(nextActive)
      set((state) => ({
        messagesBySession: { ...state.messagesBySession, [nextActive]: msgs },
      }))
    }
  },

  toggleMountComponent: async (componentId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    const comp = state.components.find((c) => c.id === componentId)
    if (!session || !comp) return

    const existing = session.mounts.find((m) => m.componentId === componentId)
    let nextMounts: MountedComponent[]
    let justAdded = false

    if (existing) {
      // 已挂载则直接选出移除（保持简洁直观）
      nextMounts = session.mounts.filter((m) => m.componentId !== componentId)
    } else {
      justAdded = true
      // 人设卡互斥：选入新人设自动替换旧人设
      const base =
        comp.kind === 'persona'
          ? session.mounts.filter((m) => m.kind !== 'persona')
          : session.mounts
      const maxOrder = base.reduce((m, item) => Math.max(m, item.order), -1)
      nextMounts = [
        ...base,
        {
          componentId: comp.id,
          kind: comp.kind,
          enabled: true,
          order: maxOrder + 1,
        },
      ]
    }

    const updated: ChatSession = {
      ...session,
      mounts: nextMounts,
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))

    // 若为空对话、首次选入带开场白的角色卡、且用户开启了自动带入开场白，则丝滑插入开场白
    if (
      justAdded &&
      comp.kind === 'character' &&
      useSettings.getState().autoInsertGreeting &&
      (state.messagesBySession[session.id]?.length ?? 0) === 0
    ) {
      const charComp = comp as CharacterComponent
      if (charComp.payload.firstMessage.trim()) {
        await get().insertCharacterGreeting(charComp.id, 0)
      }
    }
  },

  setMountEnabled: async (componentId, enabled) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = {
      ...session,
      mounts: session.mounts.map((m) =>
        m.componentId === componentId ? { ...m, enabled } : m
      ),
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  removeMount: async (componentId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = {
      ...session,
      mounts: session.mounts.filter((m) => m.componentId !== componentId),
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  toggleWorldEntryOverride: async (worldComponentId, entryId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = {
      ...session,
      mounts: session.mounts.map((m) => {
        if (m.componentId !== worldComponentId) return m
        const cur = new Set(m.disabledWorldEntryIds ?? [])
        if (cur.has(entryId)) cur.delete(entryId)
        else cur.add(entryId)
        return { ...m, disabledWorldEntryIds: [...cur] }
      }),
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  updateAuthorsNote: async (authorsNote, depth) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = {
      ...session,
      authorsNote,
      authorsNoteDepth: typeof depth === 'number' ? depth : session.authorsNoteDepth,
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  setMultiCharMode: async (multiCharMode) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = { ...session, multiCharMode, updatedAt: Date.now() }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  insertCharacterGreeting: async (characterId, greetingIndex = 0) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    const comp = state.components.find((c) => c.id === characterId && c.kind === 'character') as
      | CharacterComponent
      | undefined
    if (!session || !comp) return

    const greetings = [comp.payload.firstMessage, ...comp.payload.alternateGreetings].filter((g) =>
      g.trim()
    )
    const raw = greetings[greetingIndex] ?? greetings[0]
    if (!raw) return

    const personaMount = session.mounts.find((m) => m.kind === 'persona' && m.enabled)
    const persona = personaMount
      ? (state.components.find((c) => c.id === personaMount.componentId) as
          | PersonaComponent
          | undefined)
      : undefined
    const userName = persona?.payload.displayName?.trim() || persona?.name || '用户'

    const rendered = substituteMacros(raw, {
      charName: comp.name,
      userName,
      persona: persona?.payload.description ?? '',
      scenario: comp.payload.scenario,
    })

    const existing = state.messagesBySession[session.id] ?? []
    const now = Date.now()
    const msg: ChatMessage = {
      id: uid('msg'),
      sessionId: session.id,
      parentId: session.activeLeafId,
      role: 'assistant',
      speakerId: comp.id,
      speakerName: comp.name,
      speakerAvatar: comp.avatar,
      content: rendered,
      isGreeting: true,
      createdAt: now,
      updatedAt: now,
    }
    await storage.upsertMessage(msg)

    const updatedSession: ChatSession = {
      ...session,
      title: session.title === '新对话' ? comp.name : session.title,
      activeLeafId: msg.id,
      updatedAt: now,
    }
    await storage.upsertSession(updatedSession)

    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updatedSession.id ? updatedSession : item)),
      messagesBySession: {
        ...s.messagesBySession,
        [session.id]: [...existing, msg],
      },
    }))
  },

  previewCurrentPrompt: (nextSpeakerId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return null
    const allMsgs = state.messagesBySession[session.id] ?? []
    const history = resolveActivePath(allMsgs, session.activeLeafId)
    const settings = useSettings.getState()
    return assemblePrompt({
      session,
      history,
      components: state.components,
      nextSpeakerId,
      defaultMaxContextTokens: settings.defaultMaxContextTokens,
      defaultMaxResponseTokens: settings.defaultMaxResponseTokens,
    })
  },

  stopStreaming: (sessionId) => {
    const targetId = sessionId ?? get().activeSessionId
    if (!targetId) return
    const active = get().streamingBySession[targetId]
    if (active) {
      active.controller.abort()
      set((s) => {
        const next = { ...s.streamingBySession }
        delete next[targetId]
        return { streamingBySession: next }
      })
    }
  },

  sendMessage: async (text, options) => {
    const trimmed = text.trim()
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    if (state.streamingBySession[session.id]) return

    const existing = state.messagesBySession[session.id] ?? []
    let parentId = session.activeLeafId
    let nextMsgs = [...existing]
    const now = Date.now()

    if (trimmed) {
      const userMsg: ChatMessage = {
        id: uid('msg'),
        sessionId: session.id,
        parentId,
        role: 'user',
        content: trimmed,
        createdAt: now,
        updatedAt: now,
      }
      await storage.upsertMessage(userMsg)
      nextMsgs = [...nextMsgs, userMsg]
      parentId = userMsg.id
    }

    const updatedTitle =
      session.title === '新对话' && trimmed
        ? trimmed.slice(0, 20) + (trimmed.length > 20 ? '…' : '')
        : session.title

    const updatedSession: ChatSession = {
      ...session,
      title: updatedTitle,
      activeLeafId: parentId,
      updatedAt: now,
    }
    await storage.upsertSession(updatedSession)

    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updatedSession.id ? updatedSession : item)),
      messagesBySession: { ...s.messagesBySession, [session.id]: nextMsgs },
    }))

    await generateAssistantReply(get, set, updatedSession.id, parentId, {
      nextSpeakerId: options?.nextSpeakerId,
      mode: 'normal',
    })
  },

  regenerateMessage: async (messageId, nextSpeakerId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const allMsgs = state.messagesBySession[session.id] ?? []
    const target = allMsgs.find((m) => m.id === messageId)
    if (!target || target.role !== 'assistant') return

    // 在同一个 parentId 下生成新的兄弟回复分支（即酒馆 Swipe 机制！）
    await generateAssistantReply(get, set, session.id, target.parentId, {
      nextSpeakerId: nextSpeakerId ?? target.speakerId,
      mode: 'normal',
    })
  },

  continueLastMessage: async () => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const allMsgs = state.messagesBySession[session.id] ?? []
    const path = resolveActivePath(allMsgs, session.activeLeafId)
    const last = path.at(-1)
    if (!last) return
    await generateAssistantReply(get, set, session.id, last.id, {
      nextSpeakerId: last.speakerId,
      mode: 'continue',
    })
  },

  editMessage: async (messageId, newContent) => {
    const state = get()
    const sessionId = state.activeSessionId
    if (!sessionId) return
    const allMsgs = state.messagesBySession[sessionId] ?? []
    const target = allMsgs.find((m) => m.id === messageId)
    if (!target) return
    const updated: ChatMessage = {
      ...target,
      content: newContent,
      updatedAt: Date.now(),
    }
    await storage.upsertMessage(updated)
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: allMsgs.map((m) => (m.id === messageId ? updated : m)),
      },
    }))
  },

  deleteMessage: async (messageId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const allMsgs = state.messagesBySession[session.id] ?? []
    const target = allMsgs.find((m) => m.id === messageId)
    if (!target) return

    // 级联删除该节点及其所有子节点
    const toDelete = new Set<string>([messageId])
    let expanded = true
    while (expanded) {
      expanded = false
      for (const m of allMsgs) {
        if (m.parentId && toDelete.has(m.parentId) && !toDelete.has(m.id)) {
          toDelete.add(m.id)
          expanded = true
        }
      }
    }

    await storage.deleteMessages(session.id, [...toDelete])
    const remaining = allMsgs.filter((m) => !toDelete.has(m.id))
    const nextLeaf =
      session.activeLeafId && toDelete.has(session.activeLeafId)
        ? target.parentId
        : session.activeLeafId

    const updatedSession = { ...session, activeLeafId: nextLeaf, updatedAt: Date.now() }
    await storage.upsertSession(updatedSession)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updatedSession.id ? updatedSession : item)),
      messagesBySession: { ...s.messagesBySession, [session.id]: remaining },
    }))
  },

  switchMessageBranch: async (targetMessageId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const allMsgs = state.messagesBySession[session.id] ?? []
    const leafId = findDeepestLatestLeaf(allMsgs, targetMessageId)
    const updatedSession = { ...session, activeLeafId: leafId, updatedAt: Date.now() }
    await storage.upsertSession(updatedSession)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updatedSession.id ? updatedSession : item)),
    }))
  },

  importFiles: async (fileList) => {
    const files = Array.from(fileList)
    const summary: string[] = []
    const pendingGroups: Array<{ name: string; memberNames: string[] }> = []

    for (const file of files) {
      try {
        const lower = file.name.toLowerCase()
        const content: Uint8Array | string = lower.endsWith('.png')
          ? new Uint8Array(await file.arrayBuffer())
          : await file.text()
        const newSessionId = uid('sess')
        const result = smartImportFile(file.name, content, newSessionId)

        if (result.kind === 'character') {
          await get().upsertComponent(result.bundle.character)
          summary.push(`角色卡「${result.bundle.character.name}」`)
          if (result.bundle.embeddedWorld) {
            await get().upsertComponent(result.bundle.embeddedWorld)
            summary.push(`提取内嵌世界卡「${result.bundle.embeddedWorld.name}」`)
          }
        } else if (result.kind === 'world') {
          await get().upsertComponent(result.world)
          summary.push(`世界卡「${result.world.name}」(${result.world.payload.entries.length} 条)`)
        } else if (result.kind === 'rule') {
          await get().upsertComponent(result.rule)
          summary.push(`规则预设「${result.rule.name}」`)
        } else if (result.kind === 'group') {
          pendingGroups.push({ name: result.name, memberNames: result.memberNames })
        } else if (result.kind === 'chat_jsonl') {
          const now = Date.now()
          const importedSession: ChatSession = {
            id: newSessionId,
            title: result.title || file.name.replace(/\.jsonl$/i, ''),
            mounts: [],
            authorsNote: '',
            authorsNoteDepth: 4,
            multiCharMode: 'narrator',
            activeLeafId: result.activeLeafId,
            createdAt: now,
            updatedAt: now,
          }
          await storage.upsertSession(importedSession)
          for (const msg of result.messages) {
            await storage.upsertMessage(msg)
          }
          set((s) => ({
            sessions: [importedSession, ...s.sessions],
            activeSessionId: importedSession.id,
            messagesBySession: { ...s.messagesBySession, [importedSession.id]: result.messages },
          }))
          summary.push(`聊天记录「${importedSession.title}」(${result.messages.length} 条)`)
        } else if (result.kind === 'tavern_backup') {
          for (const c of result.components) await storage.upsertComponent(c)
          for (const s of result.sessions) await storage.upsertSession(s)
          for (const m of result.messages) await storage.upsertMessage(m)
          await get().init()
          summary.push(
            `备份恢复：${result.components.length} 个组件，${result.sessions.length} 个对话`
          )
        }
      } catch (err) {
        get().showToast(
          `导入 ${file.name} 失败：${err instanceof Error ? err.message : String(err)}`,
          'error'
        )
      }
    }

    // 处理酒馆群聊 JSON：按角色名自动勾选对应角色并建立对话
    for (const grp of pendingGroups) {
      const chars = get().components.filter((c) => c.kind === 'character')
      const matched = grp.memberNames
        .map((name) => chars.find((c) => c.name === name))
        .filter((c): c is ComponentItem => Boolean(c))
      const mounts: MountedComponent[] = matched.map((c, idx) => ({
        componentId: c.id,
        kind: 'character',
        enabled: true,
        order: idx,
      }))
      await get().createSession(mounts, grp.name)
      summary.push(`多角色对话「${grp.name}」(已选入 ${matched.length} 位角色)`)
    }

    if (summary.length > 0) {
      get().showToast(`已导入：${summary.join('、')}`, 'success')
    }
    return summary
  },

  exportFullBackupJson: async () => {
    const components = await storage.listComponents()
    const sessions = await storage.listSessions()
    const messages = await storage.listAllMessages()
    return JSON.stringify(
      {
        format: 'tavern-chat-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        components,
        sessions,
        messages,
      },
      null,
      2
    )
  },

  clearAllLocalData: async () => {
    await storage.clearAll()
    set({ components: [], sessions: [], activeSessionId: null, messagesBySession: {} })
    await get().init()
    get().showToast('已清空本地数据并重置', 'info')
  },
}))

async function generateAssistantReply(
  get: () => AppStoreState,
  set: (
    partial:
      | Partial<AppStoreState>
      | ((state: AppStoreState) => Partial<AppStoreState>)
  ) => void,
  sessionId: string,
  parentId: string | null,
  options: { nextSpeakerId?: string; mode: 'normal' | 'continue' }
) {
  const state = get()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return

  const settings = useSettings.getState()
  const provider = getActiveProvider(settings)

  const allMsgs = state.messagesBySession[sessionId] ?? []
  const history = parentId ? resolveActivePath(allMsgs, parentId) : []

  // 计算发言角色（单角色默认首位，多角色按模式选择）
  const activeChars = session.mounts
    .filter((m) => m.enabled && m.kind === 'character')
    .sort((a, b) => a.order - b.order)
    .map((m) => state.components.find((c) => c.id === m.componentId) as CharacterComponent | undefined)
    .filter((c): c is CharacterComponent => Boolean(c))

  let speaker: CharacterComponent | undefined
  if (options.nextSpeakerId) {
    speaker = activeChars.find((c) => c.id === options.nextSpeakerId)
  } else if (activeChars.length === 1) {
    speaker = activeChars[0]
  } else if (activeChars.length > 1 && session.multiCharMode === 'round_robin') {
    const lastAi = [...history].reverse().find((m) => m.role === 'assistant' && m.speakerId)
    const lastIdx = lastAi ? activeChars.findIndex((c) => c.id === lastAi.speakerId) : -1
    speaker = activeChars[(lastIdx + 1) % activeChars.length]
  } else if (activeChars.length > 1 && session.multiCharMode === 'manual') {
    speaker = activeChars[0]
  }

  const assembled = assemblePrompt({
    session,
    history,
    components: state.components,
    nextSpeakerId: speaker?.id,
    defaultMaxContextTokens: settings.defaultMaxContextTokens,
    defaultMaxResponseTokens: settings.defaultMaxResponseTokens,
    mode: options.mode,
  })

  const now = Date.now()
  const assistantMsg: ChatMessage = {
    id: uid('msg'),
    sessionId,
    parentId,
    role: 'assistant',
    speakerId: speaker?.id,
    speakerName:
      speaker?.name ?? (activeChars.length > 1 ? '场景演绎' : undefined),
    speakerAvatar: speaker?.avatar,
    content: '',
    reasoning: '',
    triggeredWorld: assembled.triggeredWorld,
    createdAt: now,
    updatedAt: now,
  }

  await storage.upsertMessage(assistantMsg)
  const updatedSession: ChatSession = {
    ...session,
    activeLeafId: assistantMsg.id,
    updatedAt: now,
  }
  await storage.upsertSession(updatedSession)

  const controller = new AbortController()
  set((s) => ({
    sessions: s.sessions.map((item) => (item.id === updatedSession.id ? updatedSession : item)),
    messagesBySession: {
      ...s.messagesBySession,
      [sessionId]: [...(s.messagesBySession[sessionId] ?? []), assistantMsg],
    },
    streamingBySession: {
      ...s.streamingBySession,
      [sessionId]: { messageId: assistantMsg.id, controller },
    },
  }))

  let accContent = ''
  let accReasoning = ''
  let lastPersist = 0

  const flushMessageToState = (persistNow: boolean) => {
    const updatedMsg: ChatMessage = {
      ...assistantMsg,
      content: accContent,
      reasoning: accReasoning || undefined,
      updatedAt: Date.now(),
    }
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: (s.messagesBySession[sessionId] ?? []).map((m) =>
          m.id === assistantMsg.id ? updatedMsg : m
        ),
      },
    }))
    const ts = Date.now()
    if (persistNow || ts - lastPersist > 500) {
      lastPersist = ts
      void storage.upsertMessage(updatedMsg)
    }
  }

  try {
    await streamChatCompletion({
      provider,
      messages: assembled.messages,
      temperature: assembled.sampling.temperature,
      topP: assembled.sampling.topP,
      maxTokens: assembled.sampling.maxTokens,
      customGatewayOrigin: settings.customGatewayOrigin,
      signal: controller.signal,
      onEvent: (ev) => {
        if (ev.type === 'delta') {
          accContent += ev.text
          flushMessageToState(false)
        } else if (ev.type === 'reasoning') {
          accReasoning += ev.text
          flushMessageToState(false)
        }
      },
    })
    flushMessageToState(true)
  } catch (err) {
    if (!controller.signal.aborted) {
      const errText = err instanceof Error ? err.message : String(err)
      if (!accContent) {
        accContent = `> ⚠️ 请求失败：${errText}`
      }
      flushMessageToState(true)
      get().showToast(errText, 'error')
    } else {
      flushMessageToState(true)
    }
  } finally {
    set((s) => {
      const next = { ...s.streamingBySession }
      delete next[sessionId]
      return { streamingBySession: next }
    })
  }
}
