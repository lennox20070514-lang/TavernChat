/** 市场接入的单位是“来源插件”，不是单张卡片；卡片由插件目录提供。 */
export type MarketplacePlugin = {
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage?: string
  license?: string
  /** 插件目录的公开入口 */
  catalogUrl: string
  /** 网关代理只放行这些主机 */
  hosts: string[]
  /** 网关代理只放行这些路径前缀 */
  allowedPathPrefixes: string[]
  /** 内置插件随应用发布，外部插件通过清单地址订阅 */
  builtin: boolean
}

/**
 * 内置来源插件。
 * 默认免费，后续新增付费来源时不需要改动卡片或对话逻辑。
 */
export const BUILTIN_MARKET_PLUGINS: MarketplacePlugin[] = [
  {
    id: 'bae-ppl-studio',
    name: 'Bae · ppl.studio',
    version: '1.0.0',
    description: '免登录的 SillyTavern PNG 角色卡目录，站点说明可使用、编辑和分享。',
    author: 'ppl.studio',
    homepage: 'https://bae.ppl.studio/tools/character-cards',
    license: '站点说明：可使用、编辑与分享',
    catalogUrl: 'https://bae.ppl.studio/tools/character-cards',
    hosts: ['bae.ppl.studio'],
    allowedPathPrefixes: ['/tools/character-cards'],
    builtin: true,
  },
]

/** 插件目录里的单张角色卡。 */
export type MarketCard = {
  id: string
  pluginId: string
  pluginName: string
  name: string
  description: string
  creator: string
  kind: 'character'
  sourceUrl?: string
  downloadUrl: string
  coverUrl?: string
  fileName: string
  tags: string[]
  license?: string
  licenseUrl?: string
}

/**
 * 外部插件清单格式：托管在支持 CORS 的 HTTPS 地址（例如 GitHub raw）。
 * 清单只描述卡片，不执行远程代码。
 */
export type MarketManifest = {
  schema: 1
  id: string
  name: string
  version: string
  description: string
  author: string
  homepage?: string
  license?: string
  cards: MarketManifestCard[]
}

export type MarketManifestCard = Omit<MarketCard, 'pluginId' | 'pluginName'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cleanString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('插件清单字段缺失：' + field)
  }
  return value.trim()
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const httpsUrl = (value: unknown, field: string): string => {
  const raw = cleanString(value, field)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('插件清单字段不是有效 URL：' + field)
  }
  if (url.protocol !== 'https:') {
    throw new Error('插件清单只允许 HTTPS 地址：' + field)
  }
  return url.toString()
}

const optionalHttpsUrl = (value: unknown, field: string): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : httpsUrl(value, field)

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 24)
    : []

/** 校验外部插件清单，避免插件市场被坏数据拖垮。 */
export function parseMarketManifest(value: unknown): MarketManifest {
  if (!isRecord(value)) throw new Error('插件清单必须是 JSON 对象')
  if (value.schema !== 1) throw new Error('插件清单版本不受支持（需要 schema: 1）')
  if (!Array.isArray(value.cards)) throw new Error('插件清单缺少 cards 数组')
  if (value.cards.length === 0) throw new Error('插件清单里没有卡片')
  if (value.cards.length > 500) throw new Error('单个插件最多允许 500 张卡片')

  const seen = new Set<string>()
  const cards = value.cards.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`第 ${index + 1} 张卡片格式无效`)
    const id = cleanString(raw.id, `cards[${index}].id`)
    if (seen.has(id)) throw new Error('插件清单存在重复卡片 id：' + id)
    seen.add(id)
    const fileName = cleanString(raw.fileName, `cards[${index}].fileName`)
    if (!/\.png$/i.test(fileName)) {
      throw new Error(`第 ${index + 1} 张卡片必须是 PNG：${fileName}`)
    }
    return {
      id,
      name: cleanString(raw.name, `cards[${index}].name`),
      description: optionalString(raw.description) ?? '',
      creator: cleanString(raw.creator, `cards[${index}].creator`),
      kind: 'character' as const,
      sourceUrl: optionalHttpsUrl(raw.sourceUrl, `cards[${index}].sourceUrl`),
      downloadUrl: httpsUrl(raw.downloadUrl, `cards[${index}].downloadUrl`),
      coverUrl: optionalHttpsUrl(raw.coverUrl, `cards[${index}].coverUrl`),
      fileName,
      tags: stringList(raw.tags),
      license: optionalString(raw.license),
      licenseUrl: optionalHttpsUrl(raw.licenseUrl, `cards[${index}].licenseUrl`),
    }
  })

  return {
    schema: 1,
    id: cleanString(value.id, 'id'),
    name: cleanString(value.name, 'name'),
    version: cleanString(value.version, 'version'),
    description: optionalString(value.description) ?? '',
    author: cleanString(value.author, 'author'),
    homepage: optionalHttpsUrl(value.homepage, 'homepage'),
    license: optionalString(value.license),
    cards,
  }
}
