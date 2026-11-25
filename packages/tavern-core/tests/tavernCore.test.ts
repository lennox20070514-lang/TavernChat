import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, deflateSync } from 'node:zlib'
import {
  applyRegexScripts,
  assemblePrompt,
  buildContextMemoryBlock,
  createBuiltinRulePresets,
  createBuiltinStarterCharacters,
  createDefaultSelfCharacter,
  createEmptyCharacter,
  createEmptyPersona,
  createEmptyWorld,
  createMinimalPlaceholderPng,
  exportCharacterToSillyTavernPng,
  exportWorldToSillyTavernJson,
  extractCompactionSummary,
  findActiveCheckpoint,
  importSillyTavernCharacterPng,
  importSillyTavernWorldJson,
  mergeSyncSnapshots,
  normalizeChubCharacterPayload,
  normalizeChubLorebookPayload,
  normalizeChubPresetPayload,
  parseMarketManifest,
  parseSyncSnapshot,
  planCompaction,
  readCharacterJsonFromPng,
  resolveCompactionBudget,
  scanWorldInfo,
  smartImportFile,
  substituteMacros,
  BUILTIN_MARKET_PLUGINS,
  type ChatMessage,
  type ChatSession,
  type ContextCheckpoint,
} from '../src/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stSampleRoot = path.resolve(__dirname, '../../../ref/SillyTavern_data/default-user')

test('PNG character card round-trip read/write preserves V2 & V3 fields', () => {
  const char = createEmptyCharacter('测试角色')
  char.tags = ['科幻', '侦探']
  char.payload.description = '来自霓虹都市的独立调查员。'
  char.payload.personality = '冷静、克制、擅长推理'
  char.payload.firstMessage = '雨停了，我们出发吧，{{user}}。'
  char.payload.alternateGreetings = ['备用开场白 A']

  const world = createEmptyWorld('附属世界观')
  world.payload.entries[0] = {
    ...world.payload.entries[0]!,
    name: '赛博街区',
    keys: ['霓虹', '街区'],
    content: '第七街区常年被全息广告照亮。',
  }

  const pngBytes = exportCharacterToSillyTavernPng(char, world)
  const imported = importSillyTavernCharacterPng(pngBytes, '测试角色.png')

  assert.equal(imported.character.name, '测试角色')
  assert.equal(imported.character.payload.description, '来自霓虹都市的独立调查员。')
  assert.equal(imported.character.payload.personality, '冷静、克制、擅长推理')
  assert.deepEqual(imported.character.payload.alternateGreetings, ['备用开场白 A'])
  assert.ok(imported.character.avatar?.startsWith('data:image/png;base64,'))
  assert.ok(imported.embeddedWorld)
  assert.equal(imported.embeddedWorld?.payload.entries.length, 1)
  assert.equal(imported.embeddedWorld?.payload.entries[0]?.name, '赛博街区')
})

test('World Info trigger engine handles constant, keywords, secondary logic, recursion, and disabled overrides', () => {
  const world = createEmptyWorld('魔法大陆')
  world.payload.recursive = true
  world.payload.entries = [
    {
      id: 'e_const',
      name: '通用世界法则',
      content: '一切施法皆需代价。',
      keys: [],
      secondaryKeys: [],
      selectiveLogic: 'and_any',
      constant: true,
      enabled: true,
      order: 200,
      position: 'before_char',
      depth: 4,
      role: 'system',
    },
    {
      id: 'e_tower',
      name: '高塔',
      content: '高塔由古龙星陨守护。',
      keys: ['高塔', '尖塔'],
      secondaryKeys: [],
      selectiveLogic: 'and_any',
      constant: false,
      enabled: true,
      order: 100,
      position: 'after_char',
      depth: 4,
      role: 'system',
    },
    {
      id: 'e_dragon',
      name: '古龙星陨',
      content: '星陨是一头沉睡千年的银龙。',
      keys: ['星陨'],
      secondaryKeys: [],
      selectiveLogic: 'and_any',
      constant: false,
      enabled: true,
      order: 90,
      position: 'at_depth',
      depth: 2,
      role: 'system',
    },
    {
      id: 'e_secret',
      name: '秘密禁术',
      content: '只有在提及高塔且未提及禁忌时出现。',
      keys: ['高塔'],
      secondaryKeys: ['禁忌'],
      selectiveLogic: 'not_any',
      constant: false,
      enabled: true,
      order: 80,
      position: 'before_char',
      depth: 4,
      role: 'system',
    },
  ]

  const res = scanWorldInfo({
    worlds: [{ world, disabledEntryIds: new Set(['e_secret']) }],
    chatTexts: ['我们终于走到了高塔脚下。'],
  })

  // e_const(常驻) + e_tower(关键词) + e_dragon(由 e_tower 递归触发)，e_secret 被本对话局部禁用
  const ids = res.snapshots.map((s) => s.entryId)
  assert.ok(ids.includes('e_const'))
  assert.ok(ids.includes('e_tower'))
  assert.ok(ids.includes('e_dragon'))
  assert.ok(!ids.includes('e_secret'))
  assert.equal(res.snapshots.find((s) => s.entryId === 'e_dragon')?.reason, 'recursion')
  assert.equal(res.atDepth.length, 1)
})

