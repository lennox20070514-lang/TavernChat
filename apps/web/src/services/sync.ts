import {
  mergeSyncSnapshots,
  parseSyncSnapshot,
  type TavernSyncSnapshot,
} from '@tavern-chat/core'
import { create } from 'zustand'
import { probeTavernHealth, resolveSyncHostOrigin } from './llm/client.ts'
import {
  getNativeLanHostStatus,
  startNativeLanHost,
  stopNativeLanHost,
  subscribeAndroidLanSync,
  type LanHostStatus,
} from './lanHost.ts'
import { toSyncSettingsSnapshot, useSettings } from './settings.ts'
import { storage } from './storage/indexedDbAdapter.ts'

const DELETED_IDS_KEY = 'tavernchat.sync.deletedIds.v1'

export function readSyncDeletedIds(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DELETED_IDS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const next: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) next[k] = v
    }
    return next
  } catch {
    return {}
  }
}

function writeSyncDeletedIds(deletedIds: Record<string, number>): void {
  try {
    localStorage.setItem(DELETED_IDS_KEY, JSON.stringify(deletedIds))
  } catch {
    // 忽略配额限制
  }
}

export function recordSyncDeletion(ids: string | string[]): void {
  const list = Array.isArray(ids) ? ids : [ids]
  if (list.length === 0) return
  const map = readSyncDeletedIds()
  const now = Date.now()
  for (const id of list) {
    if (id) map[id] = now
  }
  writeSyncDeletedIds(map)
}

export async function buildLocalSyncSnapshot(): Promise<TavernSyncSnapshot> {
  const [components, sessions, messages] = await Promise.all([
    storage.listComponents(),
    storage.listSessions(),
    storage.listAllMessages(),
  ])
  const deletedIds = readSyncDeletedIds()
  const settings = toSyncSettingsSnapshot(useSettings.getState())
  const latestDataTs = Math.max(
    0,
    settings.updatedAt,
    ...components.map((c) => c.updatedAt),
    ...sessions.map((s) => s.updatedAt),
    ...messages.map((m) => m.updatedAt),
    ...Object.values(deletedIds)
  )
  return {
    schema: 1,
    revision: useSyncStore.getState().revision,
    updatedAt: latestDataTs,
    components,
    sessions,
    messages,
    deletedIds,
    settings,
  }
}

let applyingRemoteSync = false
export const isApplyingRemoteSync = (): boolean => applyingRemoteSync

type ReloadCallback = () => Promise<void>
let storeReloadHook: ReloadCallback | null = null
export function registerStoreSyncReload(cb: ReloadCallback): void {
  storeReloadHook = cb
}

async function applyMergedSnapshotToLocal(
  local: TavernSyncSnapshot,
  merged: TavernSyncSnapshot
): Promise<boolean> {
  let changed = false
  applyingRemoteSync = true
  try {
    const localCompMap = new Map(local.components.map((c) => [c.id, c]))
    const mergedCompIds = new Set<string>()
    for (const c of merged.components) {
      mergedCompIds.add(c.id)
      const prev = localCompMap.get(c.id)
      if (!prev || c.updatedAt > prev.updatedAt) {
        await storage.upsertComponent(c)
        changed = true
      }
    }
    for (const prev of local.components) {
      if (!mergedCompIds.has(prev.id)) {
        await storage.deleteComponent(prev.id)
        changed = true
      }
    }

    const localSessMap = new Map(local.sessions.map((s) => [s.id, s]))
    const mergedSessIds = new Set<string>()
    for (const s of merged.sessions) {
      mergedSessIds.add(s.id)
      const prev = localSessMap.get(s.id)
      if (!prev || s.updatedAt > prev.updatedAt) {
        await storage.upsertSession(s)
        changed = true
      }
    }
    for (const prev of local.sessions) {
      if (!mergedSessIds.has(prev.id)) {
        await storage.deleteSession(prev.id)
        changed = true
      }
    }

    const localMsgMap = new Map(local.messages.map((m) => [m.id, m]))
    const mergedMsgIds = new Set<string>()
    for (const m of merged.messages) {
      mergedMsgIds.add(m.id)
      const prev = localMsgMap.get(m.id)
      if (!prev || m.updatedAt > prev.updatedAt) {
        await storage.upsertMessage(m)
        changed = true
      }
    }
    const orphanDeleteBySession = new Map<string, string[]>()
    for (const prev of local.messages) {
      if (!mergedMsgIds.has(prev.id)) {
        const list = orphanDeleteBySession.get(prev.sessionId) ?? []
        list.push(prev.id)
        orphanDeleteBySession.set(prev.sessionId, list)
      }
    }
    for (const [sid, ids] of orphanDeleteBySession) {
      await storage.deleteMessages(sid, ids)
      changed = true
    }

    writeSyncDeletedIds(merged.deletedIds)
    if (merged.settings && useSettings.getState().applySyncedSettings(merged.settings)) {
      changed = true
    }

    if (changed && storeReloadHook) {
      await storeReloadHook()
    }
  } finally {
    applyingRemoteSync = false
  }
  return changed
}

