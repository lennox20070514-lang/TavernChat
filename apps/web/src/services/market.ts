import { Capacitor, CapacitorHttp } from '@capacitor/core'
import {
  BUILTIN_MARKET_PLUGINS,
  normalizeChubCharacterPayload,
  normalizeChubLorebookPayload,
  normalizeChubPresetPayload,
  parseMarketManifest,
  readCharacterJsonFromPng,
  type MarketAuthConfig,
  type MarketCard,
  type MarketManifest,
  type MarketplacePlugin,
  type MarketResourceKind,
} from '@tavern-chat/core'
import { resolveGatewayOrigin } from './llm/client.ts'
import { getMarketAuthStatus } from './marketAuth.ts'

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
  auth?: MarketAuthConfig
  error?: string
}

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

const MANIFEST_STORAGE_KEY = 'tavern.market.manifestUrls.v1'
const MANIFEST_CACHE_MS = 5 * 60 * 1000
const CARDS_CACHE_MS = 2 * 60 * 1000
const MAX_MANIFESTS = 20

const PIXEL_TAVERN_API = 'https://chat.xstavern.com/api/marketplace.php'
const PIXEL_TAVERN_RESOURCES = 'https://chat.xstavern.com/api/resources'
const PIXEL_TAVERN_PAGES = 5
const PIXEL_TAVERN_LIMIT = 60
const PIXEL_TAVERN_RESOURCE_PAGES = 2

const CHUB_API_BASE = 'https://gateway.chub.ai'
const CHUB_AVATAR_BASE = 'https://avatars.charhub.io/avatars'
const CHUB_BLOCKED_TOPICS = /(nsfw|18\+|erotic|smut|fetish|gore|lewd|hentai|bdsm|noncon|yandere)/i
const CHUB_PLUGIN_IDS = new Set(['chub-ai', 'chub-zh', 'chub-rpg'])

const looksLikePng = (bytes: Uint8Array): boolean =>
  bytes.length > 8 &&
  bytes[0] === 0x89 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x4e &&
  bytes[3] === 0x47

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type FetchMode = 'text' | 'bytes'

const manifestCache = new Map<string, { expiresAt: number; manifest: MarketManifest }>()
const cardsCache = new Map<string, { expiresAt: number; cards: MarketCard[] }>()

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = 2
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length)
  let nextIdx = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIdx < tasks.length) {
      const idx = nextIdx
      nextIdx += 1
      try {
        results[idx] = { status: 'fulfilled', value: await tasks[idx]!() }
      } catch (reason) {
        results[idx] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(workers)
  return results
}

export function invalidateMarketCache(pluginId?: string): void {
  if (pluginId) {
    cardsCache.delete(pluginId)
  } else {
    cardsCache.clear()
  }
  pixelSearchCache.clear()
}

const friendlyError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err)
  if (/HTTP 402|402/i.test(message)) {
    return '站方返回 HTTP 402：该卡片在像素酒馆需要积分/VIP 或免费额度已用完。建议切换到免登录开源来源（如 Chub.ai 精选/中文/奇幻库）直接下载。'
  }
  if (/Failed to fetch|NetworkError|Load failed|CORS|跨域/i.test(message)) {
    return '该来源没有开放跨域访问。请使用桌面端/安卓端，或在设置中连接本地主机。'
  }
  if (/timeout|timed out|aborted|fetch failed|Connect Timeout/i.test(message)) {
    return '来源响应超时或连接失败，请稍后重试。'
  }
  return message
}

const BLOCKED_MARKET_TERMS = [
  '轮奸', '强奸', '迷奸', '性奴', '肉便器', '调教', '乱伦', '兽交', '淫', '色情',
  '情色', '做爱', '性交', '口交', '肛交', '露出', '痴汉', '援交', '卖淫', '嫖娼',
  '强暴', '未成年', '萝莉', '正太', '幼女', '幼男', '成人向', '里番', '黄文', '黄色',
  'r18', '18+', 'bdsm', '裸体', '裸照', '裸聊', '性欲', '性爱', '发情', '群交',
  '轮交', '迷药', '春药', '凌辱', '性虐', '触手', '产卵', '洗脑', '催眠', '恶堕',
  '雌堕', '母猪', '母狗', '肉棒', '肉穴', '下体', '乳头', '母乳', '乳汁', '榨干',
  '榨取', '骚货', '骚逼', 'rbq',
]

