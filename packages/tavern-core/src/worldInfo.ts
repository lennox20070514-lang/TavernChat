import { estimateTokens } from './token.ts'
import type {
  TriggeredWorldSnapshot,
  WorldComponent,
  WorldEntry,
  WorldEntryPosition,
} from './types.ts'

export type WorldScanInput = {
  worlds: Array<{
    world: WorldComponent
    disabledEntryIds?: Set<string>
  }>
  /** 按时间顺序排列的聊天文本（最新消息在数组末尾） */
  chatTexts: string[]
  /** 可选附加扫描文本（例如角色设定、场景等） */
  extraScanText?: string
  /** 全局默认世界书 Token 预算（单张世界卡可覆写，0 表示按最大上下文 25% 估算） */
  defaultBudgetTokens?: number
  /** 可选随机数生成器（便于确定性单元测试） */
  rng?: () => number
}

export type ActivatedWorldEntry = {
  worldId: string
  worldName: string
  entry: WorldEntry
  reason: 'constant' | 'keyword' | 'recursion'
  matchedKeys: string[]
  tokens: number
}

export type WorldScanResult = {
  beforeChar: ActivatedWorldEntry[]
  afterChar: ActivatedWorldEntry[]
  beforeAn: ActivatedWorldEntry[]
  afterAn: ActivatedWorldEntry[]
  atDepth: ActivatedWorldEntry[]
  snapshots: TriggeredWorldSnapshot[]
  totalTokens: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchSingleKey(
  haystack: string,
  rawKey: string,
  caseSensitive: boolean,
  matchWholeWords: boolean
): boolean {
  const key = rawKey.trim()
  if (!key) return false

  // 支持 SillyTavern 风格的正则关键词 `/pattern/flags`
  const regexLiteral = key.match(/^\/(.+)\/([gimsuy]*)$/)
  if (regexLiteral) {
    try {
      const flags = regexLiteral[2] || (caseSensitive ? '' : 'i')
      return new RegExp(regexLiteral[1]!, flags).test(haystack)
    } catch {
      return false
    }
  }

  if (matchWholeWords) {
    // 对纯 ASCII 单词使用 \b 边界；中文/混合词直接按子串匹配避免误漏
    const isAsciiWord = /^[A-Za-z0-9_]+$/.test(key)
    if (isAsciiWord) {
      const re = new RegExp(`\\b${escapeRegExp(key)}\\b`, caseSensitive ? '' : 'i')
      return re.test(haystack)
    }
  }

  if (caseSensitive) {
    return haystack.includes(key)
  }
  return haystack.toLowerCase().includes(key.toLowerCase())
}

function evaluateEntryMatch(
  haystack: string,
  entry: WorldEntry,
  caseSensitive: boolean,
  matchWholeWords: boolean
): { matched: boolean; matchedKeys: string[] } {
  const primaryMatched: string[] = []
  for (const key of entry.keys) {
    if (matchSingleKey(haystack, key, caseSensitive, matchWholeWords)) {
      primaryMatched.push(key.trim())
    }
  }
  if (primaryMatched.length === 0) {
    return { matched: false, matchedKeys: [] }
  }

  const secondaryKeys = entry.secondaryKeys.map((k) => k.trim()).filter(Boolean)
  if (secondaryKeys.length === 0) {
    return { matched: true, matchedKeys: primaryMatched }
  }

  const secondaryHits = secondaryKeys.filter((k) =>
    matchSingleKey(haystack, k, caseSensitive, matchWholeWords)
  )

  switch (entry.selectiveLogic) {
    case 'and_any':
      return secondaryHits.length > 0
        ? { matched: true, matchedKeys: [...primaryMatched, ...secondaryHits] }
        : { matched: false, matchedKeys: [] }
    case 'and_all':
      return secondaryHits.length === secondaryKeys.length
        ? { matched: true, matchedKeys: [...primaryMatched, ...secondaryHits] }
        : { matched: false, matchedKeys: [] }
    case 'not_any':
      return secondaryHits.length === 0
        ? { matched: true, matchedKeys: primaryMatched }
        : { matched: false, matchedKeys: [] }
    case 'not_all':
      return secondaryHits.length < secondaryKeys.length
        ? { matched: true, matchedKeys: primaryMatched }
        : { matched: false, matchedKeys: [] }
  }
}

function bucketPosition(pos: WorldEntryPosition): keyof Pick<
  WorldScanResult,
  'beforeChar' | 'afterChar' | 'beforeAn' | 'afterAn' | 'atDepth'
> {
  switch (pos) {
    case 'before_char':
      return 'beforeChar'
    case 'after_char':
      return 'afterChar'
    case 'before_an':
      return 'beforeAn'
    case 'after_an':
      return 'afterAn'
    case 'at_depth':
      return 'atDepth'
  }
}

/**
 * 扫描所有已选入对话的世界卡，返回按位置分桶、按优先级与预算裁剪后的激活条目。
 */
export function scanWorldInfo(input: WorldScanInput): WorldScanResult {
  const rng = input.rng ?? Math.random
  const candidates: Array<{
    uid: string
    world: WorldComponent
    entry: WorldEntry
    caseSensitive: boolean
    matchWholeWords: boolean
    scanDepth: number
  }> = []

  let maxBudget = input.defaultBudgetTokens ?? 2048
  let anyRecursive = false
  let maxRecursion = 2

  for (const { world, disabledEntryIds } of input.worlds) {
    const payload = world.payload
    if (payload.tokenBudget > 0) {
      maxBudget = Math.max(maxBudget, payload.tokenBudget)
    }
    if (payload.recursive) {
      anyRecursive = true
      maxRecursion = Math.max(maxRecursion, payload.maxRecursionSteps || 2)
    }

    for (const entry of payload.entries) {
      if (!entry.enabled || !entry.content.trim()) continue
      if (disabledEntryIds?.has(entry.id)) continue
      candidates.push({
        uid: `${world.id}::${entry.id}`,
        world,
        entry,
        caseSensitive: entry.caseSensitive ?? payload.caseSensitive ?? false,
        matchWholeWords: entry.matchWholeWords ?? payload.matchWholeWords ?? false,
        scanDepth: Math.max(1, entry.scanDepth ?? payload.scanDepth ?? 4),
      })
    }
  }

  // 按优先级 order 降序，其次保持原序
  candidates.sort((a, b) => b.entry.order - a.entry.order)

  const activatedMap = new Map<string, ActivatedWorldEntry>()

  const tryActivate = (
    item: (typeof candidates)[number],
    reason: 'constant' | 'keyword' | 'recursion',
    matchedKeys: string[]
  ): boolean => {
    if (activatedMap.has(item.uid)) return false
    const prob = item.entry.probability ?? 100
    if (prob < 100 && rng() * 100 > prob) {
      return false
    }
    activatedMap.set(item.uid, {
      worldId: item.world.id,
      worldName: item.world.name,
      entry: item.entry,
      reason,
      matchedKeys,
      tokens: estimateTokens(item.entry.content),
    })
    return true
  }

  // 第一轮：常驻（蓝灯）+ 基于聊天历史的关键词触发（绿灯）
  for (const item of candidates) {
    if (item.entry.constant) {
      tryActivate(item, 'constant', [])
      continue
    }
    const recentSlice = input.chatTexts.slice(-item.scanDepth)
    const haystack = [input.extraScanText ?? '', ...recentSlice].filter(Boolean).join('\n')
    if (!haystack) continue
    const res = evaluateEntryMatch(haystack, item.entry, item.caseSensitive, item.matchWholeWords)
    if (res.matched) {
      tryActivate(item, 'keyword', res.matchedKeys)
    }
  }

  // 递归扫描轮次：已激活条目的内容可以触发其他未激活的条目
  if (anyRecursive && activatedMap.size > 0) {
    let newlyActivated = [...activatedMap.values()].filter((a) => !a.entry.preventRecursion)
    let step = 0
    while (step < maxRecursion && newlyActivated.length > 0) {
      step++
      const recursionBuffer = newlyActivated.map((a) => a.entry.content).join('\n')
      const nextWave: ActivatedWorldEntry[] = []
      for (const item of candidates) {
        if (activatedMap.has(item.uid)) continue
        if (item.entry.excludeRecursion) continue
        const res = evaluateEntryMatch(
          recursionBuffer,
          item.entry,
          item.caseSensitive,
          item.matchWholeWords
        )
        if (res.matched && tryActivate(item, 'recursion', res.matchedKeys)) {
          const added = activatedMap.get(item.uid)
          if (added && !added.entry.preventRecursion) {
            nextWave.push(added)
          }
        }
      }
      newlyActivated = nextWave
    }
  }

  // 按 order 降序纳入 Token 预算（蓝灯常驻优先，其次按 order）
  const ordered = [...activatedMap.values()].sort((a, b) => {
    if (a.reason === 'constant' && b.reason !== 'constant') return -1
    if (b.reason === 'constant' && a.reason !== 'constant') return 1
    return b.entry.order - a.entry.order
  })

  const result: WorldScanResult = {
    beforeChar: [],
    afterChar: [],
    beforeAn: [],
    afterAn: [],
    atDepth: [],
    snapshots: [],
    totalTokens: 0,
  }

  for (const item of ordered) {
    if (maxBudget > 0 && result.totalTokens + item.tokens > maxBudget && result.snapshots.length > 0) {
      continue
    }
    const bucket = bucketPosition(item.entry.position)
    result[bucket].push(item)
    result.totalTokens += item.tokens
    result.snapshots.push({
      worldId: item.worldId,
      worldName: item.worldName,
      entryId: item.entry.id,
      entryName: item.entry.name,
      reason: item.reason,
      matchedKeys: item.matchedKeys,
      tokens: item.tokens,
    })
  }

  // 同位置内部按 order 升序（低权重在前，高权重更靠近对话尾部以获得更强注意力，与酒馆一致）
  const asc = (a: ActivatedWorldEntry, b: ActivatedWorldEntry) => a.entry.order - b.entry.order
  result.beforeChar.sort(asc)
  result.afterChar.sort(asc)
  result.beforeAn.sort(asc)
  result.afterAn.sort(asc)
  result.atDepth.sort(asc)

  return result
}
