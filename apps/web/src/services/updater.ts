import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { create } from 'zustand'
import { createTimeoutSignal } from '../utils/compat.ts'
import { useSettings } from './settings.ts'

export const DEFAULT_PUBLIC_MIRROR_PREFIXES = [
  'https://gh-proxy.org/',
  'https://gh-proxy.com/',
  'https://cdn.gh-proxy.org/',
  'https://ghproxy.net/',
]

export const CURRENT_APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0'
export const CURRENT_ANDROID_VERSION_CODE =
  typeof __ANDROID_VERSION_CODE__ !== 'undefined' ? __ANDROID_VERSION_CODE__ : 1
export const BUILTIN_UPDATE_MANIFEST_URL =
  typeof __DEFAULT_UPDATE_MANIFEST_URL__ !== 'undefined'
    ? __DEFAULT_UPDATE_MANIFEST_URL__.trim()
    : ''
export const BUILTIN_UPDATE_MIRROR_URL =
  typeof __DEFAULT_UPDATE_MIRROR_URL__ !== 'undefined'
    ? __DEFAULT_UPDATE_MIRROR_URL__.trim()
    : ''

const LAST_CHECK_KEY = 'tavernchat.update.lastCheckAt.v1'
const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000

export type AppReleaseManifest = {
  version: string
  androidVersionCode?: number
  publishedAt?: string
  changelog?: string
  apkUrl?: string
  mirrorApkUrl?: string
  releasePageUrl?: string
}

export type AvailableUpdateInfo = {
  manifest: AppReleaseManifest
  preferredUrl: string
  fallbackUrl?: string
  viaMirror: boolean
}

export type UpdateCheckOutcome =
  | { status: 'update'; info: AvailableUpdateInfo }
  | { status: 'latest'; version: string }
  | { status: 'unconfigured' }
  | { status: 'skipped' }
  | { status: 'error'; message: string }

const normalizeSemver = (raw: string): [number, number, number] => {
  const cleaned = raw.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? ''
  const parts = cleaned.split('.').map((n) => Number.parseInt(n, 10) || 0)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

export function compareSemver(a: string, b: string): number {
  const pa = normalizeSemver(a)
  const pb = normalizeSemver(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! > pb[i]!) return 1
    if (pa[i]! < pb[i]!) return -1
  }
  return 0
}

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const splitMirrorEntries = (raw: string): string[] =>
  raw
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const normalizeMirrorPrefix = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.endsWith('.json') || !isHttpsUrl(trimmed)) return null
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

const applyMirrorPrefix = (targetUrl: string, mirrorOrPrefix: string): string | null => {
  const prefix = normalizeMirrorPrefix(mirrorOrPrefix)
  if (!prefix || !isHttpsUrl(targetUrl)) return null
  const candidate = `${prefix}${targetUrl}`
  return isHttpsUrl(candidate) ? candidate : null
}

export type ManifestCandidate = {
  url: string
  mirrorPrefix?: string
}

/** 生成版本清单检查顺序：优先自定义/多节点镜像站，最后回退 GitHub Release 原地址。 */
export function buildManifestCandidates(manifestUrl: string, mirrorConfig: string): string[] {
  return buildManifestCandidateEntries(manifestUrl, mirrorConfig).map((entry) => entry.url)
}