const BLOCKED_MARKET_WORDS = [
  'rape', 'gangbang', 'orgy', 'hentai', 'nsfw', 'explicit', 'incest', 'loli', 'shota',
  'underage', 'noncon', 'molest', 'prostitut', 'brothel', 'blowjob', 'anal', 'fuck',
  'cum', 'sex', 'sexual', 'erotic', 'porn', 'nude', 'naked', 'bondage', 'fetish',
  'milf', 'dick', 'cock', 'penis', 'vagina', 'xxx', 'lewd', 'ecchi', 'futanari',
  'slut', 'whore', 'breeding',
]

const isBlockedMarketContent = (...parts: Array<string | undefined>): boolean => {
  const text = parts
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLocaleLowerCase()
  if (BLOCKED_MARKET_TERMS.some((term) => text.includes(term))) return true
  return BLOCKED_MARKET_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text))
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

const nativeGet = async (
  url: string,
  mode: FetchMode,
  cookie?: string
): Promise<string | Uint8Array> => {
  const response = await CapacitorHttp.get({
    url,
    responseType: mode === 'bytes' ? 'arraybuffer' : 'text',
    connectTimeout: 60_000,
    readTimeout: 60_000,
    disableRedirects: true,
    headers: {
      Accept: acceptFor(mode),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(url.startsWith('https://chat.xstavern.com/')
        ? { Referer: 'https://chat.xstavern.com/', Origin: 'https://chat.xstavern.com' }
        : {}),
    },
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error('来源返回 HTTP ' + response.status)
  }
  if (mode === 'bytes') return toBytes(response.data)
  // 部分 Android 版本即使 responseType=text 也会把 JSON 自动解析成对象或字节数组。
  if (typeof response.data === 'string') return response.data
  if (Array.isArray(response.data)) {
    return new TextDecoder().decode(Uint8Array.from(response.data as number[]))
  }
  return JSON.stringify(response.data ?? '')
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
  customOrigin?: string,
  cookie?: string
): Promise<string | Uint8Array> => {
  try {
    if (Capacitor.isNativePlatform()) {
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await nativeGet(url, mode, cookie)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError ?? new Error('来源请求失败')
    }
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
  customOrigin?: string,
  cookie?: string
): Promise<string> => {
  const value = await requestSource(url, 'text', allowGateway, customOrigin, cookie)
  return typeof value === 'string' ? value : new TextDecoder().decode(value)
}

const requestBytes = async (
  url: string,
  allowGateway: boolean,
  customOrigin?: string,
  cookie?: string
): Promise<Uint8Array> => {
  const value = await requestSource(url, 'bytes', allowGateway, customOrigin, cookie)
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
  return cards.filter(
    (card) => !isBlockedMarketContent(card.name, card.description, card.tags.join(' '))
  )
}

const nativeCookieKey = (pluginId: string): string => `tavern.market.cookie.${pluginId}`

const readNativeCookie = (pluginId: string): string | undefined => {
  if (!Capacitor.isNativePlatform()) return undefined
  try {
    return localStorage.getItem(nativeCookieKey(pluginId)) ?? undefined
  } catch {
    return undefined
  }
}

const mapPixelCard = (
  plugin: MarketplacePlugin,
  raw: Record<string, unknown>,
  gateway: string | null
): MarketCard | null => {
  const slug = typeof raw.slug === 'string' ? raw.slug : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!slug || !name || raw.nsfw === true) return null
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
    : []
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const series = typeof raw.series === 'string' && raw.series ? raw.series : ''
  const category = typeof raw.category === 'string' && raw.category ? raw.category : ''
  if (
    isBlockedMarketContent(name, summary, description, tags.join(' '), series, category)
  ) {
    return null
  }
  return {
    id: plugin.id + ':' + slug,
    pluginId: plugin.id,
    pluginName: plugin.name,
    name,
    description: summary || description,
    summary: summary || undefined,
    creator:
      typeof raw.author === 'string' && raw.author.trim() !== ''
        ? raw.author.trim()
        : '像素酒馆作者',
    kind: 'character',
    sourceUrl: `https://chat.xstavern.com/market?search=${encodeURIComponent(name)}`,
    downloadUrl: `${PIXEL_TAVERN_API}?action=download&format=json&slug=${encodeURIComponent(slug)}`,
    coverUrl:
      typeof raw.preview_url === 'string' && raw.preview_url
        ? gateway !== null
          ? gateway + '/api/v1/market/image?url=' + encodeURIComponent(raw.preview_url)
          : raw.preview_url
        : undefined,
    fileName: slug + '.json',
    tags,
    license: '以站点与作者说明为准',
    licenseUrl: 'https://chat.xstavern.com/market',
    series: series || undefined,
    category: category || undefined,
    downloadCount: typeof raw.download_count === 'number' ? raw.download_count : undefined,
    rating: typeof raw.avg_rating === 'number' ? raw.avg_rating : undefined,
    ratingCount: typeof raw.rating_count === 'number' ? raw.rating_count : undefined,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : undefined,
  }
}

const collectPixelCards = (
  plugin: MarketplacePlugin,
  payloads: PromiseSettledResult<string>[],
  gateway: string | null
): { cards: MarketCard[]; firstError: unknown } => {
  const cards: MarketCard[] = []
  const seen = new Set<string>()
  let firstError: unknown = null
  for (const result of payloads) {
    if (result.status !== 'fulfilled') {
      firstError ??= result.reason
      continue
    }
    let data: unknown
    try {
      data = JSON.parse(result.value)
    } catch {
      continue
    }
    if (!isRecord(data) || data.success !== true || !Array.isArray(data.cards)) continue
    for (const raw of data.cards) {
      if (!isRecord(raw)) continue
      const card = mapPixelCard(plugin, raw, gateway)
      if (!card || seen.has(card.id)) continue
      seen.add(card.id)
      cards.push(card)
    }
  }
  return { cards, firstError }
}

const loadPixelCharacters = async (
  plugin: MarketplacePlugin,
  customOrigin?: string
): Promise<MarketCard[]> => {
  const cookie = readNativeCookie(plugin.id)
  const gateway = await resolveGatewayOrigin(customOrigin)
  const settled = await Promise.allSettled(
    Array.from({ length: PIXEL_TAVERN_PAGES }, (_, index) =>
      requestText(
        `${PIXEL_TAVERN_API}?action=list&page=${index + 1}&sort=popular&limit=${PIXEL_TAVERN_LIMIT}`,
        true,
        customOrigin,
        cookie
      )
    )
  )
  const { cards, firstError } = collectPixelCards(plugin, settled, gateway)
  if (cards.length === 0) {
    throw new Error(
      firstError ? friendlyError(firstError) : '像素酒馆暂时没有返回可浏览的卡片'
    )
  }
  return cards
}

const loadPixelResources = async (
  plugin: MarketplacePlugin,
  customOrigin?: string
): Promise<MarketCard[]> => {
  const cookie = readNativeCookie(plugin.id)
  const urls = [
    ...Array.from(
      { length: PIXEL_TAVERN_RESOURCE_PAGES },
      (_, index) => `${PIXEL_TAVERN_RESOURCES}?page=${index + 1}&type=worldbook`
    ),
    `${PIXEL_TAVERN_RESOURCES}?page=1&type=preset`,
  ]
  const settled = await Promise.allSettled(
    urls.map((url) => requestText(url, true, customOrigin, cookie))
  )
  const cards: MarketCard[] = []
  const seen = new Set<string>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    let data: unknown
    try {
      data = JSON.parse(result.value)
    } catch {
      continue
    }
    if (!isRecord(data) || data.success !== true || !Array.isArray(data.resources)) continue
    for (const raw of data.resources) {
      if (!isRecord(raw) || raw.nsfw === true) continue
      const id = typeof raw.id === 'string' ? raw.id : ''
      const title = typeof raw.title === 'string' ? raw.title : ''
      const kind = raw.type === 'worldbook' ? 'world' : raw.type === 'preset' ? 'rule' : null
      if (!id || !title || !kind || seen.has(id)) continue
      seen.add(id)
      const fileName =
        typeof raw.file_name === 'string' && raw.file_name ? raw.file_name : `${title}.json`
      const description = typeof raw.description === 'string' ? raw.description : ''
      const collection = typeof raw.collection === 'string' ? raw.collection : ''
      const tags = Array.isArray(raw.tags)
        ? raw.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12)
        : []
      if (isBlockedMarketContent(title, description, collection, tags.join(' '))) continue
      cards.push({
        id: plugin.id + ':' + id,
        pluginId: plugin.id,
        pluginName: plugin.name,
        name: title,
        description,
        summary: description || undefined,
        creator: collection || plugin.author,
        kind,
        sourceUrl: `https://chat.xstavern.com/market/resources?search=${encodeURIComponent(title)}`,
        downloadUrl: `${PIXEL_TAVERN_RESOURCES}/${encodeURIComponent(id)}/download`,
        fileName,
        tags,
        license: '以站点与作者说明为准',
        licenseUrl: 'https://chat.xstavern.com/market/resources',
        category: collection || undefined,
        downloadCount:
          typeof raw.download_count === 'number' ? raw.download_count : undefined,
      })
    }
  }
  return cards
}