function snapshotsNeedUpload(merged: TavernSyncSnapshot, remote: TavernSyncSnapshot): boolean {
  if (merged.components.length !== remote.components.length) return true
  if (merged.sessions.length !== remote.sessions.length) return true
  if (merged.messages.length !== remote.messages.length) return true
  if (merged.updatedAt > remote.updatedAt) return true
  if (
    merged.settings &&
    (!remote.settings || merged.settings.updatedAt > remote.settings.updatedAt)
  ) {
    return true
  }
  const remoteCompMap = new Map(remote.components.map((c) => [c.id, c.updatedAt]))
  if (merged.components.some((c) => (remoteCompMap.get(c.id) ?? -1) < c.updatedAt)) return true
  const remoteSessMap = new Map(remote.sessions.map((s) => [s.id, s.updatedAt]))
  if (merged.sessions.some((s) => (remoteSessMap.get(s.id) ?? -1) < s.updatedAt)) return true
  const remoteMsgMap = new Map(remote.messages.map((m) => [m.id, m.updatedAt]))
  if (merged.messages.some((m) => (remoteMsgMap.get(m.id) ?? -1) < m.updatedAt)) return true
  return false
}

export type SyncRole = 'idle' | 'host' | 'client'

type SyncState = {
  role: SyncRole
  hostStatus: LanHostStatus
  syncOrigin: string | null
  revision: number
  syncing: boolean
  lastSyncedAt: number | null
  lastError: string
  initSyncSession: () => Promise<void>
  startHost: () => Promise<LanHostStatus>
  stopHost: () => Promise<void>
  syncNow: (forcePush?: boolean) => Promise<void>
  connectClientToOrigin: (origin: string) => Promise<boolean>
}

let pollTimer: number | null = null
let pushDebounceTimer: number | null = null
let androidPushUnsubscribe: (() => void) | null = null
let syncInFlight = false

