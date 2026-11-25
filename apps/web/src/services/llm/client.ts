import type { LlmChatMessage } from '@tavern-chat/core'
import { createTimeoutSignal } from '../../utils/compat.ts'
import type { ProviderConfig, ProviderFormat } from '../settings.ts'

export type StreamChunkEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

let cachedGatewayOrigin: string | null | undefined
let cachedSyncOrigin: string | null | undefined

type HealthResponse = {
  ok?: boolean
  app?: string
  mode?: string
  capabilities?: {
    proxy?: boolean
    market?: boolean
    sync?: boolean
  }
}

export function resetHostDiscoveryCache(): void {
  cachedGatewayOrigin = undefined
  cachedSyncOrigin = undefined
}

export async function probeTavernHealth(originPrefix: string): Promise<HealthResponse | null> {
  const timeout = createTimeoutSignal(1500)
  try {
    const res = await fetch(`${originPrefix}/api/v1/health`, {
      signal: timeout.signal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as HealthResponse
    if (data.ok && data.app === 'TavernChat') return data
  } catch {
    // 无可用网关/同步端
  } finally {
    timeout.cancel()
  }
  return null
}

/**
 * 探测可用的代理网关（用于消除模型/市场接口的浏览器 CORS 限制）。
 */
export async function resolveGatewayOrigin(customOrigin?: string): Promise<string | null> {
  if (typeof window !== 'undefined' && window.tavernDesktop?.getGatewayOrigin) {
    const origin = window.tavernDesktop.getGatewayOrigin()
    if (origin) return origin
  }
  if (customOrigin?.trim()) {
    const clean = customOrigin.trim().replace(/\/+$/, '')
    const health = await probeTavernHealth(clean)
    return health?.capabilities?.proxy === false ? null : clean
  }
  if (cachedGatewayOrigin !== undefined) {
    return cachedGatewayOrigin
  }
  const health = await probeTavernHealth('')
  if (health && health.capabilities?.proxy !== false) {
    cachedGatewayOrigin = ''
    return ''
  }
  cachedGatewayOrigin = null
  return null
}

/**
 * 探测可用的多设备数据同步主机（手机主机 / 桌面端主机 / 局域网主机）。
 */
export async function resolveSyncHostOrigin(customOrigin?: string): Promise<string | null> {
  if (customOrigin?.trim()) {
    const clean = customOrigin.trim().replace(/\/+$/, '')
    const health = await probeTavernHealth(clean)
    return health?.capabilities?.sync ? clean : null
  }
  if (cachedSyncOrigin !== undefined) {
    return cachedSyncOrigin
  }
  const health = await probeTavernHealth('')
  if (health?.capabilities?.sync) {
    cachedSyncOrigin = ''
    return ''
  }
  cachedSyncOrigin = null
  return null
}

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, '')

const stripEndpointSuffix = (u: string) =>
  normalizeUrl(u).replace(/\/(?:chat\/completions|messages)$/i, '')

const hasVersionSegment = (u: string) => {
  try {
    return /\/v\d+(?:alpha|beta)?(?:\/|$)/i.test(new URL(u).pathname)
  } catch {
    return /\/v\d+(?:alpha|beta)?$/i.test(u)
  }
}

function buildDirectEndpoint(baseUrl: string, format: ProviderFormat): string {
  const clean = normalizeUrl(baseUrl)
  if (format === 'anthropic') {
    if (clean.endsWith('/messages')) return clean
    return clean.endsWith('/v1') ? `${clean}/messages` : `${clean}/v1/messages`
  }
  if (clean.endsWith('/chat/completions')) return clean
  return hasVersionSegment(clean) ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`
}

export async function fetchProviderModels(
  provider: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'format'>,
  customGatewayOrigin?: string
): Promise<string[]> {
  if (provider.format !== 'ollama' && !provider.apiKey.trim()) {
    throw new Error('请先填写 API Key')
  }
  const gateway = await resolveGatewayOrigin(customGatewayOrigin)
  if (gateway !== null) {
    const res = await fetch(`${gateway}/api/v1/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        format: provider.format,
      }),
    })
    const data = (await res.json()) as { ok?: boolean; models?: string[]; error?: string }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    return data.models ?? []
  }

  // 客户端直连模式
  const clean = stripEndpointSuffix(provider.baseUrl)
  if (!clean) {
    throw new Error('请先填写中转站 / 接口地址（Base URL）')
  }
  const url = hasVersionSegment(clean) ? `${clean}/models` : `${clean}/v1/models`
  const headers: Record<string, string> = {}
  if (provider.apiKey) {
    if (provider.format === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${provider.apiKey}`
    }
  }
  const timeout = createTimeoutSignal(10_000)
  let res: Response
  try {
    res = await fetch(url, { headers, signal: timeout.signal })
  } finally {
    timeout.cancel()
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`)
  }
  const data = (await res.json()) as {
    data?: Array<{ id?: string; name?: string }>
    models?: Array<{ id?: string; name?: string }>
  }
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
  return list
    .map((m) => (typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : ''))
    .filter(Boolean)
}

export type StreamChatParams = {
  provider: ProviderConfig
  messages: LlmChatMessage[]
  temperature?: number
  topP?: number
  maxTokens?: number
  customGatewayOrigin?: string
  signal?: AbortSignal
  onEvent: (event: StreamChunkEvent) => void
}

