import type {
  CharacterComponent,
  ChatMessage,
  ChatSession,
  GroupChatConfig,
  MountedComponent,
} from './types.ts'

export const DEFAULT_GROUP_CHAT_CONFIG: GroupChatConfig = {
  generationMode: 'swap',
  maxRepliesPerTurn: 0,
  encourageInteraction: true,
  hideMuted: false,
  autoMode: false,
  autoModeDelaySec: 4,
  joinPrefix: '### {{char}}',
  allowSelfReply: false,
}

export function resolveGroupChatConfig(session: Pick<ChatSession, 'groupConfig'>): GroupChatConfig {
  return {
    ...DEFAULT_GROUP_CHAT_CONFIG,
    ...(session.groupConfig ?? {}),
    joinPrefix: session.groupConfig?.joinPrefix ?? DEFAULT_GROUP_CHAT_CONFIG.joinPrefix,
  }
}

function extractNameAliases(name: string): string[] {
  const cleaned = name.trim()
  if (!cleaned) return []
  const parts = cleaned
    .split(/[\s·\-_/()（）]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2)
  const all = new Set<string>([cleaned, ...parts])
  // 按长度从长到短匹配，优先命中完整名字
  return [...all].sort((a, b) => b.length - a.length)
}

export function findMentionedCharacters(
  text: string,
  candidates: CharacterComponent[]
): CharacterComponent[] {
  const lower = text.toLowerCase()
  if (!lower.trim()) return []
  const hits: Array<{ char: CharacterComponent; index: number }> = []
  for (const char of candidates) {
    let earliest = -1
    for (const alias of extractNameAliases(char.name)) {
      const idx = lower.indexOf(alias.toLowerCase())
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx
      }
    }
    if (earliest !== -1) {
      hits.push({ char, index: earliest })
    }
  }
  hits.sort((a, b) => a.index - b.index)
  return hits.map((h) => h.char)
}

function shuffleWithRng<T>(items: T[], rng: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = copy[i]!
    copy[i] = copy[j]!
    copy[j] = tmp
  }
  return copy
}

export type DraftSpeakersResult =
  | { kind: 'narrator' }
  | { kind: 'speakers'; speakers: CharacterComponent[]; reason: string }

/**
 * 参照 SillyTavern 原生群聊排班策略，规划本轮依次发言的角色队列：
 * - shuffled_round（默认）：随机洗牌一轮，全部未静音成员依次接话并彼此回应
 * - natural：@点名提及优先 -> 话痨度独立摇号 -> 无人触发时保底随机挑 1 位
 * - round_robin：按成员列表顺序轮流接话
 * - manual：手动点名（仅在指定 speakerId 或主动点继发时发言）
 */