test('Macros and Regex scripts work cleanly', () => {
  const out = substituteMacros(
    '你好 {{user}}，我是 {{char}}，今天是 {{date}}，骰子={{roll:1d6}}，选择={{random::甲::乙}}',
    {
      charName: '艾琳',
      userName: '旅人',
      now: new Date(2026, 10, 19, 15, 30),
      rng: () => 0.4,
    }
  )
  assert.equal(out, '你好 旅人，我是 艾琳，今天是 2026-11-19，骰子=3，选择=甲')

  const cleaned = applyRegexScripts(
    '普通文本 <status>HP:100</status>',
    [
      {
        id: 'r1',
        name: '隐藏状态标签',
        findRegex: '/<status>[\\s\\S]*?<\\/status>/g',
        replaceString: '[状态栏]',
        placements: ['display_only'],
        disabled: false,
      },
    ],
    'display_only'
  )
  assert.equal(cleaned, '普通文本 [状态栏]')
})

test('PromptAssembler dynamically mounts/unmounts multiple characters, world, persona, rule, and Author Note', () => {
  const rule = createBuiltinRulePresets()[0]!
  const charA = createEmptyCharacter('角色甲')
  charA.payload.description = '擅长剑术的护卫。'
  const charB = createEmptyCharacter('角色乙')
  charB.payload.description = '精明的情报贩子。'

  const world = createEmptyWorld('测试世界')
  world.payload.entries = [
    {
      id: 'w1',
      name: '古老车站',
      content: '车站每逢午夜响起钟声。',
      keys: ['车站'],
      secondaryKeys: [],
      selectiveLogic: 'and_any',
      constant: false,
      enabled: true,
      order: 100,
      position: 'before_char',
      depth: 4,
      role: 'system',
    },
  ]

  const persona = createEmptyPersona('调查员')
  persona.payload.displayName = '阿明'
  persona.payload.description = '携带笔记本的记录者。'

  const session: ChatSession = {
    id: 's1',
    title: '多角色自由装配测试',
    mounts: [
      { componentId: rule.id, kind: 'rule', enabled: true, order: 0 },
      { componentId: charA.id, kind: 'character', enabled: true, order: 1 },
      { componentId: charB.id, kind: 'character', enabled: true, order: 2 },
      { componentId: world.id, kind: 'world', enabled: true, order: 3 },
      { componentId: persona.id, kind: 'persona', enabled: true, order: 4 },
    ],
    authorsNote: '气氛紧张，暴风雨即将来临。',
    authorsNoteDepth: 1,
    multiCharMode: 'manual',
    activeLeafId: 'm2',
    createdAt: 1,
    updatedAt: 1,
  }

  const history: ChatMessage[] = [
    {
      id: 'm1',
      sessionId: 's1',
      parentId: null,
      role: 'user',
      content: '我们在车站汇合吧。',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'm2',
      sessionId: 's1',
      parentId: 'm1',
      role: 'assistant',
      speakerId: charA.id,
      speakerName: charA.name,
      content: '我已经在月台等你了。',
      createdAt: 2,
      updatedAt: 2,
    },
  ]

  const assembled = assemblePrompt({
    session,
    history,
    components: [rule, charA, charB, world, persona],
    nextSpeakerId: charB.id,
  })

  assert.deepEqual(assembled.activeCharacterNames, ['角色甲', '角色乙'])
  assert.equal(assembled.activeUserName, '阿明')
  assert.equal(assembled.triggeredWorld.length, 1)
  assert.equal(assembled.triggeredWorld[0]?.entryName, '古老车站')
  assert.ok(assembled.messages.some((m) => m.content.includes('仅以「角色乙」的视角')))
  assert.ok(assembled.messages.some((m) => m.content.includes('暴风雨即将来临')))

  // 演示“选出”角色乙：关闭其 mount.enabled 后立刻不进入 Prompt
  session.mounts[2]!.enabled = false
  const assembledAfterUnmount = assemblePrompt({
    session,
    history,
    components: [rule, charA, charB, world, persona],
  })
  assert.deepEqual(assembledAfterUnmount.activeCharacterNames, ['角色甲'])
  assert.ok(!assembledAfterUnmount.messages.some((m) => m.content.includes('角色乙')))
})

