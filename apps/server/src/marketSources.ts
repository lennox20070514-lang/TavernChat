import {
  DEMO_MARKETPLACE_SOURCES,
  type MarketplaceCatalog,
  type MarketplaceItem,
  type MarketplaceSource,
  type MarketplaceSourceStatus,
} from '@tavern-chat/core'

const MAX_SOURCE_PAGE_BYTES = 4 * 1024 * 1024
const CATALOG_CACHE_MS = 2 * 60 * 1000

let catalogCache: { expiresAt: number; catalog: MarketplaceCatalog } | null = null

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number(decimal))
    )
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
}

function textFromHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function absolutize(url: string, sourceUrl: string): string {
  return new URL(decodeHtml(url), sourceUrl).toString()
}

async function getSourcePage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(12_000),
    redirect: 'error',
  })
  if (!response.ok || !response.body) {
    throw new Error('来源返回 HTTP ' + response.status)
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_SOURCE_PAGE_BYTES) {
        await reader.cancel()
        throw new Error('来源目录超过 4 MB 读取限制')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function itemBase(
  source: MarketplaceSource,
  slug: string,
  name: string,
  description: string,
  creator: string,
  downloadUrl: string,
  coverUrl: string | undefined,
  sourceUrl: string,
  tags: string[],
  license: string,
  licenseUrl?: string
): MarketplaceItem {
  return {
    id: source.id + ':' + slug,
    providerId: source.id,
    providerName: source.name,
    kind: 'character',
    name,
    description,
    creator,
    sourceUrl,
    downloadUrl,
    coverUrl,
    fileName: slug + '.png',
    tags,
    license,
    licenseUrl,
    price: { type: 'free' },
  }
}

function parseTuniang(source: MarketplaceSource, html: string): MarketplaceItem[] {
  const cardStarts = [...html.matchAll(/<div class="cc">/gi)].map((match) => match.index ?? -1)
  const licenseUrl = 'https://creativecommons.org/licenses/by/4.0/'
  const items: MarketplaceItem[] = []

  for (let index = 0; index < cardStarts.length; index += 1) {
    const start = cardStarts[index]!
    const end = cardStarts[index + 1] ?? html.length
    const block = html.slice(start, end)
    const download = block.match(/href=["']([^"']+\.png)["'][^>]*\bdownload\b/i)
    const name = textFromHtml(block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '')
    if (!download || !name) continue

    const slug = decodeHtml(download[1]!).split('/').pop()!.replace(/\.png$/i, '')
    const teaser = textFromHtml(block.match(/<p class="cc-teaser">([\s\S]*?)<\/p>/i)?.[1] ?? '')
    const credit = textFromHtml(block.match(/<div class="cc-by">([\s\S]*?)<\/div>/i)?.[1] ?? '')
    const creator = credit.match(/CC BY 4\.0\s*[·•]\s*([^()]+)/i)?.[1]?.trim() ?? 'Foreverse Team'
    const tagsBlock = block.match(/<div class="cc-tags">([\s\S]*?)<\/div>/i)?.[1] ?? ''
    const tags = [...tagsBlock.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((tag) => textFromHtml(tag[1]!))
      .filter(Boolean)
    const coverPath = block.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
    const cardUrl = absolutize(download[1]!, source.url)
    items.push(
      itemBase(
        source,
        slug,
        name,
        teaser,
        creator,
        cardUrl,
        coverPath ? absolutize(coverPath, source.url) : undefined,
        source.url,
        tags,
        'CC BY 4.0',
        licenseUrl
      )
    )
  }
  return items
}

function parseBae(source: MarketplaceSource, html: string): MarketplaceItem[] {
  const pngLinks = [...html.matchAll(/<a\b[^>]*href=["']([^"']+\.png)["'][^>]*download=["']([^"']+)["'][^>]*>\s*PNG with portrait\s*<\/a>/gi)]
  const items: MarketplaceItem[] = []

  for (const link of pngLinks) {
    const linkIndex = link.index ?? -1
    const start = html.lastIndexOf('<li', linkIndex)
    const close = html.indexOf('</li>', linkIndex)
    if (start < 0 || close < 0) continue
    const block = html.slice(start, close)
    const name = textFromHtml(block.match(/<p class="font-display[^\"]*">([\s\S]*?)<\/p>/i)?.[1] ?? '')
    if (!name) continue

    const description = textFromHtml(
      block.match(/<p class="mt-2 text-sm[^\"]*">([\s\S]*?)<\/p>/i)?.[1] ?? ''
    )
    const detailPath = block.match(/href=["']([^"']+)["'][^>]*>Meet\s*<!--\s*-->[\s\S]*?on Bae/i)?.[1]
    const coverPath = block.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
    const fileName = decodeHtml(link[2]!)
    const slug = fileName.replace(/\.png$/i, '').replace(/^bae-/, '')
    items.push(
      itemBase(
        source,
        slug,
        name,
        description,
        'Bae · ppl.studio',
        absolutize(link[1]!, source.url),
        coverPath ? absolutize(coverPath, source.url) : undefined,
        detailPath ? absolutize(detailPath, source.url) : source.url,
        [],
        '可使用、编辑与分享（站点说明）',
        source.url
      )
    )
  }
  return items
}

async function fetchSourceItems(source: MarketplaceSource): Promise<MarketplaceItem[]> {
  const html = await getSourcePage(source.url)
  if (source.id === 'tuniang-foreverse') return parseTuniang(source, html)
  if (source.id === 'bae-ppl-studio') return parseBae(source, html)
  return []
}

export async function loadMarketplaceCatalog(force = false): Promise<MarketplaceCatalog> {
  if (!force && catalogCache && catalogCache.expiresAt > Date.now()) {
    return catalogCache.catalog
  }

  const results = await Promise.all(
    DEMO_MARKETPLACE_SOURCES.map(async (source) => {
      try {
        const items = await fetchSourceItems(source)
        if (items.length === 0) throw new Error('来源目录没有返回可识别的 PNG 卡片')
        const status: MarketplaceSourceStatus = { ...source, available: true }
        return { items, status }
      } catch (error) {
        const status: MarketplaceSourceStatus = {
          ...source,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        }
        return { items: [] as MarketplaceItem[], status }
      }
    })
  )

  const catalog: MarketplaceCatalog = {
    sources: results.map((result) => result.status),
    items: results.flatMap((result) => result.items),
  }
  catalogCache = { expiresAt: Date.now() + CATALOG_CACHE_MS, catalog }
  return catalog
}

export async function findMarketplaceItem(itemId: string): Promise<MarketplaceItem | undefined> {
  const catalog = await loadMarketplaceCatalog()
  return catalog.items.find((item) => item.id === itemId)
}
