import type { ContextCompressionMode } from './compaction.ts'
import type {
  ChatMessage,
  ChatSession,
  ComponentItem,
} from './types.ts'

export type TavernSyncSettings = {
  providers: unknown[]
  activeProviderId: string
  defaultMaxContextTokens: number
  defaultMaxResponseTokens: number
  contextCompression: ContextCompressionMode
  autoInsertGreeting: boolean
  updatedAt: number
}

export type TavernSyncSnapshot = {
  schema: 1
  revision: number
  updatedAt: number
  components: ComponentItem[]
  sessions: ChatSession[]
  messages: ChatMessage[]
  deletedIds: Record<string, number>
  settings?: TavernSyncSettings
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function createEmptySyncSnapshot(): TavernSyncSnapshot {
  return {
    schema: 1,
    revision: 0,
    updatedAt: 0,
    components: [],
    sessions: [],
    messages: [],
    deletedIds: {},
  }
}

export function parseSyncSnapshot(raw: unknown): TavernSyncSnapshot {
  if (!isRecord(raw)) {
    throw new Error('同步快照格式无效')
  }
  const components = Array.isArray(raw.components)
    ? (raw.components.filter(
        (c) => isRecord(c) && typeof c.id === 'string' && typeof c.updatedAt === 'number'
      ) as ComponentItem[])
    : []
  const sessions = Array.isArray(raw.sessions)
    ? (raw.sessions.filter(
        (s) => isRecord(s) && typeof s.id === 'string' && typeof s.updatedAt === 'number'
      ) as ChatSession[])
    : []
  const messages = Array.isArray(raw.messages)
    ? (raw.messages.filter(
        (m) => isRecord(m) && typeof m.id === 'string' && typeof m.sessionId === 'string'
      ) as ChatMessage[])
    : []

  const deletedIds: Record<string, number> = {}
  if (isRecord(raw.deletedIds)) {
    for (const [key, value] of Object.entries(raw.deletedIds)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        deletedIds[key] = value
      }
    }
  }

  let settings: TavernSyncSettings | undefined
  if (isRecord(raw.settings) && Array.isArray(raw.settings.providers)) {
    const compression = raw.settings.contextCompression
    settings = {
      providers: raw.settings.providers,
      activeProviderId:
        typeof raw.settings.activeProviderId === 'string' ? raw.settings.activeProviderId : '',
      defaultMaxContextTokens:
        typeof raw.settings.defaultMaxContextTokens === 'number'
          ? raw.settings.defaultMaxContextTokens
          : 32768,
      defaultMaxResponseTokens:
        typeof raw.settings.defaultMaxResponseTokens === 'number'
          ? raw.settings.defaultMaxResponseTokens
          : 2048,
      contextCompression:
        compression === 'off' || compression === 'balanced' || compression === 'extended'
          ? compression
          : 'balanced',
      autoInsertGreeting:
        typeof raw.settings.autoInsertGreeting === 'boolean'
          ? raw.settings.autoInsertGreeting
          : true,
      updatedAt:
        typeof raw.settings.updatedAt === 'number' && Number.isFinite(raw.settings.updatedAt)
          ? raw.settings.updatedAt
          : 0,
    }
  }

  return {
    schema: 1,
    revision: typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    components,
    sessions,
    messages,
    deletedIds,
    ...(settings ? { settings } : {}),
  }
}

function mergeById<T extends { id: string; updatedAt: number }>(
  primary: T[],
  secondary: T[],
  deletedIds: Record<string, number>
): T[] {
  const byId = new Map<string, T>()
  for (const item of primary) {
    byId.set(item.id, item)
  }
  for (const item of secondary) {
    const prev = byId.get(item.id)
    if (!prev || item.updatedAt > prev.updatedAt) {
      byId.set(item.id, item)
    }
  }
  const result: T[] = []
  for (const item of byId.values()) {
    const deletedAt = deletedIds[item.id] ?? 0
    if (deletedAt > item.updatedAt) continue
    result.push(item)
  }
  return result
}

function pruneDeletedIds(
  deletedIds: Record<string, number>,
  nowHint: number
): Record<string, number> {
  const entries = Object.entries(deletedIds)
  if (entries.length <= 500) return deletedIds
  const cutoff = nowHint - 30 * 24 * 60 * 60 * 1000
  const kept: Record<string, number> = {}
  for (const [id, ts] of entries) {
    if (ts >= cutoff) kept[id] = ts
  }
  return kept
}

/**
 * 确定性双向合并两份端到端数据快照（按 updatedAt + tombstone 解决冲突，不覆盖更新的一侧）。
 */
export function mergeSyncSnapshots(
  local: TavernSyncSnapshot,
  remote: TavernSyncSnapshot
): TavernSyncSnapshot {
  const rawDeleted: Record<string, number> = { ...local.deletedIds }
  for (const [id, ts] of Object.entries(remote.deletedIds)) {
    rawDeleted[id] = Math.max(rawDeleted[id] ?? 0, ts)
  }
  const latestTs = Math.max(local.updatedAt, remote.updatedAt)
  const deletedIds = pruneDeletedIds(rawDeleted, latestTs)

  const components = mergeById(local.components, remote.components, deletedIds).sort(
    (a, b) => b.updatedAt - a.updatedAt
  )
  const sessions = mergeById(local.sessions, remote.sessions, deletedIds).sort(
    (a, b) => b.updatedAt - a.updatedAt
  )
  const validSessionIds = new Set(sessions.map((s) => s.id))
  const messages = mergeById(local.messages, remote.messages, deletedIds)
    .filter((m) => validSessionIds.has(m.sessionId) && !((deletedIds[m.sessionId] ?? 0) > m.updatedAt))
    .sort((a, b) => a.createdAt - b.createdAt)

  let settings = local.settings ?? remote.settings
  if (local.settings && remote.settings) {
    settings =
      remote.settings.updatedAt > local.settings.updatedAt ? remote.settings : local.settings
  }

  return {
    schema: 1,
    revision: Math.max(local.revision, remote.revision),
    updatedAt: latestTs,
    components,
    sessions,
    messages,
    deletedIds,
    ...(settings ? { settings } : {}),
  }
}