test('A selected character can act as the user POV without a separate persona component', () => {
  const pov = createEmptyCharacter('旅人')
  pov.payload.description = '来自北方的旅人。'
  pov.payload.personality = '谨慎'
  pov.payload.scenario = '刚抵达港镇。'
  const npc = createEmptyCharacter('店主')
  npc.payload.description = '{{user}} 走进店里时，他抬起头。'

  const session: ChatSession = {
    id: 's2',
    title: '出发视角测试',
    mounts: [
      { componentId: pov.id, kind: 'character', enabled: true, order: 0 },
      { componentId: npc.id, kind: 'character', enabled: true, order: 1 },
    ],
    userCharacterId: pov.id,
    authorsNote: '',
    authorsNoteDepth: 4,
    multiCharMode: 'manual',
    activeLeafId: null,
    createdAt: 1,
    updatedAt: 1,
  }

  const assembled = assemblePrompt({
    session,
    history: [],
    components: [pov, npc],
  })

  assert.equal(assembled.activeUserName, '旅人')
  assert.deepEqual(assembled.activeCharacterNames, ['店主'])
  assert.ok(
    assembled.messages.some(
      (m) =>
        m.sourceLabel === '用户视角 · 旅人' &&
        m.content.includes('来自北方的旅人') &&
        m.content.includes('谨慎')
    )
  )
  assert.ok(assembled.messages.some((m) => m.content.includes('旅人 走进店里')))
  assert.ok(!assembled.messages.some((m) => m.sourceLabel === '角色 · 旅人'))
})

test('Context compaction folds whole early rounds and preserves the latest turn', () => {
  const history: ChatMessage[] = []
  for (let i = 0; i < 10; i += 1) {
    history.push({
      id: `u${i}`,
      sessionId: 's',
      parentId: null,
      role: 'user',
      content: `第 ${i} 轮问题：` + '剧情推进与角色对话。'.repeat(20),
      createdAt: i * 2,
      updatedAt: i * 2,
    })
    history.push({
      id: `a${i}`,
      sessionId: 's',
      parentId: null,
      role: 'assistant',
      speakerName: '角色甲',
      content: `第 ${i} 轮回答：` + '角色作出回应并推进场景。'.repeat(20),
      createdAt: i * 2 + 1,
      updatedAt: i * 2 + 1,
    })
  }

  const budget = resolveCompactionBudget(32768, 'balanced')
  assert.equal(
    planCompaction({
      history,
      activeCheckpoint: null,
      budget,
      estimatedTokens: 100,
    }),
    null
  )

  const plan = planCompaction({
    history,
    activeCheckpoint: null,
    budget,
    estimatedTokens: budget.triggerTokens + 100,
  })
  assert.ok(plan)
  assert.ok(plan.messagesToCompactCount > 0)
  assert.ok(plan.messagesToCompactCount < history.length)
  assert.ok(plan.chunks.length > 0)
  assert.notEqual(plan.targetAnchorMessageId, history.at(-1)!.id)
  assert.notEqual(plan.targetAnchorMessageId, history.at(-2)!.id)

  const checkpoint: ContextCheckpoint = {
    id: 'cp1',
    upToMessageId: plan.targetAnchorMessageId,
    summary: '早期剧情摘要',
    coveredRounds: plan.coveredRounds,
    summaryTokens: 20,
    createdAt: 10,
  }
  const anchorIndex = findActiveCheckpoint(history, [checkpoint])?.anchorIndex
  assert.equal(
    anchorIndex,
    history.findIndex((message) => message.id === plan.targetAnchorMessageId)
  )
  assert.ok(anchorIndex !== undefined && anchorIndex < history.length - 2)
})

