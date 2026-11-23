import { Capacitor, CapacitorHttp } from '@capacitor/core'
import {
  BUILTIN_MARKET_PLUGINS,
  parseMarketManifest,
  type MarketCard,
  type MarketManifest,
  type MarketplacePlugin,
} from '@tavern-chat/core'
import { resolveGatewayOrigin } from './llm/client.ts'

export type MarketPluginView = {
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage?: string
  license?: string
  builtin: boolean
  manifestUrl?: string
  manifest?: MarketManifest
  error?: string
}

const MANIFEST_STORAGE_KEY = 'tavern.market.manifestUrls.v1'
const MANIFEST_CACHE_MS = 5 * 60 * 1000
const CARDS_CACHE_MS = 2 * 60 * 1000
const MAX_MANIFESTS = 20

type FetchMode = 'text' | 'bytes'

const manifestCache = new Map<string, { expiresAt: number; manifest: MarketManifest }>()
const cardsCache = new Map<string, { expiresAt: number; cards: MarketCard[] }>()

const friendlyError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  if (/Failed to fetch|NetworkError|Load failed|CORS|跨域/i.test(message)) {
    return '该来源没有开放跨域访问。请使用桌面端/安卓端，或在设置中填写本地网关。'
  }
  return message
}

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const toBytes = (data: unknown): Uint8Array => {
  if (typeof data === 'string') return decodeBase64(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return Uint8Array.from(data as number[])
  throw new Error('原生请求返回了无法识别的数据')
}

const acceptFor = (mode: FetchMode): string =>
  mode === 'bytes' ? 'image/png' : 'text/html,application/json;q=0.9,*/*;q=0.8'

const nativeGet = async (url: string, mode: FetchMode): Promise<string | Uint8Array> => {
  const response = await CapacitorHttp.get({
    url,
    responseType: mode === 'bytes' ? 'arraybuffer' : 'text',
    connectTimeout: 60_000,
    readTimeout: 60_000,
    disableRedirects: true,
    headers: { Accept: acceptFor(mode) },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error('来源返回 HTTP ' + response.status)
  }
  return mode === 'bytes' ? toBytes(response.data) : String(response.data ?? '')
}

const gatewayGet = async (
  gateway: string,
  url: string,
  mode: FetchMode
): Promise<string | Uint8Array> => {
  const response = await fetch(gateway + '/api/v1/market/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, as: mode }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let message = raw
    try {
      const data = JSON.parse(raw) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // 网关可能返回纯文本错误。
    }
    throw new Error(message || 'HTTP ' + response.status)
  }
  if (mode === 'bytes') return new Uint8Array(await response.arrayBuffer())
  const data = (await response.json()) as { text?: string }
  if (typeof data.text !== 'string') throw new Error('网关没有返回来源内容')
  return data.text
}

const directGet = async (url: string, mode: FetchMode): Promise<string | Uint8Array> => {
  const response = await fetch(url, {
    headers: { Accept: acceptFor(mode) },
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error('来源返回 HTTP ' + response.status)
  return mode === 'bytes' ? new Uint8Array(await response.arrayBuffer()) : response.text()
}

const requestSource = async (
  url: string,
  mode: FetchMode,
  allowGateway: boolean,
  customOrigin?: string
): Promise<string | Uint8Array> => {
  try {
    if (Capacitor.isNativePlatform()) return await nativeGet(url, mode)
    if (allowGateway) {
      const gateway = await resolveGatewayOrigin(customOrigin)
      if (gateway !== null) return await gatewayGet(gateway, url, mode)
    }
    return await directGet(url, mode)
  } catch (err) {
    throw new Error(friendlyError(err))
  }
}

const requestText = async (
  url: string,
  allowGateway: boolean,
  customOrigin?: string
): Promise<string> => {
  const value = await requestSource(url, 'text', allowGateway, customOrigin)
  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

const requestBytes = async (
  url: string,
  allowGateway: boolean,
  customOrigin?: string
): Promise<Uint8Array> => {
  const value = await requestSource(url, 'bytes', allowGateway, customOrigin)
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

const absoluteUrl = (value: string, base: string): string => {
  try {
    return new URL(value, base).toString()
  } catch {
    return value
  }
}

const nodeText = (node: Element | null): string =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

const parseHtml = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html')

const parseBae = (plugin: MarketplacePlugin, html: string): MarketCard[] => {
  const doc = parseHtml(html)
  const cards: MarketCard[] = []
  const seen = new Set<string>()

  for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[download$=".png"]'))) {
    const href = link.getAttribute('href')
    if (!href) continue
    const downloadUrl = absoluteUrl(href, plugin.catalogUrl)
    if (seen.has(downloadUrl)) continue
    seen.add(downloadUrl)

    const item = link.closest('li') ?? link.closest('div')
    if (!item) continue
    const name = nodeText(item.querySelector('p.font-display'))
    if (!name) continue

    const detail = item.querySelector<HTMLAnchorElement>('a[href^="/archetypes/"]')
    const cover = item.querySelector<HTMLImageElement>('img')
    const fileName = link.getAttribute('download') || downloadUrl.split('/').pop() || 'card.png'
    const slug = fileName.replace(/\.png$/i, '')

    cards.push({
      id: plugin.id + ':' + slug,
      pluginId: plugin.id,
      pluginName: plugin.name,
      name,
      description: nodeText(item.querySelector('p.mt-2')),
      creator: plugin.author,
      kind: 'character',
      sourceUrl: detail ? absoluteUrl(detail.getAttribute('href') ?? '', plugin.catalogUrl) : plugin.catalogUrl,
      downloadUrl,
      coverUrl: cover?.getAttribute('src')
        ? absoluteUrl(cover.getAttribute('src') ?? '', plugin.catalogUrl)
        : undefined,
      fileName,
      tags: [],
      license: plugin.license,
      licenseUrl: plugin.homepage,
    })
  }
  return cards
}

const parseTuniang = (plugin: MarketplacePlugin, html: string): MarketCard[] => {
  const doc = parseHtml(html)
  const cards: MarketCard[] = []
  const seen = new Set<string>()

  for (const block of Array.from(doc.querySelectorAll('.cc'))) {
    const link =
      block.querySelector<HTMLAnchorElement>('.cc-dl a[href$=".json"]') ??
      block.querySelector<HTMLAnchorElement>('a[href$=".png"]')
    const href = link?.getAttribute('href')
    if (!link || !href) continue
    const downloadUrl = absoluteUrl(href, plugin.catalogUrl)
    if (seen.has(downloadUrl)) continue
    seen.add(downloadUrl)

    const name = nodeText(block.querySelector('h3'))
    if (!name) continue
    const cover = block.querySelector<HTMLImageElement>('img.cc-img, img')
    const fileName = downloadUrl.split('/').pop() || 'card.json'
    const credit = nodeText(block.querySelector('.cc-by'))
    const creator = credit.match(/CC BY 4\.0\s*[·•]\s*([^(]+)/)?.[1]?.trim() || plugin.author

    cards.push({
      id: plugin.id + ':' + fileName.replace(/\.(png|json)$/i, ''),
      pluginId: plugin.id,
      pluginName: plugin.name,
      name,
      description: nodeText(block.querySelector('.cc-teaser')),
      creator,
      kind: 'character',
      sourceUrl: plugin.catalogUrl,
      downloadUrl,
      coverUrl: cover?.getAttribute('src')
        ? absoluteUrl(cover.getAttribute('src') ?? '', plugin.catalogUrl)
        : undefined,
      fileName,
      tags: Array.from(block.querySelectorAll('.cc-tags span')).map(nodeText).filter(Boolean),
      license: plugin.license,
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    })
  }
  return cards
}

const BUILTIN_PARSERS: Record<string, (plugin: MarketplacePlugin, html: string) => MarketCard[]> = {
  'bae-ppl-studio': parseBae,
  'tuniang-foreverse': parseTuniang,
}

const readManifestUrls = (): string[] => {
  try {
    const raw = localStorage.getItem(MANIFEST_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.startsWith('https://'))
  } catch {
    return []
  }
}

const writeManifestUrls = (urls: string[]): void => {
  localStorage.setItem(MANIFEST_STORAGE_KEY, JSON.stringify(urls.slice(0, MAX_MANIFESTS)))
}

const normalizeManifestUrl = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('请填写插件清单地址')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('插件清单地址无效')
  }
  if (url.protocol !== 'https:') throw new Error('插件清单必须是 HTTPS 地址')
  return url.toString()
}

const loadManifest = async (url: string, force = false): Promise<MarketManifest> => {
  if (!force) {
    const cached = manifestCache.get(url)
    if (cached && cached.expiresAt > Date.now()) return cached.manifest
  }
  const text = await requestText(url, false)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('插件清单不是有效的 JSON')
  }
  const manifest = parseMarketManifest(value)
  manifestCache.set(url, { expiresAt: Date.now() + MANIFEST_CACHE_MS, manifest })
  return manifest
}

export async function listMarketPlugins(): Promise<MarketPluginView[]> {
  const builtinIds = new Set(BUILTIN_MARKET_PLUGINS.map((plugin) => plugin.id))
  const builtin: MarketPluginView[] = BUILTIN_MARKET_PLUGINS.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    homepage: plugin.homepage,
    license: plugin.license,
    builtin: true,
  }))

  const subscribed = await Promise.all(
    readManifestUrls().map(async (url): Promise<MarketPluginView> => {
      try {
        const manifest = await loadManifest(url)
        if (builtinIds.has(manifest.id)) {
          throw new Error('插件 id 与内置插件冲突：' + manifest.id)
        }
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
          homepage: manifest.homepage,
          license: manifest.license,
          builtin: false,
          manifestUrl: url,
          manifest,
        }
      } catch (err) {
        return {
          id: 'manifest:' + url,
          name: '无法读取的插件',
          version: '',
          description: url,
          author: '',
          builtin: false,
          manifestUrl: url,
          error: friendlyError(err),
        }
      }
    })
  )

  return [...builtin, ...subscribed]
}

