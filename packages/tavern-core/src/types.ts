/**
 * TavernChat 核心数据模型
 *
 * 设计哲学：万物皆「组件（Component）」，任意对话均可自由选入 / 选出任意组件。
 * 同时为未来的 PC 满血版（PC Pro）预留 StorageAdapter 与 EnginePlugin 扩展接口。
 */

export type ComponentKind = 'character' | 'world' | 'persona' | 'rule'

export type RegexPlacement = 'user_input' | 'ai_output' | 'prompt_only' | 'display_only'

export type RegexScript = {
  id: string
  name: string
  findRegex: string
  replaceString: string
  trimStrings?: string[]
  placements: RegexPlacement[]
  disabled: boolean
  minDepth?: number
  maxDepth?: number
}

export type CharacterPayload = {
  description: string
  personality: string
  scenario: string
  firstMessage: string
  alternateGreetings: string[]
  exampleDialogue: string
  systemPrompt: string
  postHistoryInstructions: string
  creatorNotes: string
  creator?: string
  characterVersion?: string
  /** 可选深度提示词（对应酒馆 character depth_prompt） */
  depthPrompt?: {
    prompt: string
    depth: number
    role: 'system' | 'user' | 'assistant'
  }
  /** 角色自带正则脚本 */
  regexScripts?: RegexScript[]
  /** 导出 PNG 时保留的扩展字段，避免丢信息 */
  rawExtensions?: Record<string, unknown>
}

export type WorldEntryPosition =
  | 'before_char'
  | 'after_char'
  | 'before_an'
  | 'after_an'
  | 'at_depth'

export type WorldSelectiveLogic = 'and_any' | 'not_all' | 'not_any' | 'and_all'

export type WorldEntry = {
  id: string
  name: string
  content: string
  /** 主关键词（任意命中即触发） */
  keys: string[]
  /** 次级关键词（配合 selectiveLogic 使用） */
  secondaryKeys: string[]
  selectiveLogic: WorldSelectiveLogic
  /** 蓝灯：常驻生效，不依赖关键词 */
  constant: boolean
  enabled: boolean
  /** 优先级权重，越高越优先纳入预算并靠后/按序排列 */
  order: number
  position: WorldEntryPosition
  /** position === 'at_depth' 时的聊天倒数深度 */
  depth: number
  role: 'system' | 'user' | 'assistant'
  /** 可选单条目扫描深度覆盖 */
  scanDepth?: number
  caseSensitive?: boolean
  matchWholeWords?: boolean
  /** 概率触发（0-100，默认 100） */
  probability?: number
  /** 防止被递归触发 / 防止本条目触发其他条目 */
  excludeRecursion?: boolean
  preventRecursion?: boolean
}

export type WorldPayload = {
  description: string
  entries: WorldEntry[]
  /** 默认扫描最近几条消息 */
  scanDepth: number
  /** 是否开启递归扫描（世界书条目内容再去触发其他世界书条目） */
  recursive: boolean
  /** 最大递归轮数 */
  maxRecursionSteps: number
  /** 世界书占用的最大 Token 预算（0 表示使用全局默认或按上下文比例） */
  tokenBudget: number
  caseSensitive: boolean
  matchWholeWords: boolean
}

export type PersonaPayload = {
  /** 用户在故事中的称呼（覆盖默认“我/User”） */
  displayName: string
  description: string
}

export type PromptSlotKey =
  | 'rule_system'
  | 'world_before'
  | 'characters'
  | 'persona'
  | 'world_after'
  | 'examples'
  | 'chat_history'
  | 'rule_post_history'

export type RulePayload = {
  description: string
  systemPrompt: string
  postHistoryInstructions: string
  /** 对话开始时的轻量引导（可选） */
  newChatPrompt?: string
  /** 多角色推进提示（支持 {{char}} / {{group}}） */
  groupNudgePrompt?: string
  /** 默认采样参数（可选覆盖全局） */
  temperature?: number
  topP?: number
  maxTokens?: number
  maxContextTokens?: number
  /** 自定义 Prompt 区块顺序（默认提供标准顺序） */
  promptOrder?: PromptSlotKey[]
  /** 规则附带的轻量正则脚本 */
  regexScripts?: RegexScript[]
}

export type ComponentPayloadMap = {
  character: CharacterPayload
  world: WorldPayload
  persona: PersonaPayload
  rule: RulePayload
}

/** 市场卡片导入后保留的作者与来源，便于署名和追溯。 */
export type ComponentOrigin = {
  providerId: string
  providerName: string
  listingId: string
  listingName: string
  sourceUrl?: string
  creator: string
  license?: string
  licenseUrl?: string
  version?: string
  importedAt: number
  componentKind: ComponentKind
}