test('Compaction extracts structured memory and injects it into the system prefix', () => {
  assert.equal(
    extractCompactionSummary('<analysis>逐轮核对</analysis><summary>角色甲欠角色乙一个人情。</summary>'),
    '角色甲欠角色乙一个人情。'
  )
  assert.ok(buildContextMemoryBlock('角色甲欠角色乙一个人情。').includes('<conversation_memory>'))

  const rule = createBuiltinRulePresets()[0]!
  const session: ChatSession = {
    id: 's3',
    title: '压缩注入测试',
    mounts: [{ componentId: rule.id, kind: 'rule', enabled: true, order: 0 }],
    authorsNote: '',
    authorsNoteDepth: 4,
    multiCharMode: 'narrator',
    activeLeafId: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const assembled = assemblePrompt({
    session,
    history: [],
    components: [rule],
    contextSummary: '角色甲欠角色乙一个人情。',
  })
  assert.ok(
    assembled.messages.some(
      (m) => m.sourceLabel === '上下文记忆' && m.content.includes('角色甲欠角色乙一个人情。')
    )
  )
})

test('Real SillyTavern sample files (PNG / World JSON / Preset / Group / Chat JSONL) import cleanly', () => {
  if (!existsSync(stSampleRoot)) {
    return
  }

  // 1. PNG 角色卡
  const charPngPath = path.join(stSampleRoot, 'characters', '林晚晴.png')
  if (existsSync(charPngPath)) {
    const res = smartImportFile('林晚晴.png', new Uint8Array(readFileSync(charPngPath)))
    assert.equal(res.kind, 'character')
    assert.equal(res.bundle.character.name, '林晚晴')
    assert.ok(res.bundle.character.payload.description.length > 20)
  }

  // 2. World Info JSON + 导出往返
  const worldPath = path.join(stSampleRoot, 'worlds', '雾隐镇.json')
  if (existsSync(worldPath)) {
    const res = smartImportFile('雾隐镇.json', readFileSync(worldPath, 'utf8'))
    assert.equal(res.kind, 'world')
    assert.equal(res.world.payload.entries.length, 4)

    const scan = scanWorldInfo({
      worlds: [{ world: res.world }],
      chatTexts: ['听说灯塔那边出事了，老周失踪了吗？'],
    })
    assert.ok(scan.snapshots.some((s) => s.entryName === '灯塔与老周'))
    assert.ok(scan.snapshots.some((s) => s.entryName === '失踪案'))

    const exported = exportWorldToSillyTavernJson(res.world)
    const reimported = importSillyTavernWorldJson(exported, '雾隐镇')
    assert.equal(reimported.payload.entries.length, 4)
  }

  // 3. OpenAI 预设 JSON
  const presetPath = path.join(stSampleRoot, 'OpenAI Settings', 'Default.json')
  if (existsSync(presetPath)) {
    const res = smartImportFile('Default.json', readFileSync(presetPath, 'utf8'))
    assert.equal(res.kind, 'rule')
    assert.ok(res.rule.payload.systemPrompt.includes('{{char}}'))
  }

  // 4. 群聊 JSON
  const groupPath = path.join(stSampleRoot, 'groups', '1787930074113.json')
  if (existsSync(groupPath)) {
    const res = smartImportFile('1787930074113.json', readFileSync(groupPath, 'utf8'))
    assert.equal(res.kind, 'group')
    assert.equal(res.memberNames.length, 3)
  }

  // 5. 聊天记录 JSONL
  const chatPath = path.join(stSampleRoot, 'chats', '苏也', '苏也 - 2026-08-28@23h38m37s676ms.jsonl')
  if (existsSync(chatPath)) {
    const res = smartImportFile(path.basename(chatPath), readFileSync(chatPath, 'utf8'), 'sess_test')
    assert.equal(res.kind, 'chat_jsonl')
    assert.ok(res.messages.length > 0)
  }
})

test('market plugin manifests validate HTTPS resources and builtin allowlists stay consistent', () => {
  const manifest = parseMarketManifest({
    schema: 1,
    id: 'demo-pack',
    name: 'Demo Pack',
    version: '1.0.0',
    description: '测试插件',
    author: 'Demo Author',
    license: 'CC BY 4.0',
    cards: [
      {
        id: 'card-1',
        name: '测试角色',
        description: '来自测试清单',
        creator: 'Demo Author',
        kind: 'character',
        downloadUrl: 'https://raw.githubusercontent.com/example/pack/main/card-1.png',
        fileName: 'card-1.png',
        tags: ['测试'],
        sourceUrl: 'https://example.com/card-1',
        license: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      },
      {
        id: 'world-1',
        name: '测试世界书',
        description: '来自测试清单',
        creator: 'Demo Author',
        kind: 'world',
        downloadUrl: 'https://raw.githubusercontent.com/example/pack/main/world-1.json',
        fileName: 'world-1.json',
        tags: ['世界观'],
      },
    ],
  })
  assert.equal(manifest.cards.length, 2)
  assert.equal(manifest.cards[0]?.kind, 'character')
  assert.equal(manifest.cards[1]?.kind, 'world')

  assert.throws(
    () =>
      parseMarketManifest({
        schema: 1,
        id: 'bad',
        name: 'Bad',
        version: '1.0.0',
        author: 'Bad',
        cards: [
          {
            id: 'bad-1',
            name: 'Bad',
            creator: 'Bad',
            downloadUrl: 'http://example.com/card.png',
            fileName: 'card.png',
          },
        ],
      }),
    /HTTPS/
  )

  assert.throws(
    () =>
      parseMarketManifest({
        schema: 1,
        id: 'bad',
        name: 'Bad',
        version: '1.0.0',
        author: 'Bad',
        cards: [
          {
            id: 'bad-1',
            name: 'Bad',
            creator: 'Bad',
            downloadUrl: 'https://example.com/card.txt',
            fileName: 'card.txt',
          },
        ],
      }),
    /PNG 或 JSON/
  )

  assert.throws(
    () =>
      parseMarketManifest({
        schema: 1,
        id: 'bad',
        name: 'Bad',
        version: '1.0.0',
        author: 'Bad',
        cards: [
          {
            id: 'bad-world',
            name: 'Bad World',
            creator: 'Bad',
            kind: 'world',
            downloadUrl: 'https://example.com/world.png',
            fileName: 'world.png',
          },
        ],
      }),
    /JSON/
  )

  for (const plugin of BUILTIN_MARKET_PLUGINS) {
    const url = new URL(plugin.catalogUrl)
    assert.ok(plugin.hosts.includes(url.hostname), `${plugin.id} 主机与目录地址不一致`)
    assert.ok(
      plugin.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix)),
      `${plugin.id} 路径前缀与目录地址不一致`
    )
  }
  assert.ok(
    BUILTIN_MARKET_PLUGINS.some((plugin) => plugin.id === 'chub-ai'),
    'builtin market plugins should include chub-ai'
  )

  const chubChar = normalizeChubCharacterPayload({
    node: {
      name: 'Aria',
      topics: ['Fantasy', 'SFW'],
      definition: {
        name: 'Aria',
        description: 'Traveler from the north.',
        first_message: 'Well met, {{user}}.',
      },
    },
  })
  const importedChar = smartImportFile('aria.json', JSON.stringify(chubChar))
  assert.equal(importedChar.kind, 'character')
  assert.equal(importedChar.bundle.character.name, 'Aria')

  const chubLore = normalizeChubLorebookPayload({
    node: {
      name: 'Northern Realms',
      definition: {
        embedded_lorebook: {
          name: 'Northern Realms',
          entries: [
            {
              id: 1,
              keys: ['Citadel'],
              name: 'Glass Citadel',
              content: 'Built atop frozen cliffs.',
              constant: false,
              enabled: true,
            },
          ],
        },
      },
    },
  })
  const importedWorld = smartImportFile('northern.json', JSON.stringify(chubLore))
  assert.equal(importedWorld.kind, 'world')
  assert.equal(importedWorld.world.payload.entries[0]?.name, 'Glass Citadel')

  const chubPreset = normalizeChubPresetPayload({
    node: {
      name: 'Storyteller Preset',
      definition: {
        definition: {
          config: {
            system_prompt: { value: 'Stay grounded in scene.' },
            jailbreak_prompt: { value: 'Focus on vivid dialogue.' },
            generation_settings: {
              temperature: { value: 0.75 },
              top_p: { value: 0.92 },
              context_length: { value: 32768 },
            },
          },
        },
      },
    },
  })
  const importedRule = smartImportFile('storyteller.json', JSON.stringify(chubPreset))
  assert.equal(importedRule.kind, 'rule')
  assert.equal(importedRule.rule.payload.temperature, 0.75)
  assert.ok(importedRule.rule.payload.systemPrompt.includes('Stay grounded in scene.'))
})

