import { estimateMessageTokens } from './token.ts'
import type { ChatMessage, ContextCheckpoint } from './types.ts'

export type ContextCompressionMode = 'off' | 'balanced' | 'extended'

export type CompactionBudget = {
  triggerTokens: number
  keepRecentTokens: number
  chunkInputTokens: number
  summaryMaxTokens: number
  hardInputLimit: number
}

export type ActiveCheckpointMatch = {
  checkpoint: ContextCheckpoint
  anchorIndex: number
}

export type CompactionPlan = {
  previousCheckpoint: ContextCheckpoint | null
  targetAnchorMessageId: string
  coveredRounds: number
  messagesToCompactCount: number
  chunks: string[]
  estimatedBeforeTokens: number
}

/**
 * 双水位预算：未到高水位完全不动前缀；触发后压回低水位的近期原文 + 结构化记忆。
 * 默认窗口 32K 时，均衡档约 24K 触发、保留最近约 6K；长记忆档约 29K 触发、保留约 10K。
 */
export function resolveCompactionBudget(
  maxContextTokens: number,
  mode: ContextCompressionMode
): CompactionBudget {
  const window = Math.max(4096, Math.floor(maxContextTokens))
  const hardInputLimit = Math.max(2048, window - Math.min(8192, Math.floor(window * 0.15)))
  const triggerRatio = mode === 'extended' ? 0.9 : 0.75
  const triggerTokens = Math.max(2048, Math.floor(window * triggerRatio))
  const keepRatio = mode === 'extended' ? 0.35 : 0.25
  const keepRecentTokens = Math.max(
    1024,
    Math.min(Math.floor(triggerTokens * keepRatio), Math.floor(triggerTokens * 0.45))
  )
  const chunkInputTokens = Math.max(2048, Math.floor(hardInputLimit * 0.45))
  const summaryMaxTokens = Math.max(512, Math.min(4096, Math.floor(window * 0.12)))
  return { triggerTokens, keepRecentTokens, chunkInputTokens, summaryMaxTokens, hardInputLimit }
}

/** 只在当前可见分支路径上寻找最靠后的检查点，切换旧分支时绝不串味。 */
export function findActiveCheckpoint(
  history: readonly ChatMessage[],
  checkpoints?: readonly ContextCheckpoint[]
): ActiveCheckpointMatch | null {
  if (!checkpoints || checkpoints.length === 0 || history.length === 0) return null
  const indexById = new Map<string, number>()
  for (let i = 0; i < history.length; i += 1) {
    const item = history[i]
    if (item) indexById.set(item.id, i)
  }
  let best: ActiveCheckpointMatch | null = null
  for (const checkpoint of checkpoints) {
    const anchorIndex = indexById.get(checkpoint.upToMessageId)
    if (anchorIndex === undefined) continue
    if (
      !best ||
      anchorIndex > best.anchorIndex ||
      (anchorIndex === best.anchorIndex && checkpoint.createdAt > best.checkpoint.createdAt)
    ) {
      best = { checkpoint, anchorIndex }
    }
  }
  return best
}

const estimateMessage = (message: ChatMessage): number =>
  estimateMessageTokens(message.content) +
  (message.speakerName ? estimateMessageTokens(message.speakerName) : 0) +
  8

/** 按“用户消息开启新一轮”分组，避免把提问和回答从中间切开。 */
export function groupRounds(history: readonly ChatMessage[]): ChatMessage[][] {
  const rounds: ChatMessage[][] = []
  let current: ChatMessage[] = []
  for (const message of history) {
    if (message.role === 'user' && current.length > 0) {
      rounds.push(current)
      current = []
    }
    current.push(message)
  }
  if (current.length > 0) rounds.push(current)
  return rounds
}

const formatMessageForCompaction = (message: ChatMessage): string => {
  const label =
    message.role === 'user'
      ? '用户'
      : message.role === 'assistant'
        ? message.speakerName || '助手'
        : message.speakerName || '系统'
  return `【${label}】\n${message.content.trim()}`
}