const loadPixelTavernCards = async (
  plugin: MarketplacePlugin,
  customOrigin?: string
): Promise<MarketCard[]> => {
  const [characters, resources] = await Promise.allSettled([
    loadPixelCharacters(plugin, customOrigin),
    loadPixelResources(plugin, customOrigin),
  ])
  const cards: MarketCard[] = []
  if (characters.status === 'fulfilled') cards.push(...characters.value)
  if (resources.status === 'fulfilled') cards.push(...resources.value)
  if (cards.length === 0) {
    const reason = characters.status === 'rejected' ? characters.reason : null
    throw new Error(
      reason ? friendlyError(reason) : '像素酒馆暂时没有返回可浏览的卡片'
    )
  }
  return cards
}

const pixelSearchCache = new Map<string, { expiresAt: number; cards: MarketCard[] }>()

const stripChubNamespacePrefix = (fullPath: string, kind: MarketResourceKind): string => {
  if (kind === 'world') return fullPath.replace(/^lorebooks\//, '')
  if (kind === 'rule') return fullPath.replace(/^presets\//, '')
  return fullPath.replace(/^characters\//, '')
}

const parseChubNodes = (
  plugin: MarketplacePlugin,
  text: string,
  kind: MarketResourceKind
): MarketCard[] => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const nodes = isRecord(data) && isRecord(data.data) && Array.isArray(data.data.nodes)
    ? data.data.nodes
    : []
  const cards: MarketCard[] = []
  for (const raw of nodes) {
    if (!isRecord(raw) || raw.nsfw_image === true || raw.is_unlisted === true) continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const fullPath = typeof raw.fullPath === 'string' ? raw.fullPath.trim() : ''
    if (!name || !fullPath) continue

    const topics = Array.isArray(raw.topics)
      ? raw.topics.filter((t): t is string => typeof t === 'string').slice(0, 12)
      : []
    if (topics.some((topic) => CHUB_BLOCKED_TOPICS.test(topic))) continue

    const tagline = typeof raw.tagline === 'string' ? raw.tagline.trim() : ''
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    if (isBlockedMarketContent(name, tagline, description, topics.join(' '))) continue

    const cleanSlug = stripChubNamespacePrefix(fullPath, kind)
    const creator = cleanSlug.split('/')[0] || plugin.author
    const baseName = cleanSlug.split('/').pop() || name
    const fileSlug = baseName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]+/g, '_') || 'card'
    const avatarUrl =
      typeof raw.avatar_url === 'string' && raw.avatar_url.startsWith('https://')
        ? raw.avatar_url
        : undefined
    const maxResUrl =
      typeof raw.max_res_url === 'string' && raw.max_res_url.startsWith('https://')
        ? raw.max_res_url
        : `${CHUB_AVATAR_BASE}/${cleanSlug}/chara_card_v2.png`

    const sourcePathPrefix =
      kind === 'world' ? 'lorebooks' : kind === 'rule' ? 'presets' : 'characters'
    const downloadUrl =
      kind === 'character'
        ? maxResUrl
        : kind === 'world'
          ? `${CHUB_API_BASE}/api/lorebooks/${cleanSlug}?full=true`
          : `${CHUB_API_BASE}/api/presets/${cleanSlug}?full=true`

    cards.push({
      id: `${kind}:${cleanSlug}`,
      pluginId: plugin.id,
      pluginName: plugin.name,
      name,
      description: tagline || description,
      summary: description || tagline || undefined,
      creator,
      kind,
      sourceUrl: `https://chub.ai/${sourcePathPrefix}/${cleanSlug}`,
      downloadUrl,
      coverUrl: avatarUrl,
      fileName: kind === 'character' ? `${fileSlug}.png` : `${fileSlug}.json`,
      tags: topics,
      license: '以站点与作者卡片说明为准',
      licenseUrl: `https://chub.ai/${sourcePathPrefix}/${cleanSlug}`,
      downloadCount: typeof raw.nChats === 'number' ? raw.nChats : undefined,
      rating: typeof raw.rating === 'number' ? raw.rating : undefined,
      ratingCount: typeof raw.ratingCount === 'number' ? raw.ratingCount : undefined,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    })
  }
  return cards
}