/**
 * 轻量 `<think>...</think>` 流式拆分器：兼容部分把推理过程放在正文的模型
 */
function createThinkTagSplitter(onEvent: (e: StreamChunkEvent) => void) {
  let inThink = false
  let pending = ''

  const push = (text: string) => {
    pending += text
    while (pending.length > 0) {
      if (!inThink) {
        const idx = pending.indexOf('<think>')
        if (idx >= 0) {
          if (idx > 0) onEvent({ type: 'delta', text: pending.slice(0, idx) })
          pending = pending.slice(idx + 7)
          inThink = true
          continue
        }
        // 防止截断 `<think>` 标签
        const partial = pending.lastIndexOf('<')
        if (partial >= 0 && '<think>'.startsWith(pending.slice(partial))) {
          if (partial > 0) onEvent({ type: 'delta', text: pending.slice(0, partial) })
          pending = pending.slice(partial)
          break
        }
        onEvent({ type: 'delta', text: pending })
        pending = ''
      } else {
        const idx = pending.indexOf('</think>')
        if (idx >= 0) {
          if (idx > 0) onEvent({ type: 'reasoning', text: pending.slice(0, idx) })
          pending = pending.slice(idx + 8)
          inThink = false
          continue
        }
        const partial = pending.lastIndexOf('<')
        if (partial >= 0 && '</think>'.startsWith(pending.slice(partial))) {
          if (partial > 0) onEvent({ type: 'reasoning', text: pending.slice(0, partial) })
          pending = pending.slice(partial)
          break
        }
        onEvent({ type: 'reasoning', text: pending })
        pending = ''
      }
    }
  }

  const flush = () => {
    if (!pending) return
    onEvent({ type: inThink ? 'reasoning' : 'delta', text: pending })
    pending = ''
  }

  return { push, flush }
}

export async function streamChatCompletion(params: StreamChatParams): Promise<void> {
  const { provider, messages, temperature, topP, maxTokens, signal, onEvent } = params
  if (!provider.baseUrl.trim() || !provider.model.trim()) {
    throw new Error('请先在「设置 → 模型服务」中填写接口地址与模型名称')
  }
  if (provider.format !== 'ollama' && !provider.apiKey.trim()) {
    throw new Error(`请先在「设置 → 模型服务」中填写 ${provider.name} 的 API Key`)
  }

  const splitter = createThinkTagSplitter(onEvent)
  const gateway = await resolveGatewayOrigin(params.customGatewayOrigin)

  if (gateway !== null) {
    const res = await fetch(`${gateway}/api/v1/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        format: provider.format,
        model: provider.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature,
        topP,
        maxTokens,
      }),
    })

    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => res.statusText)
      let message = errBody
      try {
        const parsed = JSON.parse(errBody) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        // 保留纯文本
      }
      throw new Error(message || `HTTP ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const jsonStr = t.slice(5).trim()
          if (!jsonStr) continue
          try {
            const ev = JSON.parse(jsonStr) as StreamChunkEvent
            if (ev.type === 'delta') {
              splitter.push(ev.text)
            } else if (ev.type === 'reasoning') {
              onEvent(ev)
            } else if (ev.type === 'error') {
              throw new Error(ev.message)
            }
          } catch (err) {
            if (err instanceof Error && !err.message.includes('JSON')) throw err
          }
        }
      }
      splitter.flush()
      onEvent({ type: 'done' })
    } finally {
      reader.releaseLock()
    }
    return
  }

  // 客户端直连模式（Android APK / 静态 PWA）
  const endpoint = buildDirectEndpoint(provider.baseUrl, provider.format)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let body: Record<string, unknown>

  if (provider.format === 'anthropic') {
    headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
    const sys = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const conv: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const prev = conv.at(-1)
      if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`
      else conv.push({ role: m.role, content: m.content })
    }
    if (conv.length === 0 || conv[0]!.role !== 'user') {
      conv.unshift({ role: 'user', content: '（请开始对话）' })
    }
    body = {
      model: provider.model,
      max_tokens: maxTokens ?? 2048,
      messages: conv,
      stream: true,
      ...(sys ? { system: sys } : {}),
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof topP === 'number' ? { top_p: topP } : {}),
    }
  } else {
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`
    body = {
      model: provider.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
      ...(typeof temperature === 'number' ? { temperature } : {}),
      ...(typeof topP === 'number' ? { top_p: topP } : {}),
    }
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error((await res.text().catch(() => res.statusText)).slice(0, 400))
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const dataStr = t.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') continue
        try {
          const chunk = JSON.parse(dataStr) as Record<string, unknown>
          if (provider.format === 'anthropic') {
            const delta = chunk.delta as Record<string, unknown> | undefined
            if (chunk.type === 'content_block_delta' && delta) {
              if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                onEvent({ type: 'reasoning', text: delta.thinking })
              } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                splitter.push(delta.text)
              }
            }
          } else {
            const choices = chunk.choices as Array<{ delta?: Record<string, unknown> }> | undefined
            const delta = choices?.[0]?.delta
            if (delta) {
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                onEvent({ type: 'reasoning', text: delta.reasoning_content })
              }
              if (typeof delta.content === 'string' && delta.content) {
                splitter.push(delta.content)
              }
            }
          }
        } catch {
          // 忽略非标准片段
        }
      }
    }
    splitter.flush()
    onEvent({ type: 'done' })
  } finally {
    reader.releaseLock()
  }
}
