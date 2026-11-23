import {
  DEMO_MARKETPLACE_SOURCES,
  type MarketplaceCatalog,
  type MarketplaceItem,
} from '@tavern-chat/core'
import { resolveGatewayOrigin } from './llm/client.ts'

const offlineCatalog = (): MarketplaceCatalog => ({
  sources: DEMO_MARKETPLACE_SOURCES.map((source) => ({
    ...source,
    available: false,
    error: '连接市场网关后读取来源目录',
  })),
  items: [],
})

export async function getMarketplaceGateway(customOrigin?: string): Promise<string | null> {
  const gateway = await resolveGatewayOrigin(customOrigin)
  if (gateway === null) return null
  try {
    const res = await fetch(gateway + '/api/v1/health', {
      signal: AbortSignal.timeout(2_500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      app?: string
      capabilities?: { market?: boolean }
    }
    return data.app === 'TavernChat' && data.capabilities?.market ? gateway : null
  } catch {
    return null
  }
}

export async function loadMarketplaceCatalog(customOrigin?: string): Promise<MarketplaceCatalog> {
  const gateway = await getMarketplaceGateway(customOrigin)
  if (gateway === null) return offlineCatalog()
  try {
    const res = await fetch(gateway + '/api/v1/market/catalog', {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return offlineCatalog()
    const data = (await res.json()) as Partial<MarketplaceCatalog>
    return Array.isArray(data.sources) && Array.isArray(data.items)
      ? { sources: data.sources, items: data.items }
      : offlineCatalog()
  } catch {
    return offlineCatalog()
  }
}

export async function downloadMarketplaceItem(
  item: MarketplaceItem,
  customOrigin?: string
): Promise<Uint8Array> {
  const gateway = await getMarketplaceGateway(customOrigin)
  if (gateway === null) {
    throw new Error('当前设备没有连接市场网关。请配置本地或局域网网关后再下载。')
  }

  const res = await fetch(gateway + '/api/v1/market/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: item.id }),
    signal: AbortSignal.timeout(25_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = text
    try {
      const data = JSON.parse(text) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // 保留网关返回的纯文本信息。
    }
    throw new Error(message || ('HTTP ' + res.status))
  }
  return new Uint8Array(await res.arrayBuffer())
}
