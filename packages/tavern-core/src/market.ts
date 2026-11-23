export type MarketplacePrice =
  | { type: 'free' }
  | { type: 'paid'; amount: number; currency: 'CNY' | 'USD' }

/** 连接器接入的社区来源；市场目录由来源适配器实时读取。 */
export type MarketplaceSource = {
  id: string
  name: string
  url: string
  description: string
}

export type MarketplaceSourceStatus = MarketplaceSource & {
  available: boolean
  error?: string
}

/** 来源上的单张角色卡。条目由 source adapter 读取，不在客户端内置资源清单。 */
export type MarketplaceItem = {
  id: string
  providerId: string
  providerName: string
  kind: 'character'
  name: string
  description: string
  creator: string
  sourceUrl: string
  downloadUrl: string
  coverUrl?: string
  fileName: string
  tags: string[]
  license?: string
  licenseUrl?: string
  version?: string
  price: MarketplacePrice
}

export type MarketplaceCatalog = {
  sources: MarketplaceSourceStatus[]
  items: MarketplaceItem[]
}

/**
 * Demo 接入的是站点来源，不在这里维护单张卡片。
 * 每个来源由 server source adapter 拉取并映射为统一的角色卡格式。
 */
export const DEMO_MARKETPLACE_SOURCES: MarketplaceSource[] = [
  {
    id: 'tuniang-foreverse',
    name: '兔娘 · Foreverse',
    url: 'https://tuniang.app/cards/',
    description: 'Foreverse 创作的 SFW 角色卡目录，CC BY 4.0，可下载 PNG。',
  },
  {
    id: 'bae-ppl-studio',
    name: 'Bae · ppl.studio',
    url: 'https://bae.ppl.studio/tools/character-cards',
    description: '免登录的 SillyTavern 角色卡目录，站点说明支持使用、编辑和分享。',
  },
]