const buildChubRequests = (
  pluginId: string,
  page = 1
): Array<{ kind: MarketResourceKind; url: string }> => {
  if (pluginId === 'chub-zh') {
    return [
      {
        kind: 'character',
        url: `${CHUB_API_BASE}/search?first=20&page=${page}&sort=star_count&nsfw=false&namespace=characters&search=${encodeURIComponent('中文')}`,
      },
      {
        kind: 'character',
        url: `${CHUB_API_BASE}/search?first=18&page=${page}&sort=star_count&nsfw=false&namespace=characters&topics=Anime&min_tokens=150`,
      },
      {
        kind: 'world',
        url: `${CHUB_API_BASE}/search?first=10&page=${page}&sort=star_count&nsfw=false&namespace=lorebooks&search=${encodeURIComponent('中文')}`,
      },
    ]
  }
  if (pluginId === 'chub-rpg') {
    return [
      {
        kind: 'character',
        url: `${CHUB_API_BASE}/search?first=18&page=${page}&sort=star_count&nsfw=false&namespace=characters&topics=Fantasy&min_tokens=150`,
      },
      {
        kind: 'character',
        url: `${CHUB_API_BASE}/search?first=12&page=${page}&sort=star_count&nsfw=false&namespace=characters&topics=RPG&min_tokens=150`,
      },
      {
        kind: 'character',
        url: `${CHUB_API_BASE}/search?first=10&page=${page}&sort=star_count&nsfw=false&namespace=characters&topics=${encodeURIComponent('AI assistant')}`,
      },
      {
        kind: 'world',
        url: `${CHUB_API_BASE}/search?first=12&page=${page}&sort=star_count&nsfw=false&namespace=lorebooks&topics=Fantasy`,
      },
    ]
  }
  return [
    {
      kind: 'character',
      url: `${CHUB_API_BASE}/search?first=24&page=${page}&sort=star_count&nsfw=false&namespace=characters&topics=SFW&min_tokens=150`,
    },
    {
      kind: 'world',
      url: `${CHUB_API_BASE}/search?first=12&page=${page}&sort=star_count&nsfw=false&namespace=lorebooks&min_tokens=150`,
    },
    {
      kind: 'rule',
      url: `${CHUB_API_BASE}/search?first=12&page=${page}&sort=star_count&nsfw=false&namespace=presets`,
    },
  ]
}

