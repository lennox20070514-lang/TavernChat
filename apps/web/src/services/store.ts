import {
  assemblePrompt,
  BUILTIN_SELF_CHARACTER_ID,
  createBuiltinRulePresets,
  createBuiltinStarterCharacters,
  DEFAULT_GROUP_CHAT_CONFIG,
  draftGroupSpeakers,
  findActiveCheckpoint,
  planCompaction,
  resolveCompactionBudget,
  resolveGroupChatConfig,
  smartImportFile,
  stripLeadingSpeakerPrefix,
  substituteMacros,
  type AssembledPrompt,
  type CharacterComponent,
  type ChatMessage,
  type ChatSession,
  type ComponentItem,
  type ComponentKind,
  type ContextCheckpoint,
  type GroupChatConfig,
  type MountedComponent,
  type MultiCharMode,
  type PersonaComponent,
} from '@tavern-chat/core'
import { create } from 'zustand'
import { runCompaction } from './contextCompaction.ts'
import { streamChatCompletion } from './llm/client.ts'
import { getActiveProvider, useSettings } from './settings.ts'
import { hasOwn } from '../utils/compat.ts'
import { storage } from './storage/indexedDbAdapter.ts'
import {
  isApplyingRemoteSync,
  readSyncDeletedIds,
  recordSyncDeletion,
  registerStoreSyncReload,
  scheduleSyncPush,
} from './sync.ts'

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

