import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { create } from 'zustand'
import { useSettings } from './settings.ts'

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

const applyMirrorPrefix = (targetUrl: string, mirrorOrPrefix: string): string | null => {
  const trimmed = mirrorOrPrefix.trim()
  if (!trimmed || !isHttpsUrl(targetUrl)) return null
  if (trimmed.endsWith('.json')) return null
  const normalizedPrefix = trimmed.endsWith('/') ? trimmed : `${trimmed}/`
  const candidate = `${normalizedPrefix}${targetUrl}`
  return isHttpsUrl(candidate) ? candidate : null
}

/** 生成版本清单检查顺序：优先镜像站地址（若配置），失败回退 GitHub Release 原地址。 */
export function buildManifestCandidates(manifestUrl: string, mirrorUrl: string): string[] {
  const cleanManifest = manifestUrl.trim()
  const cleanMirror = mirrorUrl.trim()
  const list: string[] = []

  if (cleanMirror && isHttpsUrl(cleanMirror) && cleanMirror.endsWith('.json')) {
    list.push(cleanMirror)
  } else if (cleanMirror && cleanManifest) {
    const mirrored = applyMirrorPrefix(cleanManifest, cleanMirror)
    if (mirrored) list.push(mirrored)
  }

  if (cleanManifest && isHttpsUrl(cleanManifest) && !list.includes(cleanManifest)) {
    list.push(cleanManifest)
  }
  return list
}

export function resolveDownloadLinks(
  manifest: AppReleaseManifest,
  mirrorUrl: string
): { preferredUrl: string; fallbackUrl?: string; viaMirror: boolean } {
  const direct = manifest.apkUrl?.trim() || manifest.releasePageUrl?.trim() || ''
  const mirrorDirect = manifest.mirrorApkUrl?.trim() || ''
  if (mirrorDirect && isHttpsUrl(mirrorDirect)) {
    return {
      preferredUrl: mirrorDirect,
      fallbackUrl: direct && direct !== mirrorDirect ? direct : undefined,
      viaMirror: true,
    }
  }
  if (direct) {
    const prefixed = applyMirrorPrefix(direct, mirrorUrl)
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

  const res = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
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
    const candidates = buildManifestCandidates(effectiveManifestUrl, effectiveMirrorUrl)
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
      let lastErr: unknown = null

      for (const candidateUrl of candidates) {
        try {
          const json = await fetchManifestJson(candidateUrl)
          parsedManifest = parseReleaseManifest(json)
          break
        } catch (err) {
          lastErr = err
        }
      }

      if (!parsedManifest) {
        const message =
          lastErr instanceof Error ? lastErr.message : '无法连接更新服务器或镜像站'
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

      const links = resolveDownloadLinks(parsedManifest, effectiveMirrorUrl)
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