export type ComponentItem<K extends ComponentKind = ComponentKind> = {
  id: string
  kind: K
  name: string
  /** 头像 DataURL 或图标标识（PNG 角色卡导入时会自动保存原图以便无损再导出） */
  avatar?: string
  /** 市场导入的来源与署名 */
  origin?: ComponentOrigin
  tags: string[]
  payload: ComponentPayloadMap[K]
  createdAt: number
  updatedAt: number
}

export type CharacterComponent = ComponentItem<'character'>
export type WorldComponent = ComponentItem<'world'>
export type PersonaComponent = ComponentItem<'persona'>
export type RuleComponent = ComponentItem<'rule'>

/**
 * 对话中挂载的单个组件引用：
 * 支持一键开关（选入/选出）、排序以及本对话局部覆盖（不污染组件库母版）。
 */
export type MountedComponent = {
  componentId: string
  kind: ComponentKind
  enabled: boolean
  order: number
  /** 仅针对世界卡：本对话临时禁用的条目 ID 列表 */
  disabledWorldEntryIds?: string[]
  /** 仅针对角色卡：当前选用的开场白索引（0 为主开场白，>=1 为 alternateGreetings） */
  greetingIndex?: number
}

export type MultiCharMode = 'narrator' | 'round_robin' | 'manual'

export type TriggeredWorldSnapshot = {
  worldId: string
  worldName: string
  entryId: string
  entryName: string
  reason: 'constant' | 'keyword' | 'recursion'
  matchedKeys: string[]
  tokens: number
}

export type ChatMessage = {
  id: string
  sessionId: string
  /** 分支 / Swipe 父节点 ID；根消息（如开场白或首条用户消息）为 null */
  parentId: string | null
  role: 'user' | 'assistant' | 'system'
  /** 发言角色组件 ID（多角色或单角色回复时记录） */
  speakerId?: string
  speakerName?: string
  speakerAvatar?: string
  content: string
  reasoning?: string
  /** 本条回复生成时命中的世界书条目快照，用于上下文透视 */
  triggeredWorld?: TriggeredWorldSnapshot[]
  /** 是否为系统注入的开场白 */
  isGreeting?: boolean
  createdAt: number
  updatedAt: number
}

export type ChatSession = {
  id: string
  title: string
  /** 本对话已选入的组件清单（角色 / 世界卡 / 人设 / 规则） */
  mounts: MountedComponent[]
  /** 本对话专属剧情便签（Author's Note） */
  authorsNote: string
  /** 剧情便签注入深度（倒数第几条消息之前，默认 4） */
  authorsNoteDepth: number
  /** 多角色对话模式 */
  multiCharMode: MultiCharMode
  /** 当前指向的活跃叶节点消息 ID，用于分支 / Swipe 切换 */
  activeLeafId: string | null
  /** 会话级模型覆盖（空则跟随全局设置） */
  modelOverride?: {
    providerId: string
    model: string
  }
  createdAt: number
  updatedAt: number
}

/** 最终发给 LLM 的标准消息格式 */
export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 用于 UI 上下文透视弹窗标注来源区块 */
  sourceLabel?: string
  sourceKind?: 'rule' | 'character' | 'world' | 'persona' | 'note' | 'history' | 'example'
  tokens?: number
}

export type AssembledPrompt = {
  messages: LlmChatMessage[]
  totalTokens: number
  maxContextTokens: number
  triggeredWorld: TriggeredWorldSnapshot[]
  droppedHistoryCount: number
  activeCharacterNames: string[]
  activeUserName: string
  sampling: {
    temperature?: number
    topP?: number
    maxTokens?: number
  }
}

/**
 * 存储适配器抽象接口（为未来 PC 满血版的“本机明文目录直读直写”预留）。
 * 轻量双端默认使用 IndexedDBStorageAdapter，PC 满血版可无缝替换为 FileSystemStorageAdapter。
 */
export interface StorageAdapter {
  readonly mode: 'indexeddb' | 'filesystem'
  listComponents(): Promise<ComponentItem[]>
  upsertComponent(item: ComponentItem): Promise<void>
  deleteComponent(id: string): Promise<void>
  listSessions(): Promise<ChatSession[]>
  upsertSession(session: ChatSession): Promise<void>
  deleteSession(id: string): Promise<void>
  listMessages(sessionId: string): Promise<ChatMessage[]>
  upsertMessage(message: ChatMessage): Promise<void>
  deleteMessages(sessionId: string, messageIds: string[]): Promise<void>
}

/**
 * 引擎扩展插件抽象接口（为未来 PC 满血版的 RAG 向量记忆、变量持久化等预留）。
 */
export interface EnginePlugin {
  readonly id: string
  readonly name: string
  beforeAssemble?(prompt: AssembledPrompt): Promise<AssembledPrompt> | AssembledPrompt
  afterResponse?(content: string): Promise<string> | string
}