const loadChubCards = async (
  plugin: MarketplacePlugin,
  customOrigin?: string,
  page = 1
): Promise<MarketCard[]> => {
  const requests = buildChubRequests(plugin.id, page)
  const settled = await runWithConcurrency(
    requests.map((item) => () => requestText(item.url, false, customOrigin)),
    2
  )
  const cards: MarketCard[] = []
  const seen = new Set<string>()
  const seenTitleCreator = new Set<string>()
  for (let i = 0; i < requests.length; i += 1) {
    const res = settled[i]
    if (!res || res.status !== 'fulfilled') continue
    for (const card of parseChubNodes(plugin, res.value, requests[i]!.kind)) {
      const titleKey = `${card.kind}:${card.name.toLowerCase()}:${card.creator.toLowerCase()}`
      if (seen.has(card.id) || seenTitleCreator.has(titleKey)) continue
      seen.add(card.id)
      seenTitleCreator.add(titleKey)
      cards.push(card)
    }
  }
  if (cards.length === 0) {
    const reason = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected')?.reason
    throw new Error(reason ? friendlyError(reason) : 'Chub.ai 暂时没有返回可浏览的卡片')
  }
  return cards
}

export async function loadMoreMarketCards(
  page: number,
  customOrigin?: string
): Promise<MarketCard[]> {
  const chubPlugins = BUILTIN_MARKET_PLUGINS.filter((p) => CHUB_PLUGIN_IDS.has(p.id))
  const settled = await runWithConcurrency(
    chubPlugins.map((plugin) => () => loadChubCards(plugin, customOrigin, page)),
    2
  )
  const cards: MarketCard[] = []
  const seen = new Set<string>()
  for (const res of settled) {
    if (res.status !== 'fulfilled') continue
    for (const card of res.value) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      cards.push(card)
    }
  }
  return cards
}