function buildManifestCandidateEntries(
  manifestUrl: string,
  mirrorConfig: string
): ManifestCandidate[] {
  const cleanManifest = manifestUrl.trim()
  const entries: ManifestCandidate[] = []
  const seen = new Set<string>()
  const push = (url: string, mirrorPrefix?: string) => {
    if (!url || seen.has(url) || !isHttpsUrl(url)) return
    seen.add(url)
    entries.push({ url, mirrorPrefix })
  }

  for (const rawMirror of splitMirrorEntries(mirrorConfig)) {
    if (rawMirror.endsWith('.json')) {
      push(rawMirror)
    } else if (cleanManifest) {
      const mirrored = applyMirrorPrefix(cleanManifest, rawMirror)
      const prefix = normalizeMirrorPrefix(rawMirror) ?? undefined
      if (mirrored) push(mirrored, prefix)
    }
  }

  if (cleanManifest) {
    for (const fallbackPrefix of DEFAULT_PUBLIC_MIRROR_PREFIXES) {
      const mirrored = applyMirrorPrefix(cleanManifest, fallbackPrefix)
      if (mirrored) push(mirrored, fallbackPrefix)
    }
    push(cleanManifest)
  }

  return entries
}

export function resolveDownloadLinks(
  manifest: AppReleaseManifest,
  mirrorConfig: string,
  preferredMirrorPrefix?: string
): { preferredUrl: string; fallbackUrl?: string; viaMirror: boolean } {
  const direct = manifest.apkUrl?.trim() || manifest.releasePageUrl?.trim() || ''
  const mirrorDirect = manifest.mirrorApkUrl?.trim() || ''
  const apkDirect = manifest.apkUrl?.trim() || ''

  // 若某个公共/自定义镜像刚成功拉取清单且拿到 APK 直链，优先复用同节点加速下载
  if (apkDirect && preferredMirrorPrefix) {
    const activeMirrored = applyMirrorPrefix(apkDirect, preferredMirrorPrefix)
    if (activeMirrored && activeMirrored !== apkDirect) {
      return {
        preferredUrl: activeMirrored,
        fallbackUrl: direct,
        viaMirror: true,
      }
    }
  }

  if (mirrorDirect && isHttpsUrl(mirrorDirect)) {
    return {
      preferredUrl: mirrorDirect,
      fallbackUrl: direct && direct !== mirrorDirect ? direct : undefined,
      viaMirror: true,
    }
  }

  if (direct) {
    const configuredPrefixes = splitMirrorEntries(mirrorConfig).filter((m) => !m.endsWith('.json'))
    const candidatePrefix =
      configuredPrefixes[0] || DEFAULT_PUBLIC_MIRROR_PREFIXES[0] || ''
    const prefixed = applyMirrorPrefix(direct, candidatePrefix)
    if (prefixed && prefixed !== direct) {
      return {
        preferredUrl: prefixed,
        fallbackUrl: direct,
        viaMirror: true,
      }
    }
  }

  return {
    preferredUrl: direct,
    viaMirror: false,
  }
}

export function parseReleaseManifest(raw: unknown): AppReleaseManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('更新清单格式无效')
  }
  const obj = raw as Record<string, unknown>
  const version = typeof obj.version === 'string' ? obj.version.trim().replace(/^v/i, '') : ''
  if (!version) throw new Error('更新清单缺少 version 字段')

  const validOptionalHttps = (v: unknown): string | undefined =>
    typeof v === 'string' && isHttpsUrl(v.trim()) ? v.trim() : undefined

  return {
    version,
    androidVersionCode:
      typeof obj.androidVersionCode === 'number' && Number.isFinite(obj.androidVersionCode)
        ? obj.androidVersionCode
        : undefined,
    publishedAt: typeof obj.publishedAt === 'string' ? obj.publishedAt.trim() : undefined,
    changelog: typeof obj.changelog === 'string' ? obj.changelog.trim() : undefined,
    apkUrl: validOptionalHttps(obj.apkUrl),
    mirrorApkUrl: validOptionalHttps(obj.mirrorApkUrl),
    releasePageUrl: validOptionalHttps(obj.releasePageUrl),
  }
}

export function isUpdateNewer(manifest: AppReleaseManifest): boolean {
  if (compareSemver(manifest.version, CURRENT_APP_VERSION) > 0) return true
  if (
    Capacitor.getPlatform() === 'android' &&
    typeof manifest.androidVersionCode === 'number' &&
    manifest.androidVersionCode > CURRENT_ANDROID_VERSION_CODE &&
    compareSemver(manifest.version, CURRENT_APP_VERSION) >= 0
  ) {
    return true
  }
  return false
}