test('mergeSyncSnapshots merges concurrent edits, tombstones, and settings cleanly', () => {
  const charA = createEmptyCharacter('角色甲')
  charA.updatedAt = 100
  const charB = createEmptyCharacter('角色乙')
  charB.updatedAt = 120
  const deletedChar = createEmptyCharacter('待删除角色')
  deletedChar.updatedAt = 90

  const phone = parseSyncSnapshot({
    schema: 1,
    revision: 2,
    updatedAt: 200,
    components: [charA, deletedChar],
    sessions: [
      {
        id: 'sess_1',
        title: '群聊会话',
        mounts: [],
        authorsNote: '',
        authorsNoteDepth: 4,
        multiCharMode: 'narrator',
        activeLeafId: 'm2',
        createdAt: 100,
        updatedAt: 200,
      },
    ],
    messages: [
      {
        id: 'm1',
        sessionId: 'sess_1',
        parentId: null,
        role: 'user',
        content: '手机端消息',
        createdAt: 150,
        updatedAt: 150,
      },
    ],
    deletedIds: {},
    settings: {
      providers: [{ id: 'p1', name: 'DeepSeek', apiKey: 'sk-phone' }],
      activeProviderId: 'p1',
      defaultMaxContextTokens: 32768,
      defaultMaxResponseTokens: 2048,
      contextCompression: 'balanced',
      autoInsertGreeting: true,
      updatedAt: 200,
    },
  })

  const pc = parseSyncSnapshot({
    schema: 1,
    revision: 2,
    updatedAt: 250,
    components: [{ ...charA, name: '角色甲（电脑修改版）', updatedAt: 240 }, charB],
    sessions: [
      {
        id: 'sess_1',
        title: '群聊会话（同步）',
        mounts: [],
        authorsNote: '',
        authorsNoteDepth: 4,
        multiCharMode: 'narrator',
        activeLeafId: 'm2',
        createdAt: 100,
        updatedAt: 250,
      },
    ],
    messages: [
      {
        id: 'm2',
        sessionId: 'sess_1',
        parentId: 'm1',
        role: 'assistant',
        content: '电脑端回复',
        createdAt: 250,
        updatedAt: 250,
      },
    ],
    deletedIds: { [deletedChar.id]: 220 },
    settings: {
      providers: [],
      activeProviderId: '',
      defaultMaxContextTokens: 32768,
      defaultMaxResponseTokens: 2048,
      contextCompression: 'balanced',
      autoInsertGreeting: true,
      updatedAt: 0,
    },
  })

  const merged = mergeSyncSnapshots(phone, pc)
  assert.equal(merged.components.length, 2)
  assert.equal(
    merged.components.find((c) => c.id === charA.id)?.name,
    '角色甲（电脑修改版）'
  )
  assert.equal(merged.components.some((c) => c.id === deletedChar.id), false)
  assert.equal(merged.messages.length, 2)
  assert.equal(merged.sessions[0]?.title, '群聊会话（同步）')
  assert.equal((merged.settings?.providers[0] as { apiKey?: string })?.apiKey, 'sk-phone')
})