const splitOversizedPiece = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) return [text]
  const parts: string[] = []
  for (let offset = 0; offset < text.length; offset += maxChars) {
    parts.push(`[超长消息分段]\n${text.slice(offset, offset + maxChars)}`)
  }
  return parts
}

/** 把待压缩消息切成不超过压缩请求预算的小块，保证压缩调用本身不爆窗。 */
export function chunkMessagesForCompaction(
  messages: readonly ChatMessage[],
  chunkInputTokens: number
): string[] {
  const safeTokens = Math.max(1024, Math.floor(chunkInputTokens))
  const maxChars = Math.max(2000, Math.floor((safeTokens * 0.85) / 0.68))
  const pieces: Array<{ text: string; tokens: number }> = []

  for (const message of messages) {
    const text = formatMessageForCompaction(message)
    const tokens = estimateMessageTokens(text) + 8
    if (tokens <= safeTokens) {
      pieces.push({ text, tokens })
      continue
    }
    for (const part of splitOversizedPiece(text, maxChars)) {
      pieces.push({ text: part, tokens: estimateMessageTokens(part) + 8 })
    }
  }

  const chunks: string[] = []
  let current: string[] = []
  let used = 0
  for (const piece of pieces) {
    if (current.length > 0 && used + piece.tokens > safeTokens) {
      chunks.push(current.join('\n\n---\n\n'))
      current = []
      used = 0
    }
    current.push(piece.text)
    used += piece.tokens
  }
  if (current.length > 0) chunks.push(current.join('\n\n---\n\n'))
  return chunks
}

/**
 * 规划一次压缩：只折叠较早的完整轮次，最近一轮（当前提问及其上下文）永远保留。
 * 未到触发水位且不强制时返回 null，此时原始前缀完全不变。
 */
export function planCompaction({
  history,
  activeCheckpoint,
  budget,
  estimatedTokens,
  force = false,
}: {
  history: readonly ChatMessage[]
  activeCheckpoint: ContextCheckpoint | null
  budget: CompactionBudget
  estimatedTokens: number
  force?: boolean
}): CompactionPlan | null {
  if (!force && estimatedTokens < budget.triggerTokens) return null

  const match = findActiveCheckpoint(history, activeCheckpoint ? [activeCheckpoint] : [])
  const startIndex = match ? match.anchorIndex + 1 : 0
  const uncovered = history.slice(startIndex)
  const rounds = groupRounds(uncovered)
  if (rounds.length <= 1) return null

  // 最近一轮必须完整保留，否则当前提问会被压进摘要里。
  let keepFrom = rounds.length - 1
  let keptTokens = rounds[keepFrom]!.reduce((sum, m) => sum + estimateMessage(m), 0)
  for (let i = rounds.length - 2; i >= 0; i -= 1) {
    const cost = rounds[i]!.reduce((sum, m) => sum + estimateMessage(m), 0)
    if (keptTokens + cost > budget.keepRecentTokens) break
    keptTokens += cost
    keepFrom = i
  }

  // 至少折叠 2 轮，避免为了几 token 反复调用模型。
  if (keepFrom < 2) keepFrom = Math.min(2, rounds.length - 1)
  if (keepFrom <= 0) return null

  const compactedRounds = rounds.slice(0, keepFrom)
  const messagesToCompact = compactedRounds.flat()
  const anchor = messagesToCompact.at(-1)
  if (!anchor) return null

  const chunks = chunkMessagesForCompaction(messagesToCompact, budget.chunkInputTokens)
  if (chunks.length === 0) return null

  return {
    previousCheckpoint: activeCheckpoint,
    targetAnchorMessageId: anchor.id,
    coveredRounds: (activeCheckpoint?.coveredRounds ?? 0) + compactedRounds.length,
    messagesToCompactCount: messagesToCompact.length,
    chunks,
    estimatedBeforeTokens: estimatedTokens,
  }
}

