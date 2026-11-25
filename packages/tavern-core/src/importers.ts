import { isZipBytes, readZipEntries } from './inflate.ts'
import {
  bytesToDataUrl,
  createMinimalPlaceholderPng,
  dataUrlToBytes,
  isPngBytes,
  readCharacterJsonFromPng,
  writeCharacterJsonToPng,
} from './pngCard.ts'
import type {
  CharacterComponent,
  ChatMessage,
  ChatSession,
  ComponentItem,
  RegexPlacement,
  RegexScript,
  RuleComponent,
  WorldComponent,
  WorldEntry,
  WorldEntryPosition,
  WorldSelectiveLogic,
} from './types.ts'

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const parseJsonSafe = (rawText: string): unknown => {
  const cleaned = rawText.replace(/^\uFEFF/, '').trim()
  return JSON.parse(cleaned) as unknown
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const asNumber = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const asBool = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 1) return true
  if (v === 'false' || v === 0) return false
  return fallback
}

const asStringArray = (v: unknown): string[] => {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  }
  if (typeof v === 'string') {
    return v
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${rand}`
}

function mapStPosition(pos: unknown): WorldEntryPosition {
  if (typeof pos === 'string') {
    if (pos === 'before_char') return 'before_char'
    if (pos === 'after_char') return 'after_char'
    if (pos === 'before_an') return 'before_an'
    if (pos === 'after_an') return 'after_an'
    if (pos === 'at_depth') return 'at_depth'
  }
  // SillyTavern World Info 数值位置映射：0=before_char, 1=after_char, 2=before_an, 3=after_an, 4=at_depth
  switch (pos) {
    case 0:
      return 'before_char'
    case 1:
      return 'after_char'
    case 2:
      return 'before_an'
    case 3:
      return 'after_an'
    case 4:
      return 'at_depth'
    default:
      return 'before_char'
  }
}

function mapWorldPositionToSt(pos: WorldEntryPosition): number {
  switch (pos) {
    case 'before_char':
      return 0
    case 'after_char':
      return 1
    case 'before_an':
      return 2
    case 'after_an':
      return 3
    case 'at_depth':
      return 4
  }
}

function mapStSelectiveLogic(val: unknown): WorldSelectiveLogic {
  switch (val) {
    case 1:
      return 'not_all'
    case 2:
      return 'not_any'
    case 3:
      return 'and_all'
    default:
      return 'and_any'
  }
}

function mapStRole(val: unknown): 'system' | 'user' | 'assistant' {
  if (val === 1 || val === 'user') return 'user'
  if (val === 2 || val === 'assistant') return 'assistant'
  return 'system'
}

function parseStRegexScripts(raw: unknown): RegexScript[] {
  if (!Array.isArray(raw)) return []
  const scripts: RegexScript[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const findRegex = asString(item.findRegex)
    if (!findRegex) continue
    const placements: RegexPlacement[] = []
    if (asBool(item.markdownOnly, false)) {
      placements.push('display_only')
    } else if (asBool(item.promptOnly, false)) {
      placements.push('prompt_only')
    } else {
      const rawPlacements = Array.isArray(item.placement) ? item.placement : []
      if (rawPlacements.includes(1)) placements.push('user_input')
      if (rawPlacements.includes(2)) placements.push('ai_output')
      if (placements.length === 0) placements.push('display_only')
    }
    scripts.push({
      id: asString(item.id, makeId('rx')),
      name: asString(item.scriptName, '未命名正则'),
      findRegex,
      replaceString: asString(item.replaceString),
      trimStrings: asStringArray(item.trimStrings),
      placements,
      disabled: asBool(item.disabled, false),
      minDepth: typeof item.minDepth === 'number' ? item.minDepth : undefined,
      maxDepth: typeof item.maxDepth === 'number' ? item.maxDepth : undefined,
    })
  }
  return scripts
}

/**
 * 解析 SillyTavern 世界书 JSON（兼容 `entries` 对象字典格式与 V2 character_book 数组格式）
 */
export function importSillyTavernWorldJson(
  rawJson: unknown,
  fallbackName = '导入的世界卡'
): WorldComponent {
  const parsed = typeof rawJson === 'string' ? parseJsonSafe(rawJson) : rawJson
  if (Array.isArray(parsed)) {
    return importSillyTavernWorldJson({ name: fallbackName, entries: parsed }, fallbackName)
  }
  if (!isRecord(parsed)) {
    throw new Error('无效的世界书 JSON 格式')
  }

  const rawEntries = parsed.entries
  let rawList: unknown[] = []
  if (Array.isArray(rawEntries)) {
    rawList = rawEntries
  } else if (isRecord(rawEntries)) {
    rawList = Object.values(rawEntries)
  } else {
    throw new Error('世界书 JSON 中缺少 entries 字段')
  }

  const entries: WorldEntry[] = []
  for (let idx = 0; idx < rawList.length; idx++) {
    const item = rawList[idx]
    if (!isRecord(item)) continue
    const ext = isRecord(item.extensions) ? item.extensions : {}
    const content = asString(item.content) || asString(item.text)
    const comment =
      asString(item.comment) ||
      asString(item.name) ||
      asString(item.displayName) ||
      `条目 ${idx + 1}`
    const keys = asStringArray(item.key ?? item.keys)
    const secondaryKeys = asStringArray(item.keysecondary ?? item.secondary_keys)
    const disabled =
      typeof item.disable !== 'undefined'
        ? asBool(item.disable, false)
        : typeof item.enabled !== 'undefined'
          ? !asBool(item.enabled, true)
          : false

    entries.push({
      id: String(item.uid ?? item.id ?? idx),
      name: comment,
      content,
      keys,
      secondaryKeys,
      selectiveLogic: mapStSelectiveLogic(item.selectiveLogic ?? ext.selectiveLogic),
      constant: asBool(item.constant ?? item.forceActivation, false),
      enabled: !disabled,
      order: asNumber(item.order ?? item.insertion_order, 100),
      position: mapStPosition(ext.position ?? item.position),
      depth: asNumber(item.depth ?? ext.depth, 4),
      role: mapStRole(item.role ?? ext.role),
      scanDepth:
        typeof item.scanDepth === 'number'
          ? item.scanDepth
          : typeof ext.scan_depth === 'number'
            ? ext.scan_depth
            : undefined,
      caseSensitive:
        typeof item.caseSensitive === 'boolean'
          ? item.caseSensitive
          : typeof ext.case_sensitive === 'boolean'
            ? ext.case_sensitive
            : undefined,
      matchWholeWords:
        typeof item.matchWholeWords === 'boolean'
          ? item.matchWholeWords
          : typeof ext.match_whole_words === 'boolean'
            ? ext.match_whole_words
            : undefined,
      probability: asNumber(item.probability ?? ext.probability, 100),
      excludeRecursion: asBool(item.excludeRecursion ?? ext.exclude_recursion, false),
      preventRecursion: asBool(item.preventRecursion ?? ext.prevent_recursion, false),
    })
  }

  const now = Date.now()
  return {
    id: makeId('world'),
    kind: 'world',
    name: asString(parsed.name).trim() || fallbackName.replace(/\.json$/i, ''),
    tags: ['世界卡'],
    payload: {
      description: asString(parsed.description),
      entries,
      scanDepth: asNumber(parsed.scan_depth, 4),
      recursive: asBool(parsed.recursive_scanning, false),
      maxRecursionSteps: 2,
      tokenBudget: asNumber(parsed.token_budget, 0),
      caseSensitive: false,
      matchWholeWords: false,
    },
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 将世界卡导出为 SillyTavern 100% 兼容的 World Info JSON 对象
 */
export function exportWorldToSillyTavernJson(world: WorldComponent): Record<string, unknown> {
  const entriesObj: Record<string, unknown> = {}
  world.payload.entries.forEach((entry, idx) => {
    entriesObj[String(idx)] = {
      uid: idx,
      key: entry.keys,
      keysecondary: entry.secondaryKeys,
      comment: entry.name,
      content: entry.content,
      constant: entry.constant,
      selective: entry.secondaryKeys.length > 0,
      selectiveLogic:
        entry.selectiveLogic === 'not_all'
          ? 1
          : entry.selectiveLogic === 'not_any'
            ? 2
            : entry.selectiveLogic === 'and_all'
              ? 3
              : 0,
      order: entry.order,
      position: mapWorldPositionToSt(entry.position),
      disable: !entry.enabled,
      displayIndex: idx,
      addMemo: true,
      depth: entry.depth,
      role: entry.role === 'user' ? 1 : entry.role === 'assistant' ? 2 : 0,
      probability: entry.probability ?? 100,
      useProbability: true,
      excludeRecursion: entry.excludeRecursion ?? false,
      preventRecursion: entry.preventRecursion ?? false,
      scanDepth: entry.scanDepth ?? null,
      caseSensitive: entry.caseSensitive ?? null,
      matchWholeWords: entry.matchWholeWords ?? null,
    }
  })

  return {
    name: world.name,
    description: world.payload.description,
    entries: entriesObj,
  }
}

export type ImportedCharacterBundle = {
  character: CharacterComponent
  /** 如果角色卡内嵌了 character_book，自动提取为一张可独立复用的世界卡组件！ */
  embeddedWorld?: WorldComponent
}

/**
 * 解析 SillyTavern V1 / V2 / V3 角色卡 JSON 对象
 */
export function importSillyTavernCharacterJson(
  rawJson: unknown,
  options?: { avatarDataUrl?: string; fallbackName?: string }
): ImportedCharacterBundle {
  const parsed = typeof rawJson === 'string' ? parseJsonSafe(rawJson) : rawJson
  if (!isRecord(parsed)) {
    throw new Error('无效的角色卡 JSON 格式')
  }

  // V2/V3 卡片核心字段在 `data` 内，部分包装格式在 `character`/`card` 内，V1 在顶层
  const rootObj = isRecord(parsed.character)
    ? parsed.character
    : isRecord(parsed.card)
      ? parsed.card
      : parsed
  const data = isRecord(rootObj.data) ? rootObj.data : rootObj
  const ext = isRecord(data.extensions) ? data.extensions : {}
  const name =
    asString(data.name).trim() ||
    asString(data.char_name).trim() ||
    asString(rootObj.name).trim() ||
    asString(rootObj.char_name).trim() ||
    (options?.fallbackName ?? '未命名角色').replace(/\.(png|json|charx|card)$/i, '')

  let depthPrompt: CharacterComponent['payload']['depthPrompt']
  if (isRecord(ext.depth_prompt) && asString(ext.depth_prompt.prompt).trim()) {
    depthPrompt = {
      prompt: asString(ext.depth_prompt.prompt),
      depth: asNumber(ext.depth_prompt.depth, 4),
      role: mapStRole(ext.depth_prompt.role),
    }
  }

  const now = Date.now()
  const character: CharacterComponent = {
    id: makeId('char'),
    kind: 'character',
    name,
    avatar: options?.avatarDataUrl,
    tags: asStringArray(data.tags ?? rootObj.tags),
    payload: {
      description:
        asString(data.description) ||
        asString(data.char_persona) ||
        asString(rootObj.description) ||
        asString(rootObj.char_persona),
      personality: asString(data.personality) || asString(rootObj.personality),
      scenario:
        asString(data.scenario) ||
        asString(data.world_scenario) ||
        asString(rootObj.scenario) ||
        asString(rootObj.world_scenario),
      firstMessage:
        asString(data.first_mes) ||
        asString(data.char_greeting) ||
        asString(rootObj.first_mes) ||
        asString(rootObj.char_greeting),
      alternateGreetings: asStringArray(data.alternate_greetings),
      exampleDialogue:
        asString(data.mes_example) ||
        asString(data.example_dialogue) ||
        asString(rootObj.mes_example) ||
        asString(rootObj.example_dialogue),
      systemPrompt: asString(data.system_prompt) || asString(rootObj.system_prompt),
      postHistoryInstructions:
        asString(data.post_history_instructions) || asString(rootObj.post_history_instructions),
      creatorNotes: asString(data.creator_notes ?? rootObj.creatorcomment ?? data.creatorcomment),
      creator: asString(data.creator ?? rootObj.creator) || undefined,
      characterVersion: asString(data.character_version ?? rootObj.character_version) || undefined,
      depthPrompt,
      regexScripts: parseStRegexScripts(ext.regex_scripts),
      rawExtensions: Object.keys(ext).length > 0 ? ext : undefined,
    },
    createdAt: now,
    updatedAt: now,
  }

  let embeddedWorld: WorldComponent | undefined
  if (isRecord(data.character_book) && data.character_book.entries) {
    try {
      embeddedWorld = importSillyTavernWorldJson(
        data.character_book,
        `${name} · 专属世界卡`
      )
      if (embeddedWorld.payload.entries.length === 0) {
        embeddedWorld = undefined
      }
    } catch {
      embeddedWorld = undefined
    }
  }

  return { character, embeddedWorld }
}

/**
 * 直接从 PNG 二进制文件导入酒馆角色卡（同时保留原图作为头像 DataURL）
 */
export function importSillyTavernCharacterPng(
  pngBytes: Uint8Array,
  filename?: string
): ImportedCharacterBundle {
  const jsonText = readCharacterJsonFromPng(pngBytes)
  const avatarDataUrl = bytesToDataUrl(pngBytes, 'image/png')
  return importSillyTavernCharacterJson(jsonText, {
    avatarDataUrl,
    fallbackName: filename,
  })
}

/**
 * 导出角色卡为标准 SillyTavern V2/V3 JSON（可选将绑定的世界卡打包进 character_book）
 */
export function exportCharacterToSillyTavernJson(
  character: CharacterComponent,
  attachedWorld?: WorldComponent
): Record<string, unknown> {
  const p = character.payload
  const extensions: Record<string, unknown> = { ...(p.rawExtensions ?? {}) }
  if (p.depthPrompt?.prompt.trim()) {
    extensions.depth_prompt = {
      prompt: p.depthPrompt.prompt,
      depth: p.depthPrompt.depth,
      role: p.depthPrompt.role,
    }
  }

  const data: Record<string, unknown> = {
    name: character.name,
    description: p.description,
    personality: p.personality,
    scenario: p.scenario,
    first_mes: p.firstMessage,
    mes_example: p.exampleDialogue,
    creator_notes: p.creatorNotes,
    system_prompt: p.systemPrompt,
    post_history_instructions: p.postHistoryInstructions,
    alternate_greetings: p.alternateGreetings,
    tags: character.tags,
    creator: p.creator ?? '',
    character_version: p.characterVersion ?? '1.0',
    extensions,
  }

  if (attachedWorld && attachedWorld.payload.entries.length > 0) {
    data.character_book = {
      name: attachedWorld.name,
      description: attachedWorld.payload.description,
      scan_depth: attachedWorld.payload.scanDepth,
      token_budget: attachedWorld.payload.tokenBudget,
      recursive_scanning: attachedWorld.payload.recursive,
      entries: attachedWorld.payload.entries.map((e, idx) => ({
        id: idx,
        keys: e.keys,
        secondary_keys: e.secondaryKeys,
        comment: e.name,
        content: e.content,
        constant: e.constant,
        selective: e.secondaryKeys.length > 0,
        insertion_order: e.order,
        enabled: e.enabled,
        position: e.position === 'after_char' ? 'after_char' : 'before_char',
        extensions: {
          position: mapWorldPositionToSt(e.position),
          depth: e.depth,
          role: e.role === 'user' ? 1 : e.role === 'assistant' ? 2 : 0,
          probability: e.probability ?? 100,
        },
      })),
    }
  }

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    // 同时保留顶层 V1 字段以便最广泛的酒馆版本兼容
    name: character.name,
    description: p.description,
    personality: p.personality,
    scenario: p.scenario,
    first_mes: p.firstMessage,
    mes_example: p.exampleDialogue,
    creatorcomment: p.creatorNotes,
    tags: character.tags,
    data,
  }
}

/**
 * 将角色卡导出为标准酒馆 PNG 字节流（内嵌 chara + ccv3 元数据，可直接拖回 SillyTavern！）
 */
export function exportCharacterToSillyTavernPng(
  character: CharacterComponent,
  attachedWorld?: WorldComponent
): Uint8Array {
  let basePng: Uint8Array
  if (character.avatar && character.avatar.startsWith('data:image/png')) {
    const candidate = dataUrlToBytes(character.avatar)
    basePng = isPngBytes(candidate) ? candidate : createMinimalPlaceholderPng()
  } else {
    basePng = createMinimalPlaceholderPng()
  }
  const cardJson = JSON.stringify(exportCharacterToSillyTavernJson(character, attachedWorld))
  return writeCharacterJsonToPng(basePng, cardJson)
}

/**
 * 导入 SillyTavern OpenAI Chat Completion Preset JSON -> 提纯为简洁的「规则/预设卡」
 */
export function importSillyTavernPresetJson(
  rawJson: unknown,
  fallbackName = '导入的酒馆预设'
): RuleComponent {
  const parsed = typeof rawJson === 'string' ? parseJsonSafe(rawJson) : rawJson
  if (!isRecord(parsed)) {
    throw new Error('无效的预设 JSON 格式')
  }

  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts.filter(isRecord) : []
  const promptMap = new Map<string, JsonRecord>()
  for (const p of prompts) {
    const id = asString(p.identifier).trim()
    if (id) promptMap.set(id, p)
  }

  const orderLists = Array.isArray(parsed.prompt_order) ? parsed.prompt_order.filter(isRecord) : []
  const activeOrderEntry =
    orderLists.find((entry) => entry.character_id === 100001) ??
    orderLists.find((entry) => Array.isArray(entry.order))
  const orderedIds = Array.isArray(activeOrderEntry?.order)
    ? activeOrderEntry.order.filter(isRecord)
    : []

  const systemParts: string[] = []
  const jailbreakParts: string[] = []

  if (orderedIds.length > 0) {
    for (const item of orderedIds) {
      if (item.enabled === false) continue
      const id = asString(item.identifier).trim()
      const p = promptMap.get(id)
      const content = asString(p?.content).trim()
      if (!content) continue
      if (id === 'jailbreak') {
        jailbreakParts.push(content)
      } else {
        systemParts.push(content)
      }
    }
  } else {
    const mainPrompt = promptMap.get('main')
    const jailbreakPrompt = promptMap.get('jailbreak')
    const nsfwPrompt = promptMap.get('nsfw')
    const textMain = asString(
      mainPrompt?.content ??
        parsed.main_prompt ??
        parsed.system_prompt ??
        parsed.story_string ??
        parsed.prompt
    ).trim()
    const textNsfw = asString(nsfwPrompt?.content ?? parsed.nsfw_prompt).trim()
    if (textMain) systemParts.push(textMain)
    if (textNsfw) systemParts.push(textNsfw)
    const jb = asString(jailbreakPrompt?.content ?? parsed.jailbreak_prompt).trim()
    if (jb) jailbreakParts.push(jb)
  }

  const now = Date.now()
  return {
    id: makeId('rule'),
    kind: 'rule',
    name: asString(parsed.name).trim() || fallbackName.replace(/\.(json|card)$/i, ''),
    tags: ['预设'],
    payload: {
      description: asString(parsed.description).trim() || '从 SillyTavern 预设导入',
      systemPrompt: systemParts.join('\n\n'),
      postHistoryInstructions: jailbreakParts.join('\n\n'),
      newChatPrompt: asString(parsed.new_chat_prompt) || undefined,
      groupNudgePrompt: asString(parsed.group_nudge_prompt) || undefined,
      temperature:
        typeof parsed.temperature === 'number'
          ? parsed.temperature
          : typeof parsed.temp === 'number'
            ? parsed.temp
            : undefined,
      topP: typeof parsed.top_p === 'number' ? parsed.top_p : undefined,
      maxTokens:
        typeof parsed.openai_max_tokens === 'number'
          ? parsed.openai_max_tokens
          : typeof parsed.max_tokens === 'number'
            ? parsed.max_tokens
            : typeof parsed.max_length === 'number'
              ? parsed.max_length
              : undefined,
      maxContextTokens:
        typeof parsed.openai_max_context === 'number'
          ? parsed.openai_max_context
          : typeof parsed.max_context === 'number'
            ? parsed.max_context
            : undefined,
    },
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 导入 SillyTavern 聊天记录 `.jsonl` -> 转为 TavernChat 线性消息链
 */
export function importSillyTavernChatJsonl(
  jsonlText: string,
  sessionId: string
): {
  title?: string
  messages: ChatMessage[]
  activeLeafId: string | null
} {
  const lines = jsonlText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const messages: ChatMessage[] = []
  let title: string | undefined
  let prevId: string | null = null

  for (const line of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(obj)) continue

    // 酒馆 jsonl 第一行通常是会话头信息（含 chat_metadata / user_name / character_name，无 mes 字段）
    if (typeof obj.mes !== 'string') {
      const charName = asString(obj.character_name).trim()
      if (charName) {
        title = `${charName}（导入记录）`
      }
      continue
    }

    const isUser = asBool(obj.is_user, false)
    const isSystem = asBool(obj.is_system, false)
    const role: ChatMessage['role'] = isSystem ? 'system' : isUser ? 'user' : 'assistant'
    const id = makeId('msg')
    const ts =
      typeof obj.send_date === 'number'
        ? obj.send_date
        : Date.parse(asString(obj.send_date)) || Date.now()

    messages.push({
      id,
      sessionId,
      parentId: prevId,
      role,
      speakerName: asString(obj.name).trim() || undefined,
      content: obj.mes,
      createdAt: ts,
      updatedAt: ts,
    })
    prevId = id
  }

  return {
    title,
    messages,
    activeLeafId: prevId,
  }
}

/**
 * 导入 SillyTavern 群聊配置文件 `groups/*.json` -> 解析成员名称与群名
 */
export function parseSillyTavernGroupJson(rawJson: unknown): {
  name: string
  memberNames: string[]
} {
  const parsed = typeof rawJson === 'string' ? (JSON.parse(rawJson) as unknown) : rawJson
  if (!isRecord(parsed)) {
    throw new Error('无效的群聊 JSON 格式')
  }
  const members = asStringArray(parsed.members).map((m) => m.replace(/\.png$/i, ''))
  return {
    name: asString(parsed.name, '导入的多角色对话'),
    memberNames: members,
  }
}

export type DetectedImportResult =
  | { kind: 'character'; bundle: ImportedCharacterBundle }
  | { kind: 'world'; world: WorldComponent }
  | { kind: 'rule'; rule: RuleComponent }
  | { kind: 'chat_jsonl'; title?: string; messages: ChatMessage[]; activeLeafId: string | null }
  | { kind: 'group'; name: string; memberNames: string[] }
  | {
      kind: 'tavern_backup'
      components: ComponentItem[]
      sessions: ChatSession[]
      messages: ChatMessage[]
    }

/**
 * 智能自动识别拖入的文件类型（酒馆 PNG 角色卡 / V2-V3 角色 JSON / 世界书 JSON / 预设 JSON / 群聊 JSON / 聊天 JSONL / TavernChat 备份包）
 */
export function smartImportFile(
  fileName: string,
  content: Uint8Array | string,
  targetSessionId = makeId('sess')
): DetectedImportResult {
  const lower = fileName.toLowerCase()

  if (content instanceof Uint8Array && (lower.endsWith('.charx') || isZipBytes(content))) {
    const entries = readZipEntries(content)
    const cardEntry =
      entries.find((e) => /(^|\/)card\.json$/i.test(e.name)) ??
      entries.find((e) => /\.json$/i.test(e.name))
    if (!cardEntry) {
      throw new Error('CHARX / ZIP 包中未找到角色卡 JSON 文件（card.json）')
    }
    const avatarEntry =
      entries.find((e) => /^assets\/icon\/.*\/main\.(png|webp|jpg|jpeg)$/i.test(e.name)) ??
      entries.find((e) => /^assets\/icon\/.*\.(png|webp|jpg|jpeg)$/i.test(e.name)) ??
      entries.find((e) => /\.(png|webp|jpg|jpeg)$/i.test(e.name))
    let avatarDataUrl: string | undefined
    if (avatarEntry) {
      const ext = avatarEntry.name.split('.').pop()?.toLowerCase()
      const mime =
        ext === 'webp'
          ? 'image/webp'
          : ext === 'jpg' || ext === 'jpeg'
            ? 'image/jpeg'
            : 'image/png'
      avatarDataUrl = bytesToDataUrl(avatarEntry.data, mime)
    }
    const jsonText = new TextDecoder('utf-8').decode(cardEntry.data)
    return {
      kind: 'character',
      bundle: importSillyTavernCharacterJson(jsonText, {
        avatarDataUrl,
        fallbackName: fileName,
      }),
    }
  }

  if (content instanceof Uint8Array) {
    if (isPngBytes(content)) {
      return {
        kind: 'character',
        bundle: importSillyTavernCharacterPng(content, fileName),
      }
    }
    if (lower.endsWith('.png')) {
      const head = new TextDecoder('utf-8').decode(content.subarray(0, 64)).trimStart()
      if (!head.startsWith('{') && !head.startsWith('[')) {
        return {
          kind: 'character',
          bundle: importSillyTavernCharacterPng(content, fileName),
        }
      }
    }
  }

  const text =
    typeof content === 'string' ? content : new TextDecoder('utf-8').decode(content)

  if (lower.endsWith('.jsonl')) {
    const res = importSillyTavernChatJsonl(text, targetSessionId)
    return { kind: 'chat_jsonl', ...res }
  }

  const parsed = parseJsonSafe(text)
  if (Array.isArray(parsed)) {
    return {
      kind: 'world',
      world: importSillyTavernWorldJson(parsed, fileName),
    }
  }
  if (!isRecord(parsed)) {
    throw new Error('暂不支持的 JSON 文件格式')
  }

  // 1. TavernChat 原生备份包
  if (parsed.format === 'tavern-chat-backup' && Array.isArray(parsed.components)) {
    return {
      kind: 'tavern_backup',
      components: parsed.components as ComponentItem[],
      sessions: Array.isArray(parsed.sessions) ? (parsed.sessions as ChatSession[]) : [],
      messages: Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : [],
    }
  }

  // 2. 酒馆 / NovelAI 世界书 JSON
  if ('entries' in parsed && (isRecord(parsed.entries) || Array.isArray(parsed.entries))) {
    return {
      kind: 'world',
      world: importSillyTavernWorldJson(parsed, fileName),
    }
  }

  // 3. 酒馆角色卡 V2/V3 或 V1/Pygmalion JSON
  if (
    parsed.spec === 'chara_card_v2' ||
    parsed.spec === 'chara_card_v3' ||
    isRecord(parsed.character) ||
    isRecord(parsed.card) ||
    (isRecord(parsed.data) && ('first_mes' in parsed.data || 'name' in parsed.data)) ||
    'first_mes' in parsed ||
    'char_persona' in parsed ||
    'char_greeting' in parsed ||
    'char_name' in parsed
  ) {
    return {
      kind: 'character',
      bundle: importSillyTavernCharacterJson(parsed, { fallbackName: fileName }),
    }
  }

  // 4. 酒馆 OpenAI / TextCompletion / Instruct 预设 JSON
  if (
    Array.isArray(parsed.prompts) ||
    'chat_completion_source' in parsed ||
    'main_prompt' in parsed ||
    'system_prompt' in parsed ||
    'story_string' in parsed ||
    'instruct' in parsed
  ) {
    return {
      kind: 'rule',
      rule: importSillyTavernPresetJson(parsed, fileName),
    }
  }

  // 5. 酒馆群聊 JSON
  if (Array.isArray(parsed.members) && typeof parsed.name === 'string') {
    return {
      kind: 'group',
      ...parseSillyTavernGroupJson(parsed),
    }
  }

  throw new Error('无法识别该 JSON 文件：请导入酒馆 PNG / CHARX 角色卡、世界书、预设、聊天记录或 TavernChat 备份')
}
