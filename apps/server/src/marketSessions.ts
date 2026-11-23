import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type StoredMarketSession = {
  cookie: string
  user?: unknown
  savedAt: number
}

type SessionFile = Record<string, StoredMarketSession>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sessionDir = path.join(os.homedir(), '.tavernchat')
const sessionFile = path.join(sessionDir, 'market-sessions.json')

let cache: SessionFile | null = null
let writeChain: Promise<void> = Promise.resolve()

async function loadSessions(): Promise<SessionFile> {
  if (cache) return cache
  try {
    const raw = await readFile(sessionFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    cache = isRecord(parsed) ? (parsed as SessionFile) : {}
  } catch {
    cache = {}
  }
  return cache
}

async function persistSessions(): Promise<void> {
  if (!cache) return
  const snapshot = JSON.stringify(cache, null, 2)
  writeChain = writeChain
    .then(async () => {
      await mkdir(sessionDir, { recursive: true })
      const tempFile = sessionFile + '.tmp'
      await writeFile(tempFile, snapshot, 'utf8')
      await rename(tempFile, sessionFile)
    })
    .catch(() => {
      // 会话写盘失败不应影响当前请求。
    })
  await writeChain
}

export async function getMarketSession(pluginId: string): Promise<StoredMarketSession | undefined> {
  const sessions = await loadSessions()
  return sessions[pluginId]
}

export async function setMarketSession(
  pluginId: string,
  cookie: string,
  user?: unknown
): Promise<void> {
  const sessions = await loadSessions()
  sessions[pluginId] = { cookie, user, savedAt: Date.now() }
  await persistSessions()
}

export async function clearMarketSession(pluginId: string): Promise<void> {
  const sessions = await loadSessions()
  delete sessions[pluginId]
  await persistSessions()
}