export type MarketSourceStatus = {
  id: string
  name: string
  builtin: boolean
  count: number
  error?: string
}

export type MarketCatalog = {
  cards: MarketCard[]
  sources: MarketSourceStatus[]
}

export async function loadMarketCatalog(
  customOrigin?: string,
  onUpdate?: (catalog: MarketCatalog) => void
): Promise<MarketCatalog> {
  const plugins = await listMarketPlugins()
  const cards: MarketCard[] = []
  const sources: MarketSourceStatus[] = []

  await Promise.all(
    plugins.map(async (plugin) => {
      if (plugin.error) {
        sources.push({
          id: plugin.id,
          name: plugin.name,
          builtin: plugin.builtin,
          count: 0,
          error: plugin.error,
        })
        onUpdate?.({ cards: [...cards], sources: [...sources] })
        return
      }
      try {
        const sourceCards = await loadMarketCards(plugin, customOrigin)
        cards.push(...sourceCards)
        sources.push({
          id: plugin.id,
          name: plugin.name,
          builtin: plugin.builtin,
          count: sourceCards.length,
        })
      } catch (err) {
        sources.push({
          id: plugin.id,
          name: plugin.name,
          builtin: plugin.builtin,
          count: 0,
          error: friendlyError(err),
        })
      }
      onUpdate?.({ cards: [...cards], sources: [...sources] })
    })
  )

  return { cards, sources }
}

