import { substituteMacros, type MacroContext } from './macros.ts'
import { applyRegexScripts } from './regex.ts'
import { estimateMessageTokens } from './token.ts'
import { buildContextMemoryBlock } from './compaction.ts'
import type {
  AssembledPrompt,
  CharacterComponent,
  ChatMessage,
  ChatSession,
  ComponentItem,
  LlmChatMessage,
  PersonaComponent,
  PromptSlotKey,
  RegexScript,
  RuleComponent,
  WorldComponent,
} from './types.ts'
import { scanWorldInfo } from './worldInfo.ts'

export type AssembleOptions = {
  session: ChatSession
  /** 已按父子分支链展开的当前对话消息列表（按时间正序） */
  history: ChatMessage[]
  /** 组件库全集或包含已挂载组件的索引表 */
  components: Map<string, ComponentItem> | ComponentItem[]
  /** 多角色模式下指定本轮发言的角色 ID（可选） */
  nextSpeakerId?: string
  /** 全局默认上下文窗口 Token 上限（默认 16384） */
  defaultMaxContextTokens?: number
  /** 全局默认最大回复 Token */
  defaultMaxResponseTokens?: number
  /** 已压缩的早期历史长期记忆（存在检查点时注入） */
  contextSummary?: string
  /** 若为继续生成（Continue）模式，追加温和引导 */
  mode?: 'normal' | 'continue' | 'impersonate'
  /** 可选固定时间/随机数（用于单元测试） */
  now?: Date
  rng?: () => number
}

const DEFAULT_PROMPT_ORDER: PromptSlotKey[] = [
  'rule_system',
  'world_before',
  'characters',
  'persona',
  'world_after',
  'examples',
  'chat_history',
  'rule_post_history',
]

function buildCharacterBlock(char: CharacterComponent, macro: MacroContext): string {
  const p = char.payload
  const parts: string[] = [`# 角色：${char.name}`]
  if (p.description.trim()) {
    parts.push(substituteMacros(p.description.trim(), macro))
  }
  if (p.personality.trim()) {
    parts.push(`性格特点：${substituteMacros(p.personality.trim(), macro)}`)
  }
  if (p.scenario.trim()) {
    parts.push(`当前场景：${substituteMacros(p.scenario.trim(), macro)}`)
  }
  return parts.join('\n')
}

function buildUserPovBlock(char: CharacterComponent): string {
  const p = char.payload
  const parts: string[] = []
  if (p.description.trim()) parts.push(p.description.trim())
  if (p.personality.trim()) parts.push(`性格特点：${p.personality.trim()}`)
  if (p.scenario.trim()) parts.push(`当前处境：${p.scenario.trim()}`)
  return parts.join('\n')
}

function parseExampleDialogue(raw: string, macro: MacroContext): LlmChatMessage[] {
  const text = substituteMacros(raw.trim(), macro)
  if (!text) return []
  const cleaned = text.replace(/<START>/gi, '\n---\n').trim()
  if (!cleaned) return []
  return [
    {
      role: 'system',
      content: `[对话示例参考]\n${cleaned}`,
      sourceLabel: '角色对话示例',
      sourceKind: 'example',
      tokens: estimateMessageTokens(cleaned),
    },
  ]
}

/**
 * 根据对话当前已选入（enabled）的组件集合，动态扫描世界书、替换宏、编排上下文，
 * 生成可直接发送给 LLM 的标准消息序列及可视化透视明细。
 */
