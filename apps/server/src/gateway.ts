import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BUILTIN_MARKET_PLUGINS,
  isPngBytes,
  readCharacterJsonFromPng,
} from '@tavern-chat/core'

export type ProviderFormat = 'openai' | 'anthropic' | 'ollama'

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '')

const hasExplicitVersion = (cleanUrl: string): boolean => {
  try {
    return /\/v\d+(?:alpha|beta)?(?:\/|$)/i.test(new URL(cleanUrl).pathname)
  } catch {
    return /\/v\d+(?:alpha|beta)?$/i.test(cleanUrl)
  }
}

export const buildEndpointUrl = (baseUrl: string, format: ProviderFormat): string => {
  const clean = normalizeBaseUrl(baseUrl)
  if (format === 'anthropic') {
    if (clean.endsWith('/messages')) return clean
    if (clean.endsWith('/v1')) return `${clean}/messages`
    return `${clean}/v1/messages`
  }
  if (clean.endsWith('/chat/completions')) return clean
  if (hasExplicitVersion(clean)) return `${clean}/chat/completions`
  return `${clean}/v1/chat/completions`
}

export const buildModelsUrls = (baseUrl: string, format: ProviderFormat): string[] => {
  const clean = normalizeBaseUrl(baseUrl)
  if (format === 'ollama') {
    return [`${clean}/v1/models`, `${clean}/api/tags`]
  }
  if (hasExplicitVersion(clean)) {
    return [`${clean}/models`, `${clean}/v1/models`]
  }
  return [`${clean}/v1/models`, `${clean}/models`]
}

export const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

const readJsonBody = async (req: IncomingMessage): Promise<JsonRecord> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) {
    throw new Error('Request body must be a JSON object')
  }
  return parsed
}

const beginSse = (res: ServerResponse) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

