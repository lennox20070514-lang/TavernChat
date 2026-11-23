import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { BUILTIN_MARKET_PLUGINS, type MarketplacePlugin } from '@tavern-chat/core'
import { resolveGatewayOrigin } from './llm/client.ts'

export type MarketAuthUser = {
  username?: string
  email?: string
  [key: string]: unknown
}

export type MarketAuthStatus = {
  loggedIn: boolean
  user?: MarketAuthUser
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nativeCookieKey = (pluginId: string): string => `tavern.market.cookie.${pluginId}`
const nativeUserKey = (pluginId: string): string => `tavern.market.user.${pluginId}`

const friendlyError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|Load failed|CORS|跨域/i.test(message)) {
    return '该来源没有开放跨域访问。请使用桌面端/安卓端，或在设置中填写本地网关。'
  }
  return message
}

const readNativeCookie = (pluginId: string): string | undefined => {
  if (!Capacitor.isNativePlatform()) return undefined
  try {
    return localStorage.getItem(nativeCookieKey(pluginId)) ?? undefined
  } catch {
    return undefined
  }
}

const readNativeUser = (pluginId: string): MarketAuthUser | undefined => {
  if (!Capacitor.isNativePlatform()) return undefined
  try {
    const raw = localStorage.getItem(nativeUserKey(pluginId))
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as MarketAuthUser) : undefined
  } catch {
    return undefined
  }
}

const writeNativeSession = (pluginId: string, cookie: string, user?: MarketAuthUser): void => {
  try {
    localStorage.setItem(nativeCookieKey(pluginId), cookie)
    if (user) localStorage.setItem(nativeUserKey(pluginId), JSON.stringify(user))
  } catch {
    // 本地存储不可用时忽略。
  }
}

const clearNativeSession = (pluginId: string): void => {
  try {
    localStorage.removeItem(nativeCookieKey(pluginId))
    localStorage.removeItem(nativeUserKey(pluginId))
  } catch {
    // 本地存储不可用时忽略。
  }
}

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const responseCookie = (headers: Record<string, string>): string | undefined => {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'set-cookie')
  if (!key) return undefined
  const raw: unknown = headers[key]
  const values = Array.isArray(raw) ? raw : String(raw).split(/,(?=[^;,\s]+=)/)
  const pairs = values
    .map((value) => String(value).split(';')[0]?.trim())
    .filter((value): value is string => Boolean(value && value.includes('=')))
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

const nativePostJson = async (url: string, body: unknown, cookie?: string) => {
  const response = await CapacitorHttp.post({
    url,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    data: body,
    responseType: 'json',
    connectTimeout: 60_000,
    readTimeout: 60_000,
    disableRedirects: true,
  })
  const data: unknown = typeof response.data === 'string' ? safeJson(response.data) : response.data
  return { status: response.status, data, cookie: responseCookie(response.headers) }
}

const nativeGetJson = async (url: string, cookie?: string) => {
  const response = await CapacitorHttp.get({
    url,
    headers: {
      Accept: 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    responseType: 'json',
    connectTimeout: 60_000,
    readTimeout: 60_000,
    disableRedirects: true,
  })
  const data: unknown = typeof response.data === 'string' ? safeJson(response.data) : response.data
  return { status: response.status, data }
}

const findAuthPlugin = (pluginId: string): MarketplacePlugin | null => {
  const plugin = BUILTIN_MARKET_PLUGINS.find((entry) => entry.id === pluginId)
  return plugin?.auth ? plugin : null
}

const authError = (data: unknown, fallback: string): string =>
  isRecord(data) && typeof data.error === 'string' && data.error.trim()
    ? data.error
    : fallback

export async function getMarketAuthStatus(
  pluginId: string,
  customOrigin?: string
): Promise<MarketAuthStatus> {
  const plugin = findAuthPlugin(pluginId)
  if (!plugin?.auth) return { loggedIn: false }

  if (Capacitor.isNativePlatform()) {
    const cookie = readNativeCookie(pluginId)
    if (!cookie) return { loggedIn: false }
    try {
      const { status, data } = await nativeGetJson(
        plugin.auth.origin + plugin.auth.sessionPath,
        cookie
      )
      const record = isRecord(data) ? data : null
      if (status >= 200 && status < 300 && record && record.success !== false) {
        const user =
          record.user && isRecord(record.user)
            ? (record.user as MarketAuthUser)
            : readNativeUser(pluginId)
        if (user) writeNativeSession(pluginId, cookie, user)
        return { loggedIn: true, user }
      }
      if (status === 401 || status === 403) clearNativeSession(pluginId)
      return { loggedIn: false }
    } catch (err) {
      return { loggedIn: false, error: friendlyError(err) }
    }
  }

  const gateway = await resolveGatewayOrigin(customOrigin)
  if (gateway === null) {
    return { loggedIn: false, error: '请使用桌面端或安卓端登录' }
  }
  try {
    const response = await fetch(
      gateway + '/api/v1/market/auth/status?pluginId=' + encodeURIComponent(pluginId),
      { signal: AbortSignal.timeout(30_000) }
    )
    const data: unknown = await response.json()
    const record = isRecord(data) ? data : {}
    if (!response.ok) throw new Error(authError(record, `HTTP ${response.status}`))
    return {
      loggedIn: record.loggedIn === true,
      user: isRecord(record.user) ? (record.user as MarketAuthUser) : undefined,
      error: typeof record.error === 'string' ? record.error : undefined,
    }
  } catch (err) {
    return { loggedIn: false, error: friendlyError(err) }
  }
}

export async function marketLogin(
  pluginId: string,
  username: string,
  password: string,
  customOrigin?: string
): Promise<MarketAuthStatus> {
  const plugin = findAuthPlugin(pluginId)
  if (!plugin?.auth) throw new Error('这个来源不支持站内登录')

  if (Capacitor.isNativePlatform()) {
    const { status, data, cookie } = await nativePostJson(
      plugin.auth.origin + plugin.auth.loginPath,
      { username, password }
    )
    const record = isRecord(data) ? data : null
    if (status < 200 || status >= 300 || (record && record.success === false)) {
      throw new Error(authError(record, `登录失败：HTTP ${status}`))
    }
    if (!cookie) throw new Error('登录成功但没有拿到会话 Cookie')
    const user = record && isRecord(record.user) ? (record.user as MarketAuthUser) : undefined
    writeNativeSession(pluginId, cookie, user)
    return { loggedIn: true, user }
  }

  const gateway = await resolveGatewayOrigin(customOrigin)
  if (gateway === null) throw new Error('请使用桌面端或安卓端登录')
  const response = await fetch(gateway + '/api/v1/market/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginId, username, password }),
    signal: AbortSignal.timeout(40_000),
  })
  const data: unknown = await response.json()
  const record = isRecord(data) ? data : {}
  if (!response.ok) throw new Error(authError(record, `登录失败：HTTP ${response.status}`))
  return {
    loggedIn: true,
    user: isRecord(record.user) ? (record.user as MarketAuthUser) : undefined,
  }
}