function buildMinimalZip(files: Array<{ name: string; data: Uint8Array; compress?: boolean }>): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const rawBuf = Buffer.from(file.data)
    const compBuf = file.compress ? deflateRawSync(rawBuf) : rawBuf
    const method = file.compress ? 8 : 0

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt32LE(compBuf.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localParts.push(localHeader, nameBuf, compBuf)

    const cdHeader = Buffer.alloc(46)
    cdHeader.writeUInt32LE(0x02014b50, 0)
    cdHeader.writeUInt16LE(20, 4)
    cdHeader.writeUInt16LE(20, 6)
    cdHeader.writeUInt16LE(method, 10)
    cdHeader.writeUInt32LE(compBuf.length, 20)
    cdHeader.writeUInt32LE(rawBuf.length, 24)
    cdHeader.writeUInt16LE(nameBuf.length, 28)
    cdHeader.writeUInt32LE(offset, 42)
    centralParts.push(cdHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + compBuf.length
  }

  const cdBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return new Uint8Array(Buffer.concat([...localParts, cdBuf, eocd]))
}

function insertPngChunkBeforeIend(pngBytes: Uint8Array, type: string, data: Uint8Array): Uint8Array {
  const iendPos = pngBytes.length - 12
  const out = new Uint8Array(pngBytes.length + 12 + data.length)
  out.set(pngBytes.subarray(0, iendPos), 0)
  const view = new DataView(out.buffer, iendPos)
  view.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i++) out[iendPos + 4 + i] = type.charCodeAt(i)
  out.set(data, iendPos + 8)
  out.set(pngBytes.subarray(iendPos), iendPos + 12 + data.length)
  return out
}