const writeSse = (res: ServerResponse, data: unknown) => {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/**
 * 代理拉取模型列表，消除浏览器端 CORS 限制
 */
export const handleModelsProxy = async (req: IncomingMessage, res: ServerResponse) => {
  let body: JsonRecord
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
    return
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const format = (
    body.format === 'anthropic' || body.format === 'ollama' ? body.format : 'openai'
  ) as ProviderFormat

  if (!baseUrl) {
    sendJson(res, 400, { ok: false, error: 'Base URL 不能为空' })
    return
  }

  const urls = buildModelsUrls(baseUrl, format)
  let lastError = '无法连接模型接口'

  for (const url of urls) {
    try {
      const headers: Record<string, string> = {}
      if (apiKey) {
        if (format === 'anthropic') {
          headers['x-api-key'] = apiKey
          headers['anthropic-version'] = '2023-06-01'
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`
        }
      }
      const upstream = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(12_000),
      })
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => upstream.statusText)
        lastError = `HTTP ${upstream.status}: ${text.slice(0, 180)}`
        continue
      }
      const data = (await upstream.json()) as {
        data?: Array<{ id?: string; name?: string }>
        models?: Array<{ id?: string; name?: string }>
      }
      const rawList = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.models)
          ? data.models
          : []
      const models = rawList
        .map((m) => (typeof m.id === 'string' ? m.id : typeof m.name === 'string' ? m.name : ''))
        .filter(Boolean)
      sendJson(res, 200, { ok: true, models })
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  sendJson(res, 502, { ok: false, error: lastError })
}

/**
 * 统一流式聊天代理：将 OpenAI / Anthropic / Ollama 响应规范化为 TavernChat SSE 事件流
 */
export const handleChatStreamProxy = async (req: IncomingMessage, res: ServerResponse) => {
  let body: JsonRecord
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    return
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  const format = (
    body.format === 'anthropic' || body.format === 'ollama' ? body.format : 'openai'
  ) as ProviderFormat
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const messages = Array.isArray(body.messages) ? body.messages : []

  if (!baseUrl || !model) {
    sendJson(res, 400, { error: '请先在设置中配置服务地址和模型' })
    return
  }

  const targetUrl = buildEndpointUrl(baseUrl, format)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  let upstreamBody: JsonRecord

  if (format === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'

    const systemParts: string[] = []
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []

    for (const raw of messages) {
      if (!isRecord(raw) || typeof raw.content !== 'string') continue
      if (raw.role === 'system') {
        if (raw.content.trim()) systemParts.push(raw.content.trim())
      } else if (raw.role === 'user' || raw.role === 'assistant') {
        const prev = anthropicMessages.at(-1)
        if (prev && prev.role === raw.role) {
          prev.content += `\n\n${raw.content}`
        } else {
          anthropicMessages.push({ role: raw.role, content: raw.content })
        }
      }
    }
    if (anthropicMessages.length === 0 || anthropicMessages[0]!.role !== 'user') {
      anthropicMessages.unshift({ role: 'user', content: '（请开始对话）' })
    }

    upstreamBody = {
      model,
      max_tokens: typeof body.maxTokens === 'number' ? body.maxTokens : 2048,
      messages: anthropicMessages,
      stream: true,
    }
    if (systemParts.length > 0) {
      upstreamBody.system = systemParts.join('\n\n')
    }
    if (typeof body.temperature === 'number') {
      upstreamBody.temperature = body.temperature
    }
    if (typeof body.topP === 'number') {
      upstreamBody.top_p = body.topP
    }
  } else {
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    upstreamBody = {
      model,
      messages: messages
        .filter((m): m is JsonRecord => isRecord(m) && typeof m.content === 'string')
        .map((m) => ({
          role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
          content: m.content,
        })),
      stream: true,
    }
    if (typeof body.maxTokens === 'number') {
      upstreamBody.max_tokens = body.maxTokens
    }
    if (typeof body.temperature === 'number') {
      upstreamBody.temperature = body.temperature
    }
    if (typeof body.topP === 'number') {
      upstreamBody.top_p = body.topP
    }
  }

  const controller = new AbortController()
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      res.end()
      return
    }
    sendJson(res, 502, {
      error: `无法连接模型接口 (${targetUrl}): ${err instanceof Error ? err.message : String(err)}`,
    })
    return
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => upstream.statusText)
    sendJson(res, upstream.status || 502, {
      error: errText.slice(0, 600) || `HTTP ${upstream.status}`,
    })
    return
  }

  beginSse(res)

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const dataStr = trimmed.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') continue

        let chunk: unknown
        try {
          chunk = JSON.parse(dataStr)
        } catch {
          continue
        }
        if (!isRecord(chunk)) continue

        if (format === 'anthropic') {
          if (chunk.type === 'content_block_delta' && isRecord(chunk.delta)) {
            if (chunk.delta.type === 'thinking_delta' && typeof chunk.delta.thinking === 'string') {
              writeSse(res, { type: 'reasoning', text: chunk.delta.thinking })
            } else if (chunk.delta.type === 'text_delta' && typeof chunk.delta.text === 'string') {
              writeSse(res, { type: 'delta', text: chunk.delta.text })
            }
          }
        } else {
          const choices = Array.isArray(chunk.choices) ? chunk.choices : []
          const first = choices[0]
          if (isRecord(first) && isRecord(first.delta)) {
            const delta = first.delta
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
              writeSse(res, { type: 'reasoning', text: delta.reasoning_content })
            } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
              writeSse(res, { type: 'reasoning', text: delta.reasoning })
            }
            if (typeof delta.content === 'string' && delta.content) {
              writeSse(res, { type: 'delta', text: delta.content })
            }
          }
        }
      }
    }
    writeSse(res, { type: 'done' })
  } catch (err) {
    if (!controller.signal.aborted) {
      writeSse(res, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  } finally {
    reader.releaseLock()
    res.end()
  }
}

const MARKET_TEXT_LIMIT = 4 * 1024 * 1024
const MARKET_BYTES_LIMIT = 6 * 1024 * 1024

const readBodyWithLimit = async (body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> => {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error('来源响应超过大小限制')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/**
 * 把内置来源插件页面/卡片代理给浏览器和桌面端，解决 CORS。
 * 只放行插件清单登记过的主机和路径，禁止重定向，限制大小与超时。
 */
export const handleMarketProxy = async (req: IncomingMessage, res: ServerResponse) => {
  let body: JsonRecord
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    return
  }

  const rawUrl = typeof body.url === 'string' ? body.url : ''
  const as = body.as === 'bytes' ? 'bytes' : 'text'
  if (!rawUrl || rawUrl.length > 2000) {
    sendJson(res, 400, { error: '缺少有效的来源地址' })
    return
  }

  let target: URL
  try {
    target = new URL(rawUrl)
  } catch {
    sendJson(res, 400, { error: '来源地址无效' })
    return
  }
  const allowed = BUILTIN_MARKET_PLUGINS.some(
    (plugin) =>
      plugin.hosts.includes(target.hostname) &&
      plugin.allowedPathPrefixes.some((prefix) => target.pathname.startsWith(prefix))
  )
  if (target.protocol !== 'https:' || !allowed) {
    sendJson(res, 403, { error: '该地址不属于已接入的来源插件' })
    return
  }

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(25_000),
      redirect: 'error',
      headers: {
        Accept: as === 'bytes' ? 'image/png' : 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    })
    if (!upstream.ok || !upstream.body) {
      sendJson(res, 502, { error: '来源返回 HTTP ' + upstream.status })
      return
    }

    if (as === 'text') {
      const buffer = await readBodyWithLimit(upstream.body, MARKET_TEXT_LIMIT)
      sendJson(res, 200, { ok: true, text: new TextDecoder().decode(buffer) })
      return
    }

    const contentType = upstream.headers.get('content-type') ?? ''
    if (!/image\/png/i.test(contentType)) {
      await upstream.body.cancel()
      sendJson(res, 502, { error: '来源没有返回 PNG 角色卡' })
      return
    }
    const buffer = await readBodyWithLimit(upstream.body, MARKET_BYTES_LIMIT)
    try {
      if (!isPngBytes(buffer)) throw new Error('PNG 签名无效')
      JSON.parse(readCharacterJsonFromPng(buffer))
    } catch {
      sendJson(res, 502, { error: '下载内容不是有效的 SillyTavern PNG 角色卡' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(buffer)
  } catch (err) {
    if (!res.writableEnded) {
      sendJson(res, 502, {
        error: '读取来源失败：' + (err instanceof Error ? err.message : String(err)),
      })
    }
  }
}

export const createGatewayHandler = (mode: 'standalone' | 'desktop-embedded') => {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    try {
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/health') {
        sendJson(res, 200, {
          ok: true,
          app: 'TavernChat',
          mode,
          capabilities: {
            proxy: true,
            market: true,
            // 为未来电脑满血版 (PC Pro) 预留能力发现标记
            filesystem: false,
            localRag: false,
          },
        })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/models') {
        await handleModelsProxy(req, res)
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/market/proxy') {
        await handleMarketProxy(req, res)
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chat/stream') {
        await handleChatStreamProxy(req, res)
        return
      }
      sendJson(res, 404, { error: 'Not Found' })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