function resolveContextView(
  session: ChatSession,
  allMessages: ChatMessage[],
  leafId: string | null
): {
  path: ChatMessage[]
  history: ChatMessage[]
  checkpoint: ContextCheckpoint | null
} {
  const path = leafId ? resolveActivePath(allMessages, leafId) : []
  const active = findActiveCheckpoint(path, session.contextCheckpoints)
  return {
    path,
    history: active ? path.slice(active.anchorIndex + 1) : path,
    checkpoint: active?.checkpoint ?? null,
  }
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
  activeGroupRoundBySession: Record<string, boolean>
  compactingBySession: Record<string, { chunk: number; total: number }>
  toast: ToastMessage | null

  // UI 面板开关
  marketOpen: boolean
  libraryOpen: boolean
  libraryInitialTab: ComponentKind | 'all'
  libraryEditingId: string | null
  libraryCreatingKind: 'character' | 'world' | 'rule' | null
  mountDrawerOpen: boolean
  chatSearchOpen: boolean
  chatSearchQuery: string
  settingsOpen: boolean
  lanConnectOpen: boolean
  promptPreviewOpen: boolean
  mobileSiderOpen: boolean

  init: () => Promise<void>
  reloadFromStorage: () => Promise<void>
  showToast: (text: string, tone?: ToastMessage['tone']) => void
  clearToast: () => void

  // UI 控制
  setMarketOpen: (open: boolean) => void
  openLibrary: (tab?: ComponentKind | 'all', editId?: string | null) => void
  openLibraryCreate: (kind?: 'character' | 'world' | 'rule') => void
  closeLibrary: () => void
  setMountDrawerOpen: (open: boolean) => void
  setChatSearchOpen: (open: boolean) => void
  setChatSearchQuery: (query: string) => void
  openSessionWithSearch: (sessionId: string, query: string) => Promise<void>
  loadAllMessagesForSearch: () => Promise<void>
  setSettingsOpen: (open: boolean) => void
  setLanConnectOpen: (open: boolean) => void
  setPromptPreviewOpen: (open: boolean) => void
  setMobileSiderOpen: (open: boolean) => void

  // 组件库 CRUD
  upsertComponent: (item: ComponentItem) => Promise<void>
  deleteComponent: (id: string) => Promise<void>

  // 会话 CRUD
  createSession: (
    initialMounts?: MountedComponent[],
    title?: string,
    extra?: Partial<Pick<ChatSession, 'multiCharMode' | 'groupConfig'>>
  ) => Promise<ChatSession>
  selectSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  setSessionPinned: (id: string, pinned: boolean) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  clearContextCheckpoints: (sessionId?: string) => Promise<void>

  // 对话组件自由选入 / 选出
  toggleMountComponent: (componentId: string) => Promise<void>
  setMountEnabled: (componentId: string, enabled: boolean) => Promise<void>
  removeMount: (componentId: string) => Promise<void>
  toggleWorldEntryOverride: (worldComponentId: string, entryId: string) => Promise<void>
  updateAuthorsNote: (note: string, depth?: number) => Promise<void>
  setMultiCharMode: (mode: MultiCharMode) => Promise<void>
  updateGroupConfig: (patch: Partial<GroupChatConfig>) => Promise<void>
  moveCharMountOrder: (componentId: string, delta: -1 | 1) => Promise<void>
  updateCharMountMeta: (
    componentId: string,
    patch: Partial<Pick<MountedComponent, 'muted' | 'talkativeness'>>
  ) => Promise<void>
  setUserCharacter: (characterId: string | null) => Promise<void>
  insertCharacterGreeting: (characterId: string, greetingIndex?: number) => Promise<void>

  // 对话发送 / 流式 / 分支操作
  previewCurrentPrompt: (nextSpeakerId?: string) => AssembledPrompt | null
  sendMessage: (text: string, options?: { nextSpeakerId?: string }) => Promise<void>
  triggerGroupRound: (options?: { speakerId?: string; isAutoContinuation?: boolean }) => Promise<void>
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
const stoppedQueueSessions = new Set<string>()

export const useAppStore = create<AppStoreState>((set, get) => ({
  ready: false,
  components: [],
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  streamingBySession: {},
  activeGroupRoundBySession: {},
  compactingBySession: {},
  toast: null,

  marketOpen: false,
  libraryOpen: false,
  libraryInitialTab: 'all',
  libraryEditingId: null,
  libraryCreatingKind: null,
  mountDrawerOpen: false,
  chatSearchOpen: false,
  chatSearchQuery: '',
  settingsOpen: false,
  lanConnectOpen: false,
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

  setMarketOpen: (marketOpen) => set({ marketOpen }),
  openLibrary: (tab = 'all', editId = null) =>
    set({
      libraryOpen: true,
      libraryInitialTab: tab,
      libraryEditingId: editId,
      libraryCreatingKind: null,
    }),
  openLibraryCreate: (kind = 'character') =>
    set({
      libraryOpen: true,
      libraryInitialTab: kind,
      libraryEditingId: null,
      libraryCreatingKind: kind,
    }),
  closeLibrary: () =>
    set({ libraryOpen: false, libraryEditingId: null, libraryCreatingKind: null }),
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
      .filter((id) => !hasOwn(state.messagesBySession, id))
    if (missingIds.length === 0) return
    const loadedEntries = await Promise.all(
      missingIds.map(async (id) => [id, await storage.listMessages(id)] as const)
    )
    set((s) => {
      const next = { ...s.messagesBySession }
      for (const [id, msgs] of loadedEntries) {
        if (!hasOwn(next, id)) {
          next[id] = msgs
        }
      }
      return { messagesBySession: next }
    })
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLanConnectOpen: (lanConnectOpen) => set({ lanConnectOpen }),
  setPromptPreviewOpen: (promptPreviewOpen) => set({ promptPreviewOpen }),
  setMobileSiderOpen: (mobileSiderOpen) => set({ mobileSiderOpen }),

  init: async () => {
    let components = await storage.listComponents()
    const deletedIds = readSyncDeletedIds()

    // 首次启动注入极简基础规则
    if (components.length === 0) {
      const defaults = createBuiltinRulePresets()
      for (const item of defaults) {
        await storage.upsertComponent(item)
      }
      components = defaults
    }

    // 注入默认空白「我」视角与 DeepSeek 子午老师 / 鲸鱼娘上手预设角色（尊重用户手动删除记录）
    let addedSelfChar = false
    const starterList = createBuiltinStarterCharacters()
    const starterMap = new Map(starterList.map((s) => [s.id, s]))
    const LEGACY_GENERATED_AVATARS = new Set([
      'avatars/ziwu-1.jpg',
      'avatars/ziwu-2.jpg',
      'avatars/jingyu-1.jpg',
      'avatars/jingyu-2.jpg',
    ])
    for (let i = 0; i < components.length; i += 1) {
      const c = components[i]!
      const starter = starterMap.get(c.id)
      if (starter && c.avatar && LEGACY_GENERATED_AVATARS.has(c.avatar)) {
        const migrated = { ...c, avatar: starter.avatar }
        await storage.upsertComponent(migrated)
        components[i] = migrated
      }
    }
    const existingIds = new Set(components.map((c) => c.id))
    for (const starter of starterList) {
      if (!existingIds.has(starter.id) && !deletedIds[starter.id]) {
        await storage.upsertComponent(starter)
        components = [starter, ...components]
        if (starter.id === BUILTIN_SELF_CHARACTER_ID) addedSelfChar = true
      }
    }

    const defaultSelfId =
      components.find((c) => c.id === BUILTIN_SELF_CHARACTER_ID)?.id ??
      components.find((c) => c.kind === 'character' && c.name === '我')?.id

    let sessions = await storage.listSessions()
    let activeSessionId: string | null = sessions[0]?.id ?? null

    if (sessions.length === 0) {
      const firstSession: ChatSession = {
        id: uid('sess'),
        title: '新对话',
        mounts: [],
        userCharacterId: defaultSelfId,
        authorsNote: '',
        authorsNoteDepth: 4,
        multiCharMode: 'shuffled_round',
        groupConfig: { ...DEFAULT_GROUP_CHAT_CONFIG },
        activeLeafId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await storage.upsertSession(firstSession)
      sessions = [firstSession]
      activeSessionId = firstSession.id
    } else {
      const nextSessions: ChatSession[] = []
      for (const s of sessions) {
        let next = s
        let changed = false
        if (addedSelfChar && defaultSelfId && sessions.length === 1 && !next.userCharacterId) {
          next = { ...next, userCharacterId: defaultSelfId }
          changed = true
        }
        // 将旧版未配置 groupConfig 的默认 narrator 会话平滑升级为随机轮流（shuffled_round）
        if (next.multiCharMode === 'narrator' && !next.groupConfig) {
          next = {
            ...next,
            multiCharMode: 'shuffled_round',
            groupConfig: { ...DEFAULT_GROUP_CHAT_CONFIG },
          }
          changed = true
        }
        if (changed) {
          next = { ...next, updatedAt: Date.now() }
          await storage.upsertSession(next)
        }
        nextSessions.push(next)
      }
      sessions = nextSessions
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

  reloadFromStorage: async () => {
    const prev = get()
    const [components, sessions] = await Promise.all([
      storage.listComponents(),
      storage.listSessions(),
    ])
    const activeSessionId =
      prev.activeSessionId && sessions.some((s) => s.id === prev.activeSessionId)
        ? prev.activeSessionId
        : (sessions[0]?.id ?? null)

    const sessionIdsToLoad = new Set<string>(Object.keys(prev.messagesBySession))
    if (activeSessionId) sessionIdsToLoad.add(activeSessionId)
    const validIds = new Set(sessions.map((s) => s.id))
    const entries = await Promise.all(
      [...sessionIdsToLoad]
        .filter((id) => validIds.has(id))
        .map(async (id) => [id, await storage.listMessages(id)] as const)
    )
    const messagesBySession: Record<string, ChatMessage[]> = {}
    for (const [id, msgs] of entries) {
      messagesBySession[id] = msgs
    }
    set({
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
    recordSyncDeletion(id)
    // 同步从所有会话的挂载与出发视角中清理
    const nextSessions: ChatSession[] = []
    for (const s of get().sessions) {
      const isPov = s.userCharacterId === id
      if (s.mounts.some((m) => m.componentId === id) || isPov) {
        const cleaned = {
          ...s,
          mounts: s.mounts.filter((m) => m.componentId !== id),
          ...(isPov ? { userCharacterId: undefined } : {}),
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

  createSession: async (initialMounts = [], title = '新对话', extra) => {
    const now = Date.now()
    const components = get().components
    const defaultSelfId =
      components.find((c) => c.id === BUILTIN_SELF_CHARACTER_ID)?.id ??
      components.find((c) => c.kind === 'character' && c.name === '我')?.id
    const session: ChatSession = {
      id: uid('sess'),
      title,
      mounts: initialMounts,
      userCharacterId: defaultSelfId,
      authorsNote: '',
      authorsNoteDepth: 4,
      multiCharMode: extra?.multiCharMode ?? 'shuffled_round',
      groupConfig: extra?.groupConfig
        ? { ...DEFAULT_GROUP_CHAT_CONFIG, ...extra.groupConfig }
        : { ...DEFAULT_GROUP_CHAT_CONFIG },
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

  setSessionPinned: async (id, pinned) => {
    const session = get().sessions.find((s) => s.id === id)
    if (!session) return
    const updated = { ...session, pinned, updatedAt: Date.now() }
    await storage.upsertSession(updated)
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
    }))
  },

  deleteSession: async (id) => {
    get().stopStreaming(id)
    const msgIds = (get().messagesBySession[id] ?? []).map((m) => m.id)
    await storage.deleteSession(id)
    recordSyncDeletion([id, ...msgIds])
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

  clearContextCheckpoints: async (sessionId) => {
    const state = get()
    const targetId = sessionId ?? state.activeSessionId
    if (!targetId) return
    const session = state.sessions.find((s) => s.id === targetId)
    if (!session || !session.contextCheckpoints?.length) return
    const updated: ChatSession = {
      ...session,
      contextCheckpoints: undefined,
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
    get().showToast('已清除上下文记忆，后续将重新使用完整历史', 'info')
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
      userCharacterId:
        justAdded && comp.kind === 'character' && session.userCharacterId === comp.id
          ? undefined
          : session.userCharacterId,
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
    const updated: ChatSession = {
      ...session,
      multiCharMode,
      groupConfig: session.groupConfig ?? { ...DEFAULT_GROUP_CHAT_CONFIG },
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  updateGroupConfig: async (patch) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = {
      ...session,
      groupConfig: { ...resolveGroupChatConfig(session), ...patch },
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  moveCharMountOrder: async (componentId, delta) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const sortedChars = session.mounts
      .filter((m) => m.kind === 'character')
      .sort((a, b) => a.order - b.order)
    const idx = sortedChars.findIndex((m) => m.componentId === componentId)
    const targetIdx = idx + delta
    if (idx === -1 || targetIdx < 0 || targetIdx >= sortedChars.length) return
    const reordered = [...sortedChars]
    const [picked] = reordered.splice(idx, 1)
    reordered.splice(targetIdx, 0, picked!)
    const orderMap = new Map(reordered.map((m, i) => [m.componentId, i]))
    const nextMounts = session.mounts.map((m) =>
      m.kind === 'character' && orderMap.has(m.componentId)
        ? { ...m, order: orderMap.get(m.componentId)! }
        : m
    )
    const updated: ChatSession = { ...session, mounts: nextMounts, updatedAt: Date.now() }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  updateCharMountMeta: async (componentId, patch) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const updated: ChatSession = {
      ...session,
      mounts: session.mounts.map((m) => (m.componentId === componentId ? { ...m, ...patch } : m)),
      updatedAt: Date.now(),
    }
    await storage.upsertSession(updated)
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === updated.id ? updated : item)),
    }))
  },

  setUserCharacter: async (characterId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    const character = characterId
      ? state.components.find((c) => c.id === characterId && c.kind === 'character')
      : undefined
    if (characterId && !character) return
    const updated: ChatSession = {
      ...session,
      userCharacterId: character ? character.id : undefined,
      mounts: character
        ? session.mounts.filter((m) => m.componentId !== character.id)
        : session.mounts,
      updatedAt: Date.now(),
    }
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

    const pov = session.userCharacterId
      ? (state.components.find(
          (c) => c.id === session.userCharacterId && c.kind === 'character'
        ) as CharacterComponent | undefined)
      : undefined
    const personaMount = session.mounts.find((m) => m.kind === 'persona' && m.enabled)
    const persona = personaMount
      ? (state.components.find((c) => c.id === personaMount.componentId) as
          | PersonaComponent
          | undefined)
      : undefined
    const userName = pov?.name || persona?.payload.displayName?.trim() || persona?.name || '用户'
    const personaText = pov
      ? [
          pov.payload.description.trim(),
          pov.payload.personality.trim() ? `性格特点：${pov.payload.personality.trim()}` : '',
          pov.payload.scenario.trim() ? `当前处境：${pov.payload.scenario.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      : persona?.payload.description ?? ''

    const rendered = substituteMacros(raw, {
      charName: comp.name,
      userName,
      persona: personaText,
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
    const view = resolveContextView(session, allMsgs, session.activeLeafId)
    const settings = useSettings.getState()
    return assemblePrompt({
      session,
      history: view.history,
      components: state.components,
      nextSpeakerId,
      defaultMaxContextTokens: settings.defaultMaxContextTokens,
      defaultMaxResponseTokens: settings.defaultMaxResponseTokens,
      contextSummary: view.checkpoint?.summary,
    })
  },

  stopStreaming: (sessionId) => {
    const targetId = sessionId ?? get().activeSessionId
    if (!targetId) return
    stoppedQueueSessions.add(targetId)
    const active = get().streamingBySession[targetId]
    if (active) {
      active.controller.abort()
      set((s) => {
        const next = { ...s.streamingBySession }
        delete next[targetId]
        return { streamingBySession: next }
      })
    }
    const targetSession = get().sessions.find((s) => s.id === targetId)
    if (targetSession?.groupConfig?.autoMode) {
      const paused: ChatSession = {
        ...targetSession,
        groupConfig: { ...resolveGroupChatConfig(targetSession), autoMode: false },
        updatedAt: Date.now(),
      }
      void storage.upsertSession(paused)
      set((s) => ({
        sessions: s.sessions.map((item) => (item.id === paused.id ? paused : item)),
      }))
    }
  },

  sendMessage: async (text, options) => {
    const trimmed = text.trim()
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    if (
      state.streamingBySession[session.id] ||
      state.activeGroupRoundBySession[session.id] ||
      state.compactingBySession[session.id]
    ) {
      return
    }
    stoppedQueueSessions.delete(session.id)

    const existing = state.messagesBySession[session.id] ?? []
    let parentId = session.activeLeafId
    let nextMsgs = [...existing]
    const now = Date.now()

    if (trimmed) {
      const povComp = session.userCharacterId
        ? state.components.find((c) => c.id === session.userCharacterId)
        : undefined
      const userMsg: ChatMessage = {
        id: uid('msg'),
        sessionId: session.id,
        parentId,
        role: 'user',
        speakerName: povComp?.name,
        speakerAvatar: povComp?.avatar,
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

    await runGroupTurn(get, set, updatedSession.id, parentId, {
      explicitSpeakerId: options?.nextSpeakerId,
      isAutoContinuation: !trimmed,
    })
  },

  triggerGroupRound: async (options) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    if (
      state.streamingBySession[session.id] ||
      state.activeGroupRoundBySession[session.id] ||
      state.compactingBySession[session.id]
    ) {
      return
    }
    stoppedQueueSessions.delete(session.id)
    await runGroupTurn(get, set, session.id, session.activeLeafId, {
      explicitSpeakerId: options?.speakerId,
      isAutoContinuation: options?.isAutoContinuation ?? true,
    })
  },

  regenerateMessage: async (messageId, nextSpeakerId) => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    if (state.compactingBySession[session.id] || state.streamingBySession[session.id]) return
    stoppedQueueSessions.delete(session.id)
    const allMsgs = state.messagesBySession[session.id] ?? []
    const target = allMsgs.find((m) => m.id === messageId)
    if (!target || target.role !== 'assistant') return

    const activeChars = getOrderedActiveChars(session, state.components)
    const targetSpeakerId = nextSpeakerId ?? target.speakerId
    const speaker = targetSpeakerId
      ? activeChars.find((c) => c.id === targetSpeakerId)
      : session.multiCharMode === 'narrator' && activeChars.length > 1
        ? undefined
        : activeChars[0]

    // 在同一个 parentId 下生成新的兄弟回复分支（即酒馆 Swipe 机制！）
    await generateSingleSpeakerReply(get, set, session.id, target.parentId, {
      speaker,
      isNarrator: session.multiCharMode === 'narrator' && activeChars.length > 1 && !speaker,
      mode: 'normal',
    })
  },

  continueLastMessage: async () => {
    const state = get()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    if (!session) return
    if (state.compactingBySession[session.id] || state.streamingBySession[session.id]) return
    stoppedQueueSessions.delete(session.id)
    const allMsgs = state.messagesBySession[session.id] ?? []
    const path = resolveActivePath(allMsgs, session.activeLeafId)
    const last = path.at(-1)
    if (!last) return
    const activeChars = getOrderedActiveChars(session, state.components)
    const speaker = last.speakerId ? activeChars.find((c) => c.id === last.speakerId) : undefined
    await generateSingleSpeakerReply(get, set, session.id, last.id, {
      speaker,
      isNarrator: session.multiCharMode === 'narrator' && activeChars.length > 1 && !speaker,
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
    recordSyncDeletion([...toDelete])
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
    const pendingGroups: Array<{
      name: string
      memberNames: string[]
      multiCharMode?: MultiCharMode
      groupConfig?: Partial<GroupChatConfig>
    }> = []

    for (const file of files) {
      try {
        const lower = file.name.toLowerCase()
        const isBinaryAsset =
          lower.endsWith('.png') ||
          lower.endsWith('.charx') ||
          lower.endsWith('.zip') ||
          lower.endsWith('.card')
        const content: Uint8Array | string = isBinaryAsset
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
          pendingGroups.push({
            name: result.name,
            memberNames: result.memberNames,
            multiCharMode: result.multiCharMode,
            groupConfig: result.groupConfig,
          })
        } else if (result.kind === 'chat_jsonl') {
          const now = Date.now()
          const importedSession: ChatSession = {
            id: newSessionId,
            title: result.title || file.name.replace(/\.jsonl$/i, ''),
            mounts: [],
            authorsNote: '',
            authorsNoteDepth: 4,
            multiCharMode: 'shuffled_round',
            groupConfig: { ...DEFAULT_GROUP_CHAT_CONFIG },
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
      await get().createSession(mounts, grp.name, {
        multiCharMode: grp.multiCharMode,
        groupConfig: grp.groupConfig
          ? { ...DEFAULT_GROUP_CHAT_CONFIG, ...grp.groupConfig }
          : undefined,
      })
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

function getOrderedActiveChars(
  session: ChatSession,
  components: ComponentItem[]
): CharacterComponent[] {
  const byId = new Map(components.map((c) => [c.id, c]))
  return session.mounts
    .filter((m) => m.enabled && m.kind === 'character' && m.componentId !== session.userCharacterId)
    .sort((a, b) => a.order - b.order)
    .map((m) => byId.get(m.componentId))
    .filter((c): c is CharacterComponent => Boolean(c && c.kind === 'character'))
}

async function runGroupTurn(
  get: () => AppStoreState,
  set: (
    partial:
      | Partial<AppStoreState>
      | ((state: AppStoreState) => Partial<AppStoreState>)
  ) => void,
  sessionId: string,
  initialParentId: string | null,
  options: { explicitSpeakerId?: string; isAutoContinuation?: boolean }
) {
  const state = get()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return

  const activeChars = getOrderedActiveChars(session, state.components)
  const allMsgs = state.messagesBySession[sessionId] ?? []
  const view = resolveContextView(session, allMsgs, initialParentId)

  const draft = draftGroupSpeakers({
    session,
    activeChars,
    history: view.path,
    explicitSpeakerId: options.explicitSpeakerId,
    isAutoContinuation: options.isAutoContinuation,
  })

  if (draft.kind === 'narrator') {
    await generateSingleSpeakerReply(get, set, sessionId, initialParentId, {
      isNarrator: true,
      mode: 'normal',
    })
    return
  }

  if (draft.speakers.length === 0) {
    if (draft.reason === 'no_characters') {
      await generateSingleSpeakerReply(get, set, sessionId, initialParentId, { mode: 'normal' })
    } else if (draft.reason === 'all_muted') {
      get().showToast('当前在场角色已全部静音，请取消静音或点击某位角色发言', 'info')
    } else if (draft.reason === 'manual_wait') {
      get().showToast('当前为手动点名模式：请点击下方角色头像让 TA 发言', 'info')
    }
    return
  }

  set((s) => ({
    activeGroupRoundBySession: { ...s.activeGroupRoundBySession, [sessionId]: true },
  }))

  try {
    let currentParentId = initialParentId
    for (const speaker of draft.speakers) {
      if (stoppedQueueSessions.has(sessionId)) break
      const res = await generateSingleSpeakerReply(get, set, sessionId, currentParentId, {
        speaker,
        mode: 'normal',
      })
      if (!res.ok || stoppedQueueSessions.has(sessionId)) {
        const latestSession = get().sessions.find((s) => s.id === sessionId)
        if (latestSession?.groupConfig?.autoMode) {
          const paused: ChatSession = {
            ...latestSession,
            groupConfig: { ...resolveGroupChatConfig(latestSession), autoMode: false },
            updatedAt: Date.now(),
          }
          await storage.upsertSession(paused)
          set((s) => ({
            sessions: s.sessions.map((item) => (item.id === paused.id ? paused : item)),
          }))
        }
        break
      }
      currentParentId = res.messageId
    }
  } finally {
    set((s) => {
      const next = { ...s.activeGroupRoundBySession }
      delete next[sessionId]
      return { activeGroupRoundBySession: next }
    })
  }
}

async function generateSingleSpeakerReply(
  get: () => AppStoreState,
  set: (
    partial:
      | Partial<AppStoreState>
      | ((state: AppStoreState) => Partial<AppStoreState>)
  ) => void,
  sessionId: string,
  parentId: string | null,
  options: { speaker?: CharacterComponent; isNarrator?: boolean; mode: 'normal' | 'continue' }
): Promise<{ ok: boolean; messageId: string | null }> {
  const state = get()
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session) return { ok: false, messageId: null }

  const settings = useSettings.getState()
  const provider = getActiveProvider(settings)

  const allMsgs = state.messagesBySession[sessionId] ?? []
  const initialView = resolveContextView(session, allMsgs, parentId)
  let workingSession = session
  const speaker = options.speaker

  let assembled = assemblePrompt({
    session: workingSession,
    history: initialView.history,
    components: state.components,
    nextSpeakerId: speaker?.id,
    defaultMaxContextTokens: settings.defaultMaxContextTokens,
    defaultMaxResponseTokens: settings.defaultMaxResponseTokens,
    contextSummary: initialView.checkpoint?.summary,
    mode: options.mode,
  })

  if (settings.contextCompression !== 'off') {
    const budget = resolveCompactionBudget(
      assembled.maxContextTokens,
      settings.contextCompression
    )
    const needsCompaction =
      assembled.droppedHistoryCount > 0 || assembled.totalTokens >= budget.triggerTokens
    if (needsCompaction) {
      const plan = planCompaction({
        history: initialView.path,
        activeCheckpoint: initialView.checkpoint,
        budget,
        estimatedTokens: assembled.totalTokens,
        force: assembled.droppedHistoryCount > 0,
      })
      if (plan) {
        try {
          set((s) => ({
            compactingBySession: {
              ...s.compactingBySession,
              [sessionId]: { chunk: 1, total: plan.chunks.length },
            },
          }))
          get().showToast('正在整理早期对话的上下文记忆…', 'info')
          const checkpoint = await runCompaction({
            plan,
            provider,
            budget,
            customGatewayOrigin: settings.customGatewayOrigin,
            onProgress: (chunk, total) =>
              set((s) => ({
                compactingBySession: {
                  ...s.compactingBySession,
                  [sessionId]: { chunk, total },
                },
              })),
          })
          const checkpoints = [
            ...(workingSession.contextCheckpoints ?? []),
            checkpoint,
          ].slice(-8)
          workingSession = {
            ...workingSession,
            contextCheckpoints: checkpoints,
            updatedAt: Date.now(),
          }
          await storage.upsertSession(workingSession)
          set((s) => ({
            sessions: s.sessions.map((item) =>
              item.id === workingSession.id ? workingSession : item
            ),
          }))

          const view = resolveContextView(workingSession, allMsgs, parentId)
          assembled = assemblePrompt({
            session: workingSession,
            history: view.history,
            components: state.components,
            nextSpeakerId: speaker?.id,
            defaultMaxContextTokens: settings.defaultMaxContextTokens,
            defaultMaxResponseTokens: settings.defaultMaxResponseTokens,
            contextSummary: view.checkpoint?.summary,
            mode: options.mode,
          })
          get().showToast(
            `已压缩 ${plan.coveredRounds} 轮早期对话，原始消息仍保留`,
            'success'
          )
        } catch (err) {
          if (!(err instanceof Error) || !err.message.includes('aborted')) {
            get().showToast('上下文压缩失败，本次临时沿用旧消息裁剪', 'error')
          }
        } finally {
          set((s) => {
            const next = { ...s.compactingBySession }
            delete next[sessionId]
            return { compactingBySession: next }
          })
        }
      }
    }
  }

  const now = Date.now()
  const assistantMsg: ChatMessage = {
    id: uid('msg'),
    sessionId,
    parentId,
    role: 'assistant',
    speakerId: speaker?.id,
    speakerName:
      speaker?.name ?? (options.isNarrator ? '场景演绎' : undefined),
    speakerAvatar: speaker?.avatar,
    content: '',
    reasoning: '',
    triggeredWorld: assembled.triggeredWorld,
    createdAt: now,
    updatedAt: now,
  }

  await storage.upsertMessage(assistantMsg)
  const updatedSession: ChatSession = {
    ...workingSession,
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
  let succeeded = false

  const flushMessageToState = (persistNow: boolean) => {
    const cleanContent = speaker
      ? stripLeadingSpeakerPrefix(accContent, speaker.name)
      : accContent
    const updatedMsg: ChatMessage = {
      ...assistantMsg,
      content: cleanContent,
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
    succeeded = !controller.signal.aborted
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
  return { ok: succeeded, messageId: assistantMsg.id }
}

registerStoreSyncReload(() => useAppStore.getState().reloadFromStorage())

useAppStore.subscribe((state, prev) => {
  if (!state.ready || !prev.ready || isApplyingRemoteSync()) return
  if (Object.keys(state.streamingBySession).length > 0) return
  if (
    state.components !== prev.components ||
    state.sessions !== prev.sessions ||
    state.messagesBySession !== prev.messagesBySession ||
    state.streamingBySession !== prev.streamingBySession
  ) {
    scheduleSyncPush()
  }
})

useSettings.subscribe((state, prev) => {
  if (isApplyingRemoteSync()) return
  if (state.settingsUpdatedAt !== prev.settingsUpdatedAt) {
    scheduleSyncPush()
  }
})