export const useSyncStore = create<SyncState>((set, get) => ({
  role: 'idle',
  hostStatus: { running: false, url: '', ip: '', port: 0 },
  syncOrigin: null,
  revision: 0,
  syncing: false,
  lastSyncedAt: null,
  lastError: '',

  initSyncSession: async () => {
    const nativeStatus = await getNativeLanHostStatus()
    if (nativeStatus.running && nativeStatus.url) {
      set({
        role: 'host',
        hostStatus: nativeStatus,
        syncOrigin: `http://127.0.0.1:${nativeStatus.port}`,
        lastError: '',
      })
      startSyncLoop()
      await get().syncNow(true)
      return
    }

    const settings = useSettings.getState()
    const syncOrigin = await resolveSyncHostOrigin(settings.customGatewayOrigin)
    if (syncOrigin !== null) {
      set({ role: 'client', syncOrigin, lastError: '' })
      startSyncLoop()
      await get().syncNow(false)
    }
  },

  startHost: async () => {
    const status = await startNativeLanHost()
    const hostSyncUrl = status.port ? `http://127.0.0.1:${status.port}` : status.url
    set({
      role: 'host',
      hostStatus: status,
      syncOrigin: hostSyncUrl,
      lastError: '',
    })
    startSyncLoop()
    await get().syncNow(true)
    return status
  },

  stopHost: async () => {
    stopSyncLoop()
    const status = await stopNativeLanHost()
    set({
      role: 'idle',
      hostStatus: status,
      syncOrigin: null,
      lastError: '',
    })
  },

  connectClientToOrigin: async (rawOrigin) => {
    const clean = rawOrigin.trim().replace(/\/+$/, '')
    if (!clean) {
      stopSyncLoop()
      set({ role: 'idle', syncOrigin: null, lastError: '' })
      return false
    }
    const health = await probeTavernHealth(clean)
    if (!health?.capabilities?.sync) {
      set({ lastError: '该地址未开启多设备同步服务' })
      return false
    }
    set({ role: 'client', syncOrigin: clean, lastError: '' })
    startSyncLoop()
    await get().syncNow(false)
    return true
  },

  syncNow: async (forcePush = false) => {
    const { syncOrigin, role } = get()
    if (syncOrigin === null || role === 'idle' || syncInFlight) return
    syncInFlight = true
    set({ syncing: true })
    try {
      const getRes = await fetch(`${syncOrigin}/api/v1/sync/snapshot`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      if (!getRes.ok) throw new Error(`HTTP ${getRes.status}`)
      const getPayload = (await getRes.json()) as { snapshot?: unknown }
      const remote = parseSyncSnapshot(getPayload.snapshot)

      const local = await buildLocalSyncSnapshot()
      let merged = mergeSyncSnapshots(local, remote)

      await applyMergedSnapshotToLocal(local, merged)

      let activeRevision = remote.revision
      if (forcePush || snapshotsNeedUpload(merged, remote)) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const postRes = await fetch(`${syncOrigin}/api/v1/sync/snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ snapshot: merged, baseRevision: activeRevision }),
            signal: AbortSignal.timeout(8000),
          })
          const postPayload = (await postRes.json()) as {
            ok?: boolean
            conflict?: boolean
            snapshot?: unknown
            error?: string
          }
          if (postRes.status === 409 && postPayload.snapshot) {
            const newerRemote = parseSyncSnapshot(postPayload.snapshot)
            const freshLocal = await buildLocalSyncSnapshot()
            merged = mergeSyncSnapshots(freshLocal, newerRemote)
            await applyMergedSnapshotToLocal(freshLocal, merged)
            activeRevision = newerRemote.revision
            continue
          }
          if (!postRes.ok || !postPayload.ok) {
            throw new Error(postPayload.error || `HTTP ${postRes.status}`)
          }
          if (postPayload.snapshot) {
            const committed = parseSyncSnapshot(postPayload.snapshot)
            activeRevision = committed.revision
          } else {
            activeRevision += 1
          }
          break
        }
      }

      set({
        revision: activeRevision,
        lastSyncedAt: Date.now(),
        lastError: '',
      })
    } catch (err) {
      set({
        lastError: err instanceof Error ? err.message : String(err),
      })
    } finally {
      syncInFlight = false
      set({ syncing: false })
    }
  },
}))

function stopSyncLoop(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
  if (pushDebounceTimer !== null) {
    window.clearTimeout(pushDebounceTimer)
    pushDebounceTimer = null
  }
  if (androidPushUnsubscribe) {
    androidPushUnsubscribe()
    androidPushUnsubscribe = null
  }
}

function startSyncLoop(): void {
  stopSyncLoop()
  pollTimer = window.setInterval(() => {
    void useSyncStore.getState().syncNow(false)
  }, 1800)
  void subscribeAndroidLanSync(() => {
    void useSyncStore.getState().syncNow(false)
  }).then((unsub) => {
    androidPushUnsubscribe = unsub
  })
}

export function scheduleSyncPush(): void {
  const { role } = useSyncStore.getState()
  if (role === 'idle' || applyingRemoteSync) return
  if (pushDebounceTimer !== null) window.clearTimeout(pushDebounceTimer)
  pushDebounceTimer = window.setTimeout(() => {
    pushDebounceTimer = null
    void useSyncStore.getState().syncNow(true)
  }, 420)
}