export function assemblePrompt(options: AssembleOptions): AssembledPrompt {
  const componentMap =
    options.components instanceof Map
      ? options.components
      : new Map(options.components.map((c) => [c.id, c]))

  const activeMounts = [...options.session.mounts]
    .filter((m) => m.enabled)
    .sort((a, b) => a.order - b.order)

  const povComponent = options.session.userCharacterId
    ? componentMap.get(options.session.userCharacterId)
    : undefined
  const povCharacter =
    povComponent?.kind === 'character' ? (povComponent as CharacterComponent) : undefined

  const characters: CharacterComponent[] = []
  const worlds: Array<{ world: WorldComponent; disabledEntryIds?: Set<string> }> = []
  const personas: PersonaComponent[] = []
  const rules: RuleComponent[] = []

  for (const mount of activeMounts) {
    const item = componentMap.get(mount.componentId)
    if (!item) continue
    if (item.kind === 'character') {
      if (item.id === options.session.userCharacterId) continue
      characters.push(item as CharacterComponent)
    } else if (item.kind === 'world') {
      worlds.push({
        world: item as WorldComponent,
        disabledEntryIds:
          mount.disabledWorldEntryIds && mount.disabledWorldEntryIds.length > 0
            ? new Set(mount.disabledWorldEntryIds)
            : undefined,
      })
    } else if (item.kind === 'persona') {
      personas.push(item as PersonaComponent)
    } else if (item.kind === 'rule') {
      rules.push(item as RuleComponent)
    }
  }

  const activePersona = personas[0]
  const povBlock = povCharacter ? buildUserPovBlock(povCharacter) : ''
  const activeUserName =
    povCharacter?.name ||
    activePersona?.payload.displayName?.trim() ||
    activePersona?.name ||
    '用户'

  const targetChar =
    (options.nextSpeakerId
      ? characters.find((c) => c.id === options.nextSpeakerId)
      : undefined) ?? characters[0]
  const activeCharName = targetChar?.name || 'AI 助手'
  const groupNames = characters.map((c) => c.name)

  // 提取历史文本摘要用于宏和世界书扫描
  const lastMsg = options.history.at(-1)?.content ?? ''
  const lastUserMsg =
    [...options.history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const lastCharMsg =
    [...options.history].reverse().find((m) => m.role === 'assistant')?.content ?? ''

  const mergedScenario = characters
    .map((c) => c.payload.scenario.trim())
    .filter(Boolean)
    .join('\n')

  const macroCtx: MacroContext = {
    charName: activeCharName,
    userName: activeUserName,
    persona: povBlock || activePersona?.payload.description || '',
    scenario: mergedScenario,
    groupNames,
    lastMessage: lastMsg,
    lastUserMessage: lastUserMsg,
    lastCharMessage: lastCharMsg,
    now: options.now,
    rng: options.rng,
  }

  // 合并采样参数与上下文预算（优先最后一条显式设置的规则卡）
  let maxContextTokens = options.defaultMaxContextTokens ?? 16384
  let maxResponseTokens = options.defaultMaxResponseTokens ?? 2048
  let temperature: number | undefined
  let topP: number | undefined
  let promptOrder: PromptSlotKey[] = DEFAULT_PROMPT_ORDER
  const promptRegexScripts: RegexScript[] = []

  for (const rule of rules) {
    if (typeof rule.payload.maxContextTokens === 'number' && rule.payload.maxContextTokens > 0) {
      maxContextTokens = rule.payload.maxContextTokens
    }
    if (typeof rule.payload.maxTokens === 'number' && rule.payload.maxTokens > 0) {
      maxResponseTokens = rule.payload.maxTokens
    }
    if (typeof rule.payload.temperature === 'number') {
      temperature = rule.payload.temperature
    }
    if (typeof rule.payload.topP === 'number') {
      topP = rule.payload.topP
    }
    if (rule.payload.promptOrder && rule.payload.promptOrder.length > 0) {
      promptOrder = rule.payload.promptOrder
    }
    if (rule.payload.regexScripts) {
      promptRegexScripts.push(...rule.payload.regexScripts)
    }
  }
  for (const char of characters) {
    if (char.payload.regexScripts) {
      promptRegexScripts.push(...char.payload.regexScripts)
    }
  }

  // 扫描世界书（预算默认占上下文的 25%，最少 1024）
  const worldScan = scanWorldInfo({
    worlds,
    chatTexts: options.history.map((m) => m.content),
    extraScanText: [mergedScenario, options.session.authorsNote].filter(Boolean).join('\n'),
    defaultBudgetTokens: Math.max(1024, Math.floor(maxContextTokens * 0.25)),
    rng: options.rng,
  })

  // 准备各个槽位的内容
  const ruleSystemMsgs: LlmChatMessage[] = []
  for (const rule of rules) {
    const text = substituteMacros(rule.payload.systemPrompt.trim(), macroCtx)
    if (text) {
      ruleSystemMsgs.push({
        role: 'system',
        content: text,
        sourceLabel: `规则 · ${rule.name}`,
        sourceKind: 'rule',
        tokens: estimateMessageTokens(text),
      })
    }
  }
  // 角色自带的 systemPrompt
  for (const char of characters) {
    const text = substituteMacros(char.payload.systemPrompt.trim(), macroCtx)
    if (text) {
      ruleSystemMsgs.push({
        role: 'system',
        content: text,
        sourceLabel: `角色系统指令 · ${char.name}`,
        sourceKind: 'character',
        tokens: estimateMessageTokens(text),
      })
    }
  }

  const worldBeforeMsgs: LlmChatMessage[] = worldScan.beforeChar.map((w) => {
    const content = substituteMacros(w.entry.content.trim(), macroCtx)
    return {
      role: w.entry.role,
      content,
      sourceLabel: `世界书(前) · ${w.worldName} / ${w.entry.name}`,
      sourceKind: 'world',
      tokens: estimateMessageTokens(content),
    }
  })

  const characterMsgs: LlmChatMessage[] = characters.map((char) => {
    const content = buildCharacterBlock(char, { ...macroCtx, charName: char.name })
    return {
      role: 'system',
      content,
      sourceLabel: `角色 · ${char.name}`,
      sourceKind: 'character',
      tokens: estimateMessageTokens(content),
    }
  })

  // 多角色协同指令
  if (characters.length > 1) {
    const modePrompt =
      options.session.multiCharMode === 'narrator'
        ? `当前场景共有多位在场角色：${groupNames.join('、')}。请自然推进剧情，根据情境安排合适的角色互动与台词，保持各自人设鲜明。`
        : `当前场景在场角色：${groupNames.join('、')}。本轮请仅以「${activeCharName}」的视角与口吻作出回应，不要替其他角色或${activeUserName}代为发言。`
    characterMsgs.push({
      role: 'system',
      content: modePrompt,
      sourceLabel: '多角色场景指引',
      sourceKind: 'character',
      tokens: estimateMessageTokens(modePrompt),
    })
  }

  const personaMsgs: LlmChatMessage[] = []
  if (povCharacter || activePersona) {
    const rawDescription = povCharacter
      ? povBlock
      : activePersona?.payload.description.trim() ?? ''
    const desc = substituteMacros(rawDescription, macroCtx)
    const content = desc
      ? `用户身份（${activeUserName}）：\n${desc}`
      : `用户称呼：${activeUserName}`
    personaMsgs.push({
      role: 'system',
      content,
      sourceLabel: povCharacter ? `用户视角 · ${povCharacter.name}` : `人设 · ${activePersona!.name}`,
      sourceKind: 'persona',
      tokens: estimateMessageTokens(content),
    })
  }

  const memoryMsgs: LlmChatMessage[] = []
  if (options.contextSummary?.trim()) {
    const memory = buildContextMemoryBlock(options.contextSummary)
    if (memory) {
      memoryMsgs.push({
        role: 'system',
        content: memory,
        sourceLabel: '上下文记忆',
        sourceKind: 'memory',
        tokens: estimateMessageTokens(memory),
      })
    }
  }

  const worldAfterMsgs: LlmChatMessage[] = worldScan.afterChar.map((w) => {
    const content = substituteMacros(w.entry.content.trim(), macroCtx)
    return {
      role: w.entry.role,
      content,
      sourceLabel: `世界书(后) · ${w.worldName} / ${w.entry.name}`,
      sourceKind: 'world',
      tokens: estimateMessageTokens(content),
    }
  })

  const exampleMsgs: LlmChatMessage[] = []
  for (const char of characters) {
    if (char.payload.exampleDialogue.trim()) {
      exampleMsgs.push(
        ...parseExampleDialogue(char.payload.exampleDialogue, { ...macroCtx, charName: char.name })
      )
    }
  }

  const postHistoryMsgs: LlmChatMessage[] = []
  for (const rule of rules) {
    const text = substituteMacros(rule.payload.postHistoryInstructions.trim(), macroCtx)
    if (text) {
      postHistoryMsgs.push({
        role: 'system',
        content: text,
        sourceLabel: `尾部指令 · ${rule.name}`,
        sourceKind: 'rule',
        tokens: estimateMessageTokens(text),
      })
    }
  }
  for (const char of characters) {
    const text = substituteMacros(char.payload.postHistoryInstructions.trim(), macroCtx)
    if (text) {
      postHistoryMsgs.push({
        role: 'system',
        content: text,
        sourceLabel: `角色尾部指令 · ${char.name}`,
        sourceKind: 'character',
        tokens: estimateMessageTokens(text),
      })
    }
  }
  if (options.mode === 'continue') {
    const nudge = '请紧接你上一条未完成的回复继续往下写，不要重复已输出的内容。'
    postHistoryMsgs.push({
      role: 'system',
      content: nudge,
      sourceLabel: '继续生成指引',
      sourceKind: 'rule',
      tokens: estimateMessageTokens(nudge),
    })
  } else if (options.mode === 'impersonate') {
    const imp = `请以「${activeUserName}」的口吻与视角写下一条回复，贴合之前的对话风格，不要替角色发言。`
    postHistoryMsgs.push({
      role: 'system',
      content: imp,
      sourceLabel: '扮演用户指引',
      sourceKind: 'rule',
      tokens: estimateMessageTokens(imp),
    })
  }

  // 准备深度注入消息（Author's Note + 世界书 at_depth/before_an/after_an + 角色 depthPrompt）
  type DepthInjection = {
    depth: number
    msg: LlmChatMessage
  }
  const depthInjections: DepthInjection[] = []

  const anDepth = Math.max(0, options.session.authorsNoteDepth ?? 4)
  for (const w of worldScan.beforeAn) {
    const content = substituteMacros(w.entry.content.trim(), macroCtx)
    depthInjections.push({
      depth: anDepth,
      msg: {
        role: w.entry.role,
        content,
        sourceLabel: `世界书(便签前) · ${w.worldName} / ${w.entry.name}`,
        sourceKind: 'world',
        tokens: estimateMessageTokens(content),
      },
    })
  }
  if (options.session.authorsNote.trim()) {
    const noteText = substituteMacros(options.session.authorsNote.trim(), macroCtx)
    depthInjections.push({
      depth: anDepth,
      msg: {
        role: 'system',
        content: `[剧情便签]\n${noteText}`,
        sourceLabel: `本对话剧情便签 (深度 ${anDepth})`,
        sourceKind: 'note',
        tokens: estimateMessageTokens(noteText),
      },
    })
  }
  for (const w of worldScan.afterAn) {
    const content = substituteMacros(w.entry.content.trim(), macroCtx)
    depthInjections.push({
      depth: anDepth,
      msg: {
        role: w.entry.role,
        content,
        sourceLabel: `世界书(便签后) · ${w.worldName} / ${w.entry.name}`,
        sourceKind: 'world',
        tokens: estimateMessageTokens(content),
      },
    })
  }
  for (const w of worldScan.atDepth) {
    const content = substituteMacros(w.entry.content.trim(), macroCtx)
    depthInjections.push({
      depth: Math.max(0, w.entry.depth ?? 4),
      msg: {
        role: w.entry.role,
        content,
        sourceLabel: `世界书(深度 ${w.entry.depth}) · ${w.worldName} / ${w.entry.name}`,
        sourceKind: 'world',
        tokens: estimateMessageTokens(content),
      },
    })
  }
  for (const char of characters) {
    if (char.payload.depthPrompt?.prompt.trim()) {
      const content = substituteMacros(char.payload.depthPrompt.prompt.trim(), {
        ...macroCtx,
        charName: char.name,
      })
      depthInjections.push({
        depth: Math.max(0, char.payload.depthPrompt.depth),
        msg: {
          role: char.payload.depthPrompt.role,
          content,
          sourceLabel: `角色深度提示 · ${char.name}`,
          sourceKind: 'character',
          tokens: estimateMessageTokens(content),
        },
      })
    }
  }

  // 计算固定头部/尾部/注入 Token 占用，为历史消息留足预算
  const fixedBlocksMap: Record<Exclude<PromptSlotKey, 'chat_history'>, LlmChatMessage[]> = {
    rule_system: ruleSystemMsgs,
    world_before: worldBeforeMsgs,
    characters: characterMsgs,
    persona: personaMsgs,
    world_after: worldAfterMsgs,
    examples: exampleMsgs,
    rule_post_history: postHistoryMsgs,
  }

  let fixedTokens = 0
  for (const slot of promptOrder) {
    if (slot === 'chat_history') continue
    for (const m of fixedBlocksMap[slot]) {
      fixedTokens += m.tokens ?? estimateMessageTokens(m.content)
    }
  }
  for (const inj of depthInjections) {
    fixedTokens += inj.msg.tokens ?? estimateMessageTokens(inj.msg.content)
  }
  for (const memory of memoryMsgs) {
    fixedTokens += memory.tokens ?? estimateMessageTokens(memory.content)
  }

  const availableForHistory = Math.max(
    512,
    maxContextTokens - maxResponseTokens - fixedTokens
  )

  // 转换历史消息（多角色下保留发言者前缀以便模型区分身份）
  const isMultiChar = characters.length > 1
  const formattedHistory: LlmChatMessage[] = options.history.map((m, idx) => {
    const depthFromEnd = options.history.length - 1 - idx
    let content = substituteMacros(m.content, macroCtx)
    if (promptRegexScripts.length > 0) {
      content = applyRegexScripts(content, promptRegexScripts, 'prompt_only', depthFromEnd)
    }
    if (isMultiChar && m.role === 'assistant' && m.speakerName) {
      const prefix = `${m.speakerName}: `
      if (!content.startsWith(prefix) && !content.startsWith(`${m.speakerName}：`)) {
        content = `${prefix}${content}`
      }
    }
    return {
      role: m.role,
      content,
      sourceLabel: m.role === 'user' ? activeUserName : m.speakerName || activeCharName,
      sourceKind: 'history',
      tokens: estimateMessageTokens(content),
    }
  })

  // 从最新消息往前贪心保留历史消息
  const keptHistory: LlmChatMessage[] = []
  let historyTokens = 0
  let droppedHistoryCount = 0
  for (let i = formattedHistory.length - 1; i >= 0; i--) {
    const item = formattedHistory[i]!
    const cost = item.tokens ?? estimateMessageTokens(item.content)
    if (keptHistory.length > 0 && historyTokens + cost > availableForHistory) {
      droppedHistoryCount = i + 1
      break
    }
    keptHistory.unshift(item)
    historyTokens += cost
  }

  // 把深度注入按 depth 插入历史消息对应位置（depth=0 插入最末尾，depth=N 插入倒数第 N 条之前）
  const historyWithInjections = [...keptHistory]
  // 按 depth 降序插入，避免偏移相互影响
  const sortedInjections = [...depthInjections].sort((a, b) => b.depth - a.depth)
  for (const inj of sortedInjections) {
    const insertIdx = Math.max(0, historyWithInjections.length - inj.depth)
    historyWithInjections.splice(insertIdx, 0, inj.msg)
  }

  // 按 promptOrder 拼装最终消息序列；上下文记忆固定在历史之前，不改动前面的静态前缀。
  const finalMessages: LlmChatMessage[] = []
  let memoryInserted = false
  for (const slot of promptOrder) {
    if (slot === 'chat_history') {
      finalMessages.push(...memoryMsgs, ...historyWithInjections)
      memoryInserted = true
    } else {
      finalMessages.push(...fixedBlocksMap[slot])
    }
  }
  if (!memoryInserted && memoryMsgs.length > 0) {
    finalMessages.push(...memoryMsgs)
  }

  const totalTokens = finalMessages.reduce(
    (sum, m) => sum + (m.tokens ?? estimateMessageTokens(m.content)),
    0
  )

  return {
    messages: finalMessages,
    totalTokens,
    maxContextTokens,
    triggeredWorld: worldScan.snapshots,
    droppedHistoryCount,
    activeCharacterNames: groupNames,
    activeUserName,
    sampling: {
      temperature,
      topP,
      maxTokens: maxResponseTokens,
    },
  }
}