async function fetchManifestJson(url: string): Promise<unknown> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      responseType: 'text',
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`)
    }
    if (typeof res.data === 'string') return JSON.parse(res.data)
    return res.data
  }

  const timeout = createTimeoutSignal(REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: timeout.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    timeout.cancel()
  }
}

type UpdaterState = {
  checking: boolean
  promptOpen: boolean
  availableUpdate: AvailableUpdateInfo | null
  lastError: string
  closePrompt: () => void
  openPrompt: (info: AvailableUpdateInfo) => void
  checkForUpdates: (options?: { force?: boolean; silent?: boolean }) => Promise<UpdateCheckOutcome>
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  checking: false,
  promptOpen: false,
  availableUpdate: null,
  lastError: '',

  closePrompt: () => set({ promptOpen: false }),
  openPrompt: (availableUpdate) => set({ availableUpdate, promptOpen: true }),

  checkForUpdates: async (options) => {
    const force = Boolean(options?.force)
    const silent = Boolean(options?.silent)

    if (get().checking) return { status: 'skipped' }

    const settings = useSettings.getState()
    const effectiveManifestUrl = BUILTIN_UPDATE_MANIFEST_URL || settings.updateManifestUrl
    const effectiveMirrorUrl = BUILTIN_UPDATE_MIRROR_URL || settings.updateMirrorUrl
    const candidates = buildManifestCandidateEntries(effectiveManifestUrl, effectiveMirrorUrl)
    if (candidates.length === 0) {
      return { status: 'unconfigured' }
    }

    if (!force) {
      try {
        const lastRaw = localStorage.getItem(LAST_CHECK_KEY)
        const last = lastRaw ? Number(lastRaw) : 0
        if (last && Date.now() - last < AUTO_CHECK_INTERVAL_MS) {
          return { status: 'skipped' }
        }
      } catch {
        // 忽略存储限制
      }
    }

    set({ checking: true, lastError: '' })
    try {
      let parsedManifest: AppReleaseManifest | null = null
      let matchedMirrorPrefix: string | undefined
      let lastErr: unknown = null

      for (const candidate of candidates) {
        try {
          const json = await fetchManifestJson(candidate.url)
          parsedManifest = parseReleaseManifest(json)
          matchedMirrorPrefix = candidate.mirrorPrefix
          break
        } catch (err) {
          lastErr = err
        }
      }

      if (!parsedManifest) {
        const rawMessage =
          lastErr instanceof Error ? lastErr.message : '无法连接更新服务器或镜像站'
        const message = /HTTP 404/i.test(rawMessage)
          ? '仓库尚未发布任何 Release 版本，发布第一个版本后即可自动检查更新'
          : rawMessage
        set({ lastError: silent ? '' : message })
        return { status: 'error', message }
      }

      try {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
      } catch {
        // ignore
      }

      if (!isUpdateNewer(parsedManifest)) {
        set({ availableUpdate: null })
        return { status: 'latest', version: CURRENT_APP_VERSION }
      }

      if (
        !force &&
        settings.dismissedUpdateVersion &&
        compareSemver(settings.dismissedUpdateVersion, parsedManifest.version) >= 0
      ) {
        return { status: 'skipped' }
      }

      const links = resolveDownloadLinks(parsedManifest, effectiveMirrorUrl, matchedMirrorPrefix)
      if (!links.preferredUrl) {
        return { status: 'latest', version: CURRENT_APP_VERSION }
      }

      const info: AvailableUpdateInfo = {
        manifest: parsedManifest,
        ...links,
      }
      set({ availableUpdate: info, promptOpen: true })
      return { status: 'update', info }
    } finally {
      set({ checking: false })
    }
  },
}))