export function draftGroupSpeakers(options: {
  session: ChatSession
  activeChars: CharacterComponent[]
  history: ChatMessage[]
  explicitSpeakerId?: string
  isAutoContinuation?: boolean
  rng?: () => number
}): DraftSpeakersResult {
  const rng = options.rng ?? Math.random
  const cfg = resolveGroupChatConfig(options.session)
  const mountMap = new Map<string, MountedComponent>(
    options.session.mounts.map((m) => [m.componentId, m])
  )

  if (options.activeChars.length === 0) {
    return { kind: 'speakers', speakers: [], reason: 'no_characters' }
  }

  // 用户显式点名某位角色时，直接让该角色回应
  if (options.explicitSpeakerId) {
    const picked = options.activeChars.find((c) => c.id === options.explicitSpeakerId)
    return {
      kind: 'speakers',
      speakers: picked ? [picked] : [options.activeChars[0]!],
      reason: 'explicit',
    }
  }

  const eligible = options.activeChars.filter((c) => !mountMap.get(c.id)?.muted)
  if (eligible.length === 0) {
    return { kind: 'speakers', speakers: [], reason: 'all_muted' }
  }

  if (options.activeChars.length === 1) {
    return { kind: 'speakers', speakers: [eligible[0]!], reason: 'single' }
  }

  if (options.session.multiCharMode === 'narrator') {
    return { kind: 'narrator' }
  }

  if (options.session.multiCharMode === 'manual' && !options.isAutoContinuation) {
    return { kind: 'speakers', speakers: [], reason: 'manual_wait' }
  }

  const lastAiSpeakerId = [...options.history]
    .reverse()
    .find((m) => m.role === 'assistant' && m.speakerId)?.speakerId

  const capSpeakers = (list: CharacterComponent[]): CharacterComponent[] => {
    if (cfg.maxRepliesPerTurn > 0) {
      return list.slice(0, cfg.maxRepliesPerTurn)
    }
    return list
  }

  if (options.session.multiCharMode === 'round_robin') {
    const lastIdx = lastAiSpeakerId
      ? eligible.findIndex((c) => c.id === lastAiSpeakerId)
      : -1
    const rotated = eligible.map((_, idx) => eligible[(lastIdx + 1 + idx) % eligible.length]!)
    return {
      kind: 'speakers',
      speakers: capSpeakers(rotated),
      reason: 'round_robin',
    }
  }

  if (options.session.multiCharMode === 'natural') {
    const lastMsgText = options.history.at(-1)?.content ?? ''
    const mentioned = findMentionedCharacters(lastMsgText, eligible)
    const mentionedFiltered =
      !cfg.allowSelfReply && lastAiSpeakerId && mentioned.length > 1
        ? mentioned.filter((c) => c.id !== lastAiSpeakerId)
        : mentioned
    if (mentionedFiltered.length > 0) {
      return {
        kind: 'speakers',
        speakers: capSpeakers(mentionedFiltered),
        reason: 'natural_mention',
      }
    }

    const pool = shuffleWithRng(eligible, rng)
    const rolled = pool.filter((char) => {
      if (!cfg.allowSelfReply && lastAiSpeakerId && char.id === lastAiSpeakerId) {
        return false
      }
      const talkativeness = mountMap.get(char.id)?.talkativeness ?? 60
      return rng() * 100 < Math.max(0, Math.min(100, talkativeness))
    })
    if (rolled.length > 0) {
      return {
        kind: 'speakers',
        speakers: capSpeakers(rolled),
        reason: 'natural_talkativeness',
      }
    }

    const fallbackPool =
      !cfg.allowSelfReply && lastAiSpeakerId && pool.length > 1
        ? pool.filter((c) => c.id !== lastAiSpeakerId)
        : pool
    return {
      kind: 'speakers',
      speakers: [fallbackPool[0] ?? eligible[0]!],
      reason: 'natural_fallback',
    }
  }

  // 默认与手动续聊保底：shuffled_round（随机洗牌全员轮流）
  const shuffled = shuffleWithRng(eligible, rng)
  if (!cfg.allowSelfReply && lastAiSpeakerId && shuffled.length > 1 && shuffled[0]?.id === lastAiSpeakerId) {
    const swapIdx = 1 + Math.floor(rng() * (shuffled.length - 1))
    const tmp = shuffled[0]!
    shuffled[0] = shuffled[swapIdx]!
    shuffled[swapIdx] = tmp
  }
  return {
    kind: 'speakers',
    speakers: capSpeakers(shuffled),
    reason: 'shuffled_round',
  }
}

/**
 * 清理模型在群聊中偶尔惯性带出的 "角色名: " 或 "[角色名]: " 前缀，保持气泡文本纯净。
 */
export function stripLeadingSpeakerPrefix(text: string, speakerName?: string): string {
  if (!text || !speakerName) return text
  const aliases = extractNameAliases(speakerName)
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^\\s*(?:\\[${escaped}\\]|【${escaped}】|${escaped})\\s*[:：]\\s*`, 'i')
    if (re.test(text)) {
      return text.replace(re, '')
    }
  }
  return text
}