export async function loadMarketCards(
  plugin: MarketPluginView,
  customOrigin?: string
): Promise<MarketCard[]> {
  if (plugin.error) throw new Error(plugin.error)

  if (plugin.manifest) {
    return plugin.manifest.cards.map((card) => ({
      ...card,
      pluginId: plugin.manifest!.id,
      pluginName: plugin.manifest!.name,
    }))
  }

  const cachedKey = plugin.id
  const cached = cardsCache.get(cachedKey)
  if (cached && cached.expiresAt > Date.now()) return cached.cards

  const definition = BUILTIN_MARKET_PLUGINS.find((entry) => entry.id === plugin.id)
  const parser = definition ? BUILTIN_PARSERS[definition.id] : undefined
  if (!definition || !parser) throw new Error('这个内置插件没有可用的目录解析器')

  const html = await requestText(definition.catalogUrl, true, customOrigin)
  const cards = parser(definition, html)
  if (cards.length === 0) throw new Error('来源目录暂时没有返回可识别的 PNG 角色卡')
  cardsCache.set(cachedKey, { expiresAt: Date.now() + CARDS_CACHE_MS, cards })
  return cards
}

export async function downloadMarketCard(
  card: MarketCard,
  builtin: boolean,
  customOrigin?: string
): Promise<Uint8Array> {
  return requestBytes(card.downloadUrl, builtin, customOrigin)
}

export async function addManifestPlugin(rawUrl: string): Promise<MarketPluginView> {
  const url = normalizeManifestUrl(rawUrl)
  const urls = readManifestUrls()
  if (urls.includes(url)) throw new Error('这个插件已经添加过了')
  if (urls.length >= MAX_MANIFESTS) throw new Error(`最多同时订阅 ${MAX_MANIFESTS} 个插件`)
  const manifest = await loadManifest(url, true)
  if (BUILTIN_MARKET_PLUGINS.some((plugin) => plugin.id === manifest.id)) {
    throw new Error('插件 id 与内置插件冲突')
  }
  writeManifestUrls([...urls, url])
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    license: manifest.license,
    builtin: false,
    manifestUrl: url,
    manifest,
  }
}

export function removeManifestPlugin(manifestUrl: string): void {
  writeManifestUrls(readManifestUrls().filter((url) => url !== manifestUrl))
  manifestCache.delete(manifestUrl)
}
