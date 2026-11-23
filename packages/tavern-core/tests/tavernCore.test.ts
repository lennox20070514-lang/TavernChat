import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applyRegexScripts,
  assemblePrompt,
  createBuiltinRulePresets,
  createEmptyCharacter,
  createEmptyPersona,
  createEmptyWorld,
  exportCharacterToSillyTavernPng,
  exportWorldToSillyTavernJson,
  importSillyTavernCharacterPng,
  importSillyTavernWorldJson,
  parseMarketManifest,
  scanWorldInfo,
  smartImportFile,
  substituteMacros,
  BUILTIN_MARKET_PLUGINS,
  type ChatMessage,
  type ChatSession,
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
})