test('Importers handle PNG iTXt/zTXt, CHARX zip, NovelAI lorebooks, BOM, prompt_order, and starter cards', () => {
  const basePng = createMinimalPlaceholderPng()
  const cardPayload = JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: '压缩块测试角色', first_mes: '你好，{{user}}。' },
  })
  const b64 = Buffer.from(cardPayload, 'utf8').toString('base64')

  const itxtHeader = Buffer.from('ccv3\0\x01\x00\0\0', 'latin1')
  const itxtData = new Uint8Array(Buffer.concat([itxtHeader, deflateSync(Buffer.from(b64, 'utf8'))]))
  const pngWithItxt = insertPngChunkBeforeIend(basePng, 'iTXt', itxtData)
  assert.equal(JSON.parse(readCharacterJsonFromPng(pngWithItxt)).data.name, '压缩块测试角色')

  const ztxtHeader = Buffer.from('chara\0\x00', 'latin1')
  const ztxtData = new Uint8Array(Buffer.concat([ztxtHeader, deflateSync(Buffer.from(b64, 'utf8'))]))
  const pngWithZtxt = insertPngChunkBeforeIend(basePng, 'zTXt', ztxtData)
  assert.equal(JSON.parse(readCharacterJsonFromPng(pngWithZtxt)).data.name, '压缩块测试角色')

  const charxZip = buildMinimalZip([
    {
      name: 'card.json',
      data: Buffer.from(
        JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Charx角色', first_mes: 'Hi' } }),
        'utf8'
      ),
      compress: true,
    },
    { name: 'assets/icon/output/main.png', data: basePng, compress: false },
  ])
  const importedCharx = smartImportFile('hero.charx', charxZip)
  assert.equal(importedCharx.kind, 'character')
  assert.equal(importedCharx.bundle.character.name, 'Charx角色')
  assert.ok(importedCharx.bundle.character.avatar?.startsWith('data:image/png;base64,'))

  const bomWorld =
    '\uFEFF' +
    JSON.stringify({
      lorebookVersion: 4,
      entries: [
        { displayName: '白银港', keys: '港口, 商船', text: '终年不冻的海港城市。', forceActivation: 'true' },
      ],
    })
  const importedWorld = smartImportFile('silver.lorebook', bomWorld)
  assert.equal(importedWorld.kind, 'world')
  assert.equal(importedWorld.world.payload.entries[0]?.constant, true)
  assert.deepEqual(importedWorld.world.payload.entries[0]?.keys, ['港口', '商船'])

  const presetOrdered = smartImportFile(
    'ordered.json',
    JSON.stringify({
      prompts: [
        { identifier: 'main', content: '主系统指令' },
        { identifier: 'disabled_block', content: '不应被拼接的禁用段' },
        { identifier: 'jailbreak', content: '后置指令' },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'disabled_block', enabled: false },
            { identifier: 'jailbreak', enabled: true },
          ],
        },
      ],
      temperature: 0.88,
    })
  )
  assert.equal(presetOrdered.kind, 'rule')
  assert.ok(!presetOrdered.rule.payload.systemPrompt.includes('不应被拼接'))
  assert.equal(presetOrdered.rule.payload.postHistoryInstructions, '后置指令')

  const pygV1 = smartImportFile(
    'pyg.json',
    JSON.stringify({ char_name: '古典角色', char_persona: '温和的学者', char_greeting: '你好。' })
  )
  assert.equal(pygV1.kind, 'character')
  assert.equal(pygV1.bundle.character.name, '古典角色')

  const selfCard = createDefaultSelfCharacter()
  assert.equal(selfCard.name, '我')
  assert.equal(selfCard.avatar, undefined)
  const starters = createBuiltinStarterCharacters()
  assert.ok(starters.some((c) => c.name === 'DeepSeek 子午老师' && c.avatar === 'avatars/ziwu.jpg'))
  assert.ok(starters.some((c) => c.name === 'DeepSeek 鲸鱼娘' && c.avatar === 'avatars/jingyu.jpg'))
})
