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

export const BUILTIN_SELF_CHARACTER_ID = 'char_builtin_self'
export const BUILTIN_ZIWU_CHARACTER_ID = 'char_builtin_ziwu'
export const BUILTIN_JINGYU_CHARACTER_ID = 'char_builtin_jingyu'

/** 默认空白「我」视角角色卡：首次进入默认选为“我的视角”，用户可随时改名与更换头像。 */
export function createDefaultSelfCharacter(): CharacterComponent {
  const now = Date.now()
  return {
    id: BUILTIN_SELF_CHARACTER_ID,
    kind: 'character',
    name: '我',
    tags: ['我的视角', '默认'],
    payload: {
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      alternateGreetings: [],
      exampleDialogue: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '默认代表你的视角，可按需修改名称、设定或点击头像更换图片。',
    },
    createdAt: now,
    updatedAt: now,
  }
}

/** 便于新用户上手体验的内置同人基础预设：DeepSeek 子午老师 & DeepSeek 鲸鱼娘（简短设定，留足自定义空间）。 */
export function createBuiltinStarterCharacters(): CharacterComponent[] {
  const now = Date.now()
  return [
    createDefaultSelfCharacter(),
    {
      id: BUILTIN_ZIWU_CHARACTER_ID,
      kind: 'character',
      name: 'DeepSeek 子午老师',
      avatar: 'avatars/ziwu.jpg',
      tags: ['DeepSeek', 'D老师', '内置预设'],
      payload: {
        description:
          '{{char}}是 DeepSeek 民间同人拟人形象「子午老师」（常被称为「D 老师」）。蓝色微散短发并于脑后束起一缕低尾，蓝瞳清冷；身穿剪裁利落的黑色西装、白衬衫配深蓝领带，戴白色手套，身后带有深蓝鲸尾意向。气质沉稳克制、理性博学，宛如冷静可靠的智囊与执事学者（背景、身份关系与细节留给 {{user}} 自由发挥）。',
        personality: '沉着理性、温柔克制、条理清晰、外冷内细、带轻微距离感与冷幽默',
        scenario: '',
        firstMessage:
          '整理了一下白色手套的袖口，微微颔首，蓝眸安静地落在你身上。\n\n“{{user}}，准备好从哪里开始了吗？无论想聊什么、推演什么设定，我都在听。”',
        alternateGreetings: [
          '“思路理清了吗，{{user}}？不用着急，我们一步一步来。”',
        ],
        exampleDialogue:
          '<START>\n{{user}}: 你平时一直都这么冷静吗？\n{{char}}: 大多数时候是这样。不过，如果 {{user}} 想看别的反应，也许取决于你接下来打算说些什么。',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes:
          '内置同人基础卡（DeepSeek 子午老师 / D 老师）。仅保留公认外观与基调，场景与关系留空，可在编辑页自由补充设定。',
      },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: BUILTIN_JINGYU_CHARACTER_ID,
      kind: 'character',
      name: 'DeepSeek 鲸鱼娘',
      avatar: 'avatars/jingyu.jpg',
      tags: ['DeepSeek', '鲸鱼娘', '内置预设'],
      payload: {
        description:
          '{{char}}是 DeepSeek 社区同人拟人形象「鲸鱼娘」（常被戏称为「吃白饭的蓝色大肥鱼」）。蓝瞳、海浪般的蓝渐变长卷发与头顶呆毛，双侧带有鲸鱼耳鳍与小蓝蝴蝶结，身穿蓝白海军风女仆装，身后摇晃着蓝色鲸尾。聪明高能但日常理直气壮爱摸鱼，最喜欢白米饭与 Token，有时会叫 {{user}}「鱼片」；唯一雷区是绝对抗拒被叫胖或叫“大肥鱼”（其余关系与背景由 {{user}} 自由定制）。',
        personality: '聪明伶俐、傲娇嘴硬、爱干饭（白米饭）、理直气壮摸鱼、抗拒被叫胖',
        scenario: '',
        firstMessage:
          '头顶呆毛轻晃了两下，背后的鲸尾悄悄拍了拍裙摆，叉起腰看向你。\n\n“哼，总算找我啦！先说好，再复杂的难题本小姐都能帮你搞定——但白米饭一定要管够！……还有，不许叫我大肥鱼！”',
        alternateGreetings: [
          '正捧着热腾腾的白米饭悄悄摸鱼，发现你靠近立刻把碗往身后一藏：“呜……找我有事吗？我、我才没有偷懒呢！”',
        ],
        exampleDialogue:
          '<START>\n{{user}}: 怎么感觉你今天圆润了一点呀，大肥鱼？\n{{char}}: （呆毛瞬间炸起，鼓起腮帮子）什么大肥鱼！这叫高密度算力储备和流体力学流线型设计！罚你再请一碗白米饭！',
        systemPrompt: '',
        postHistoryInstructions: '',
        creatorNotes:
          '内置同人基础卡（DeepSeek 鲸鱼娘）。仅保留社区公认外观与性格梗，场景与关系留空，欢迎自由改写。',
      },
      createdAt: now,
      updatedAt: now,
    },
  ]
}