const searchChubCards = async (
  plugin: MarketplacePlugin,
  trimmedQuery: string,
  customOrigin?: string
): Promise<MarketCard[]> => {
  const q = encodeURIComponent(trimmedQuery)
  const requests: Array<{ kind: MarketResourceKind; url: string }> = [
    {
      kind: 'character',
      url: `${CHUB_API_BASE}/search?first=16&page=1&sort=star_count&nsfw=false&namespace=characters&search=${q}`,
    },
    {
      kind: 'world',
      url: `${CHUB_API_BASE}/search?first=8&page=1&sort=star_count&nsfw=false&namespace=lorebooks&search=${q}`,
    },
    {
      kind: 'rule',
      url: `${CHUB_API_BASE}/search?first=6&page=1&sort=star_count&nsfw=false&namespace=presets&search=${q}`,
    },
  ]
  const settled = await runWithConcurrency(
    requests.map((item) => () => requestText(item.url, false, customOrigin)),
    2
  )
  const cards: MarketCard[] = []
  const seen = new Set<string>()
  const seenTitleCreator = new Set<string>()
  for (let i = 0; i < requests.length; i += 1) {
    const res = settled[i]
    if (!res || res.status !== 'fulfilled') continue
    for (const card of parseChubNodes(plugin, res.value, requests[i]!.kind)) {
      const titleKey = `${card.kind}:${card.name.toLowerCase()}:${card.creator.toLowerCase()}`
      if (seen.has(card.id) || seenTitleCreator.has(titleKey)) continue
      seen.add(card.id)
      seenTitleCreator.add(titleKey)
      cards.push(card)
    }
  }
  return cards
}

export async function searchMarketCards(
  query: string,
  customOrigin?: string
): Promise<MarketCard[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const cacheKey = trimmed.toLocaleLowerCase()
  const cached = pixelSearchCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.cards

  const pixelPlugin = BUILTIN_MARKET_PLUGINS.find((entry) => entry.id === 'pixel-tavern')
  const chubPlugin = BUILTIN_MARKET_PLUGINS.find((entry) => entry.id === 'chub-ai')
  const gateway = await resolveGatewayOrigin(customOrigin)
  const pixelLoggedIn = pixelPlugin
    ? await getMarketAuthStatus(pixelPlugin.id, customOrigin)
        .then((s) => s.loggedIn)
        .catch(() => false)
    : false

  const [pixelSettled, chubCardsSettled] = await Promise.allSettled([
    pixelPlugin && pixelLoggedIn
      ? Promise.allSettled(
          [1, 2].map((page) =>
            requestText(
              `${PIXEL_TAVERN_API}?action=list&page=${page}&sort=popular&limit=24&search=${encodeURIComponent(trimmed)}`,
              true,
              customOrigin,
              readNativeCookie(pixelPlugin.id)
            )
          )
        ).then((settled) => collectPixelCards(pixelPlugin, settled, gateway).cards)
      : Promise.resolve([]),
    chubPlugin ? searchChubCards(chubPlugin, trimmed, customOrigin) : Promise.resolve([]),
  ])

  const cards: MarketCard[] = []
  if (pixelSettled.status === 'fulfilled') cards.push(...pixelSettled.value)
  if (chubCardsSettled.status === 'fulfilled') cards.push(...chubCardsSettled.value)

  pixelSearchCache.set(cacheKey, { expiresAt: Date.now() + CARDS_CACHE_MS, cards })
  return cards
}

