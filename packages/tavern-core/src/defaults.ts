import type {
  CharacterComponent,
  PersonaComponent,
  RuleComponent,
  WorldComponent,
  WorldEntry,
} from './types.ts'

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 首次启动时的极简内置基础规则（不包含任何演示角色或演示世界观，保持交付干净纯粹）
 */
export function createBuiltinRulePresets(): RuleComponent[] {
  const now = Date.now()
  return [
    {
      id: 'rule_builtin_rp',
      kind: 'rule',
      name: '自然叙事与扮演',
      tags: ['内置', '扮演'],
      payload: {
        description: '简洁通用的角色扮演指令，贴合角色设定自然互动，不替用户代笔。',
        systemPrompt:
          '请完全沉浸在已选入的角色设定与世界观中，以自然、生动的中文（或对话所用语言）回应 {{user}}。紧扣角色性格与当下情境推进对话，不要跳出设定说教，不要替 {{user}} 决定行动或台词。',
        postHistoryInstructions: '',
        temperature: 0.9,
      },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rule_builtin_writing',
      kind: 'rule',
      name: '小说与故事共创',
      tags: ['内置', '创作'],
      payload: {
        description: '结合已挂载的角色与世界卡，协助构思剧情、描写场景或续写章节。',
        systemPrompt:
          '你是一位专业的小说创作搭档。请严格遵守当前对话已选入的角色设定与世界观条目，保持人物言行一致、细节连贯、文笔凝练有画面感。',
        postHistoryInstructions: '',
        temperature: 0.85,
      },
      createdAt: now,
      updatedAt: now,
    },
  ]
}

export function createEmptyCharacter(name = '新角色'): CharacterComponent {
  const now = Date.now()
  return {
    id: uid('char'),
    kind: 'character',
    name,
    tags: [],
    payload: {
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      alternateGreetings: [],
      exampleDialogue: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function createEmptyWorldEntry(index = 0): WorldEntry {
  return {
    id: uid('we'),
    name: `设定条目 ${index + 1}`,
    content: '',
    keys: [],
    secondaryKeys: [],
    selectiveLogic: 'and_any',
    constant: false,
    enabled: true,
    order: 100,
    position: 'before_char',
    depth: 4,
    role: 'system',
    probability: 100,
  }
}

export function createEmptyWorld(name = '新世界卡'): WorldComponent {
  const now = Date.now()
  return {
    id: uid('world'),
    kind: 'world',
    name,
    tags: [],
    payload: {
      description: '',
      entries: [createEmptyWorldEntry(0)],
      scanDepth: 4,
      recursive: false,
      maxRecursionSteps: 2,
      tokenBudget: 0,
      caseSensitive: false,
      matchWholeWords: false,
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function createEmptyPersona(name = '我的人设'): PersonaComponent {
  const now = Date.now()
  return {
    id: uid('persona'),
    kind: 'persona',
    name,
    tags: [],
    payload: {
      displayName: '我',
      description: '',
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function createEmptyRule(name = '新规则卡'): RuleComponent {
  const now = Date.now()
  return {
    id: uid('rule'),
    kind: 'rule',
    name,
    tags: [],
    payload: {
      description: '',
      systemPrompt: '',
      postHistoryInstructions: '',
    },
    createdAt: now,
    updatedAt: now,
  }
}