export async function marketRegister(
  pluginId: string,
  input: { email: string; code: string; username: string; password: string },
  customOrigin?: string
): Promise<MarketAuthStatus> {
  const plugin = findAuthPlugin(pluginId)
  if (!plugin?.auth) throw new Error('这个来源不支持站内注册')

  if (Capacitor.isNativePlatform()) {
    const { status, data, cookie } = await nativePostJson(
      plugin.auth.origin + plugin.auth.registerPath,
      {
        username: input.username,
        password: input.password,
        email: input.email,
        verification_code: input.code,
      }
    )
    const record = isRecord(data) ? data : null
    if (status < 200 || status >= 300 || (record && record.success === false)) {
      throw new Error(authError(record, `注册失败：HTTP ${status}`))
    }
    let sessionCookie = cookie
    let user = record && isRecord(record.user) ? (record.user as MarketAuthUser) : undefined
    if (!sessionCookie) {
      const login = await nativePostJson(plugin.auth.origin + plugin.auth.loginPath, {
        username: input.username,
        password: input.password,
      })
      if (login.status >= 200 && login.status < 300 && login.cookie) {
        sessionCookie = login.cookie
        const loginRecord = isRecord(login.data) ? login.data : null
        if (loginRecord && isRecord(loginRecord.user)) {
          user = loginRecord.user as MarketAuthUser
        }
      }
    }
    if (sessionCookie) {
      writeNativeSession(pluginId, sessionCookie, user)
      return { loggedIn: true, user }
    }
    return { loggedIn: false }
  }

  const gateway = await resolveGatewayOrigin(customOrigin)
  if (gateway === null) throw new Error('请使用桌面端或安卓端注册')
  const response = await fetch(gateway + '/api/v1/market/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pluginId,
      username: input.username,
      password: input.password,
      email: input.email,
      code: input.code,
    }),
    signal: AbortSignal.timeout(40_000),
  })
  const data: unknown = await response.json()
  const record = isRecord(data) ? data : {}
  if (!response.ok) throw new Error(authError(record, `注册失败：HTTP ${response.status}`))
  return {
    loggedIn: record.loggedIn === true,
    user: isRecord(record.user) ? (record.user as MarketAuthUser) : undefined,
  }
}

export async function marketSendCode(
  pluginId: string,
  email: string,
  customOrigin?: string
): Promise<void> {
  const plugin = findAuthPlugin(pluginId)
  if (!plugin?.auth) throw new Error('这个来源不支持发送验证码')

  if (Capacitor.isNativePlatform()) {
    const { status, data } = await nativePostJson(plugin.auth.origin + plugin.auth.sendCodePath, {
      email,
    })
    const record = isRecord(data) ? data : null
    if (status < 200 || status >= 300 || (record && record.success === false)) {
      throw new Error(authError(record, `验证码发送失败：HTTP ${status}`))
    }
    return
  }

  const gateway = await resolveGatewayOrigin(customOrigin)
  if (gateway === null) throw new Error('请使用桌面端或安卓端发送验证码')
  const response = await fetch(gateway + '/api/v1/market/auth/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginId, email }),
    signal: AbortSignal.timeout(40_000),
  })
  const data: unknown = await response.json()
  const record = isRecord(data) ? data : {}
  if (!response.ok) throw new Error(authError(record, `验证码发送失败：HTTP ${response.status}`))
}

export async function marketLogout(pluginId: string, customOrigin?: string): Promise<void> {
  const plugin = findAuthPlugin(pluginId)
  if (!plugin?.auth) return

  if (Capacitor.isNativePlatform()) {
    const cookie = readNativeCookie(pluginId)
    if (cookie) {
      try {
        await nativePostJson(plugin.auth.origin + plugin.auth.logoutPath, {}, cookie)
      } catch {
        // 上游退出失败也要清掉本地会话。
      }
    }
    clearNativeSession(pluginId)
    return
  }

  const gateway = await resolveGatewayOrigin(customOrigin)
  if (gateway === null) throw new Error('请使用桌面端或安卓端退出登录')
  const response = await fetch(gateway + '/api/v1/market/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginId }),
    signal: AbortSignal.timeout(30_000),
  })
  const data: unknown = await response.json()
  const record = isRecord(data) ? data : {}
  if (!response.ok) throw new Error(authError(record, `退出失败：HTTP ${response.status}`))
}