const BUILTIN_PARSERS: Record<string, (plugin: MarketplacePlugin, html: string) => MarketCard[]> = {
  'bae-ppl-studio': parseBae,
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
  if (!trimmed) throw new Error('请填写来源清单地址')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('来源清单地址无效')
  }
  if (url.protocol !== 'https:') throw new Error('来源清单必须是 HTTPS 地址')
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
    throw new Error('来源清单不是有效的 JSON')
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
    auth: plugin.auth,
  }))

  const subscribed = await Promise.all(
    readManifestUrls().map(async (url): Promise<MarketPluginView> => {
      try {
        const manifest = await loadManifest(url)
        if (builtinIds.has(manifest.id)) {
          throw new Error('来源 id 与内置插件冲突：' + manifest.id)
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
  authRequired?: boolean
  loggedIn?: boolean
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

  await runWithConcurrency(
    plugins.map((plugin) => async () => {
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
      if (plugin.auth) {
        const auth = await getMarketAuthStatus(plugin.id, customOrigin).catch(() => ({
          loggedIn: false,
        }))
        if (!auth.loggedIn) {
          sources.push({
            id: plugin.id,
            name: plugin.name,
            builtin: plugin.builtin,
            count: 0,
            authRequired: true,
            loggedIn: false,
          })
          onUpdate?.({ cards: [...cards], sources: [...sources] })
          return
        }
      }
      try {
        const sourceCards = await loadMarketCards(plugin, customOrigin)
        cards.push(...sourceCards)
        sources.push({
          id: plugin.id,
          name: plugin.name,
          builtin: plugin.builtin,
          count: sourceCards.length,
          ...(plugin.auth ? { authRequired: true, loggedIn: true } : {}),
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
    }),
    2
  )

  return { cards, sources }
}

export async function loadMarketCards(
  plugin: MarketPluginView,
  customOrigin?: string
): Promise<MarketCard[]> {
  if (plugin.error) throw new Error(plugin.error)

  if (plugin.manifest) {
    return plugin.manifest.cards
      .filter(
        (card) =>
          !isBlockedMarketContent(
            card.name,
            card.description,
            card.summary,
            card.tags.join(' ')
          )
      )
      .map((card) => ({
        ...card,
        pluginId: plugin.manifest!.id,
        pluginName: plugin.manifest!.name,
      }))
  }

  const cachedKey = plugin.id
  const cached = cardsCache.get(cachedKey)
  if (cached && cached.expiresAt > Date.now()) return cached.cards

  const definition = BUILTIN_MARKET_PLUGINS.find((entry) => entry.id === plugin.id)

  if (plugin.id === 'pixel-tavern') {
    if (!definition) throw new Error('像素酒馆来源配置缺失')
    const cards = await loadPixelTavernCards(definition, customOrigin)
    cardsCache.set(cachedKey, { expiresAt: Date.now() + CARDS_CACHE_MS, cards })
    return cards
  }

  if (CHUB_PLUGIN_IDS.has(plugin.id)) {
    if (!definition) throw new Error('Chub.ai 来源配置缺失')
    const cards = await loadChubCards(definition, customOrigin)
    cardsCache.set(cachedKey, { expiresAt: Date.now() + CARDS_CACHE_MS, cards })
    return cards
  }

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
  if (CHUB_PLUGIN_IDS.has(card.pluginId)) {
    if (card.kind === 'world' || card.kind === 'rule') {
      const jsonText = await requestText(card.downloadUrl, false, customOrigin)
      const parsed: unknown = JSON.parse(jsonText)
      const normalized =
        card.kind === 'world'
          ? normalizeChubLorebookPayload(parsed, card.name)
          : normalizeChubPresetPayload(parsed, card.name)
      return new TextEncoder().encode(JSON.stringify(normalized))
    }

    try {
      const pngBytes = await requestBytes(card.downloadUrl, false, customOrigin)
      if (looksLikePng(pngBytes)) {
        readCharacterJsonFromPng(pngBytes)
        return pngBytes
      }
    } catch {
      // 如果头像地址缺少内嵌 V2 PNG，自动回退读取 Chub 角色卡 API JSON
    }
    const slug = card.id.replace(/^character:/, '')
    const detailText = await requestText(
      `${CHUB_API_BASE}/api/characters/${slug}?full=true`,
      false,
      customOrigin
    )
    const normalized = normalizeChubCharacterPayload(JSON.parse(detailText), card.name)
    return new TextEncoder().encode(JSON.stringify(normalized))
  }

  return requestBytes(card.downloadUrl, builtin, customOrigin, readNativeCookie(card.pluginId))
}

export async function addManifestPlugin(rawUrl: string): Promise<MarketPluginView> {
  const url = normalizeManifestUrl(rawUrl)
  const urls = readManifestUrls()
  if (urls.includes(url)) throw new Error('这个来源已经添加过了')
  if (urls.length >= MAX_MANIFESTS) throw new Error(`最多同时订阅 ${MAX_MANIFESTS} 个来源`)
  const manifest = await loadManifest(url, true)
  if (BUILTIN_MARKET_PLUGINS.some((plugin) => plugin.id === manifest.id)) {
    throw new Error('来源 id 与内置插件冲突')
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