export const COMPACTION_SYSTEM_PROMPT = `你是一位严谨的长篇角色扮演与小说对话的上下文压缩专家。
你的任务是把较早的对话历史整理成高密度、零遗漏的结构化长期记忆，让后续模型在看不到原文时，仍能像完整读过全部历史一样自然续写。

严格准则：
1. 忠实原文，不编造未出现的事实、设定、关系或剧情。
2. 遵循对话的主要语言；人名、地名、专有名词、数值与代码标识符保留原文。
3. 用户明确提出的身份、称呼、视角、文风、格式要求，以及“不要/禁止/改成”类纠偏，优先级最高。
4. 保留精确细节：角色关系、承诺、伏笔、时间线、地点、关键道具、未解决线索。
5. 若提供了 <previous_summary>，做增量保真合并：保留仍有效的旧记忆，更新已被新对话覆盖的内容，并融入新片段。
6. 输出必须包含两段：
   - 先输出 <analysis>...</analysis>：逐轮核对关键信息，确保没有遗漏（此段之后会被剥离）；
   - 再输出 <summary>...</summary>：最终的结构化长期记忆。`

export function buildCompactionUserPrompt({
  previousSummary,
  chunkText,
  chunkIndex,
  totalChunks,
}: {
  previousSummary?: string
  chunkText: string
  chunkIndex: number
  totalChunks: number
}): string {
  const parts: string[] = []
  if (totalChunks > 1) {
    parts.push(`当前正在分段滚动压缩：第 ${chunkIndex + 1} / ${totalChunks} 段。`)
  }
  if (previousSummary?.trim()) {
    parts.push(`<previous_summary>\n${previousSummary.trim()}\n</previous_summary>`)
  }
  parts.push(`<conversation_segment>\n${chunkText}\n</conversation_segment>`)
  parts.push(`请先在 <analysis> 中逐轮梳理，再在 <summary> 中按以下小节输出结构化记忆（没有内容的小节写“无”）：

## 1. 我的视角与用户硬性设定
（玩家身份/出发视角、称呼、性格、文风与格式要求、明确禁止或强调过的规则）

## 2. 在场角色与人物关系
（角色名、身份、关系、称呼、当前态度与彼此之间的张力）

## 3. 世界观、地点与规则
（世界设定、关键地点、势力、能力/规则、不能违背的硬设定）

## 4. 已发生剧情、关键事实与精确细节
（按时间线记录重要事件、决定、数值、道具、伤势、承诺与已确认的结论）

## 5. 伏笔、未解决线索与待推进事项
（尚未揭晓的谜团、未兑现的承诺、当前目标与下一步可能的发展）

## 6. 文风、语气与用户纠偏
（叙事视角、语言风格、篇幅偏好，以及用户曾否定或要求修改的方向）

## 7. 当前场景与衔接点
（压缩断点前正在发生的场景、人物位置、情绪与最后一句有效对话）`)
  return parts.join('\n\n')
}

/** 剥离分析草稿，提取最终摘要；弱模型未按标签输出时优雅兜底。 */
export function extractCompactionSummary(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (!trimmed) return ''
  const closed = /<summary>([\s\S]*?)<\/summary>/i.exec(trimmed)
  if (closed?.[1]?.trim()) return closed[1].trim()
  const openIndex = trimmed.search(/<summary>/i)
  if (openIndex >= 0) {
    const after = trimmed
      .slice(openIndex + '<summary>'.length)
      .replace(/<\/summary>\s*$/i, '')
      .trim()
    if (after) return after
  }
  return trimmed.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim()
}

/** 把摘要包装成独立系统消息内容；只在存在检查点时注入。 */
export function buildContextMemoryBlock(summary: string): string {
  const clean = summary.trim()
  if (!clean) return ''
  return `<conversation_memory>
以下是本对话早期历史的结构化长期记忆（由系统自动压缩以保留关键上下文）。请在回复时自然延续其中的设定、关系、事实与进展，如同完整记得全部历史；若与后续最新消息冲突，以最新消息为准。

${clean}
</conversation_memory>`
}
