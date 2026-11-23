import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import {
  createEmptyCharacter,
  createEmptyPersona,
  createEmptyRule,
  createEmptyWorld,
  createEmptyWorldEntry,
  exportCharacterToSillyTavernPng,
  exportWorldToSillyTavernJson,
  type CharacterComponent,
  type ComponentItem,
  type ComponentKind,
  type PersonaComponent,
  type RuleComponent,
  type WorldComponent,
  type WorldEntry,
  type WorldEntryPosition,
} from '@tavern-chat/core'
import { useAppStore } from '../../services/store.ts'
import { saveFileBlob } from '../../utils/fileSave.ts'
import {
  IconDownload,
  IconGlobe,
  IconPlus,
  IconSliders,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconUser,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './LibraryModal.module.css'

const KIND_LABELS: Record<ComponentKind, string> = {
  character: '角色卡',
  world: '世界卡',
  persona: '人设卡',
  rule: '规则卡',
}

export const LibraryModal = () => {
  const open = useAppStore((s) => s.libraryOpen)
  const initialTab = useAppStore((s) => s.libraryInitialTab)
  const editingId = useAppStore((s) => s.libraryEditingId)
  const closeLibrary = useAppStore((s) => s.closeLibrary)

  const components = useAppStore((s) => s.components)
  const sessions = useAppStore((s) => s.sessions)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const upsertComponent = useAppStore((s) => s.upsertComponent)
  const deleteComponent = useAppStore((s) => s.deleteComponent)
  const toggleMountComponent = useAppStore((s) => s.toggleMountComponent)
  const importFiles = useAppStore((s) => s.importFiles)
  const showToast = useAppStore((s) => s.showToast)

  const [tab, setTab] = useState<ComponentKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setTab(initialTab)
      setSelectedId(editingId ?? components[0]?.id ?? null)
    }
  }, [open, initialTab, editingId])

  if (!open) return null

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const mountedIds = new Set(activeSession?.mounts.map((m) => m.componentId) ?? [])

  const filtered = components.filter((c) => {
    if (tab !== 'all' && c.kind !== tab) return false
    if (query.trim() && !c.name.toLowerCase().includes(query.trim().toLowerCase())) return false
    return true
  })

  const selected = components.find((c) => c.id === selectedId) ?? null

  const handleCreate = async (kind: ComponentKind) => {
    const item: ComponentItem =
      kind === 'character'
        ? createEmptyCharacter()
        : kind === 'world'
          ? createEmptyWorld()
          : kind === 'persona'
            ? createEmptyPersona()
            : createEmptyRule()
    await upsertComponent(item)
    setTab(kind)
    setSelectedId(item.id)
    showToast(`已新建${KIND_LABELS[kind]}`, 'success')
  }

  const patchSelected = (next: ComponentItem) => {
    void upsertComponent(next)
  }

  const handleAvatarUpload = (file: File, target: ComponentItem) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        patchSelected({ ...target, avatar: reader.result })
      }
    }
    reader.readAsDataURL(file)
  }

  const handleExportCard = async (item: ComponentItem) => {
    if (item.kind === 'character') {
      const pngBytes = exportCharacterToSillyTavernPng(item as CharacterComponent)
      const copy = new Uint8Array(pngBytes.byteLength)
      copy.set(pngBytes)
      const res = await saveFileBlob(new Blob([copy], { type: 'image/png' }), `${item.name}.png`)
      if (res !== 'cancelled') showToast('已导出标准 SillyTavern PNG 角色卡', 'success')
    } else if (item.kind === 'world') {
      const json = JSON.stringify(exportWorldToSillyTavernJson(item as WorldComponent), null, 2)
      const res = await saveFileBlob(new Blob([json], { type: 'application/json' }), `${item.name}.json`)
      if (res !== 'cancelled') showToast('已导出标准 SillyTavern 世界书 JSON', 'success')
    }
  }

  return (
    <Modal
      open={open}
      title="组件库"
      size="lg"
      onClose={closeLibrary}
      headerExtra={
        <button
          type="button"
          className={styles.btn}
          onClick={() => importInputRef.current?.click()}
        >
          <IconUpload size={14} />
          <span>导入酒馆文件</span>
        </button>
      }
    >
      <input
        ref={importInputRef}
        type="file"
        multiple
        accept=".png,.json,.jsonl"
        style={{ display: 'none' }}
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await importFiles(e.target.files)
            e.target.value = ''
          }
        }}
      />

      <div className={styles.shell}>
        <div className={styles.left}>
          <div className={styles.leftTop}>
            <div className={styles.tabs}>
              {(['all', 'character', 'world', 'persona', 'rule'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={clsx(styles.tab, tab === k && styles.tabActive)}
                  onClick={() => setTab(k)}
                >
                  {k === 'all' ? '全部' : KIND_LABELS[k].replace('卡', '')}
                </button>
              ))}
            </div>

            <input
              className={styles.searchInput}
              placeholder="搜索组件名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className={styles.actionRow}>
              <button
                type="button"
                className={clsx(styles.btn, styles.btnPrimary)}
                style={{ flex: 1 }}
                onClick={() => void handleCreate(tab === 'all' ? 'character' : tab)}
              >
                <IconPlus size={14} />
                <span>新建{tab === 'all' ? '角色卡' : KIND_LABELS[tab]}</span>
              </button>
              {tab === 'all' ? (
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => void handleCreate('world')}
                >
                  <IconPlus size={14} />
                  <span>世界卡</span>
                </button>
              ) : null}
            </div>
          </div>

          <div className={styles.list}>
            {filtered.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12.5 }}>
                暂无组件，点击上方新建或导入酒馆文件
              </div>
            ) : (
              filtered.map((item) => {
                const isMounted = mountedIds.has(item.id)
                return (
                  <div
                    key={item.id}
                    className={clsx(styles.item, selectedId === item.id && styles.itemActive)}
                    onClick={() => setSelectedId(item.id)}
                  >
                    {item.avatar ? (
                      <img className={styles.avatar} src={item.avatar} alt="" />
                    ) : (
                      <span className={styles.avatar}>
                        {item.kind === 'character' ? (
                          <IconSparkles size={16} />
                        ) : item.kind === 'world' ? (
                          <IconGlobe size={16} />
                        ) : item.kind === 'persona' ? (
                          <IconUser size={16} />
                        ) : (
                          <IconSliders size={16} />
                        )}
                      </span>
                    )}
                    <div className={styles.itemInfo}>
                      <div className={styles.itemTitle}>{item.name}</div>
                      <div className={styles.itemSub}>
                        {KIND_LABELS[item.kind]}
                        {item.kind === 'world'
                          ? ` · ${(item as WorldComponent).payload.entries.length} 条`
                          : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={clsx(styles.mountBadge, isMounted && styles.mountBadgeOn)}
                      title={isMounted ? '点击从当前对话选出' : '点击选入当前对话'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleMountComponent(item.id)
                      }}
                    >
                      {isMounted ? '已选入' : '+ 选入'}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {!selected ? (
          <div className={styles.emptyEditor}>
            <div>从左侧选择一个组件编辑，或直接新建 / 导入酒馆 PNG 角色卡与世界书 JSON。</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {(['character', 'world', 'persona', 'rule'] as ComponentKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={styles.btn}
                  onClick={() => void handleCreate(k)}
                >
                  <IconPlus size={14} />
                  <span>新建{KIND_LABELS[k]}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.editor}>
            <div className={styles.editorHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>
                  编辑{KIND_LABELS[selected.kind]}
                </span>
                <button
                  type="button"
                  className={clsx(
                    styles.mountBadge,
                    mountedIds.has(selected.id) && styles.mountBadgeOn
                  )}
                  onClick={() => void toggleMountComponent(selected.id)}
                >
                  {mountedIds.has(selected.id) ? '已选入当前对话（点击选出）' : '+ 选入当前对话'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {selected.kind === 'character' || selected.kind === 'world' ? (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void handleExportCard(selected)}
                  >
                    <IconDownload size={14} />
                    <span>{selected.kind === 'character' ? '导出酒馆 PNG' : '导出酒馆 JSON'}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={clsx(styles.btn, styles.btnDanger)}
                  onClick={() => {
                    if (window.confirm(`确定删除「${selected.name}」吗？`)) {
                      const delId = selected.id
                      setSelectedId(null)
                      void deleteComponent(delId)
                    }
                  }}
                >
                  <IconTrash size={14} />
                  <span>删除</span>
                </button>
              </div>
            </div>

            {/* 通用名称与头像 */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
              {selected.kind === 'character' || selected.kind === 'persona' ? (
                <div>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) handleAvatarUpload(f, selected)
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    title="点击更换头像"
                    style={{
                      width: 56,
                      height: 56,
                      padding: 0,
                      borderRadius: 12,
                      border: '1px solid var(--border-default)',
                      background: 'var(--bg-subtle)',
                      overflow: 'hidden',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {selected.avatar ? (
                      <img
                        src={selected.avatar}
                        alt=""
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      <IconPlus size={18} />
                    )}
                  </button>
                </div>
              ) : null}

              <div className={styles.field} style={{ flex: 1 }}>
                <label className={styles.label}>组件名称</label>
                <input
                  className={styles.input}
                  value={selected.name}
                  onChange={(e) => patchSelected({ ...selected, name: e.target.value })}
                />
              </div>
            </div>

            {/* 角色卡表单（渐进式披露：核心 3 项首屏可见，其余优雅折叠） */}
            {selected.kind === 'character' ? (() => {
              const char = selected as CharacterComponent
              const updatePayload = (patch: Partial<CharacterComponent['payload']>) =>
                patchSelected({ ...char, payload: { ...char.payload, ...patch } })
              return (
                <>
                  <div className={styles.field}>
                    <label className={styles.label}>角色设定（外貌、背景、说话方式）</label>
                    <textarea
                      className={styles.textarea}
                      style={{ minHeight: 120 }}
                      placeholder="描述这位角色的身份、经历与语言风格，支持 {{char}} 与 {{user}} 占位符…"
                      value={char.payload.description}
                      onChange={(e) => updatePayload({ description: e.target.value })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>开场白（首次选入空对话时可自动带入）</label>
                    <textarea
                      className={styles.textarea}
                      placeholder="角色出场时的第一句话或动作描写…"
                      value={char.payload.firstMessage}
                      onChange={(e) => updatePayload({ firstMessage: e.target.value })}
                    />
                  </div>
                  <details className={styles.fold}>
                    <summary>更多角色细节（性格、场景、对话示例、系统覆盖指令）</summary>
                    <div className={styles.foldBody}>
                      <div className={styles.field}>
                        <label className={styles.label}>性格摘要</label>
                        <input
                          className={styles.input}
                          value={char.payload.personality}
                          onChange={(e) => updatePayload({ personality: e.target.value })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>默认场景</label>
                        <textarea
                          className={styles.textarea}
                          value={char.payload.scenario}
                          onChange={(e) => updatePayload({ scenario: e.target.value })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>示例对话（可帮助稳定语气）</label>
                        <textarea
                          className={styles.textarea}
                          value={char.payload.exampleDialogue}
                          onChange={(e) => updatePayload({ exampleDialogue: e.target.value })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label}>角色专属系统提示词（可选）</label>
                        <textarea
                          className={styles.textarea}
                          value={char.payload.systemPrompt}
                          onChange={(e) => updatePayload({ systemPrompt: e.target.value })}
                        />
                      </div>
                    </div>
                  </details>
                </>
              )
            })() : null}

            {/* 世界卡表单（条理清晰：蓝灯常驻 / 绿灯关键词一键切换） */}
            {selected.kind === 'world' ? (() => {
              const world = selected as WorldComponent
              const updatePayload = (patch: Partial<WorldComponent['payload']>) =>
                patchSelected({ ...world, payload: { ...world.payload, ...patch } })
              const updateEntry = (entryId: string, patch: Partial<WorldEntry>) => {
                updatePayload({
                  entries: world.payload.entries.map((e) =>
                    e.id === entryId ? { ...e, ...patch } : e
                  ),
                })
              }
              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className={styles.label}>
                      世界观条目（共 {world.payload.entries.length} 条）
                    </span>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() =>
                        updatePayload({
                          entries: [
                            ...world.payload.entries,
                            createEmptyWorldEntry(world.payload.entries.length),
                          ],
                        })
                      }
                    >
                      <IconPlus size={14} />
                      <span>添加条目</span>
                    </button>
                  </div>

                  {world.payload.entries.map((entry) => (
                    <div key={entry.id} className={styles.entryCard}>
                      <div className={styles.entryTop}>
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          title="启用/停用该条目"
                          onChange={(e) => updateEntry(entry.id, { enabled: e.target.checked })}
                        />
                        <button
                          type="button"
                          className={clsx(
                            styles.lightBtn,
                            entry.constant ? styles.lightConst : styles.lightKey
                          )}
                          title="点击切换触发方式：蓝灯常驻 / 绿灯关键词触发"
                          onClick={() => updateEntry(entry.id, { constant: !entry.constant })}
                        >
                          {entry.constant ? '● 蓝灯常驻' : '● 绿灯关键词'}
                        </button>
                        <input
                          className={styles.input}
                          style={{ flex: 1, minWidth: 120, padding: '4px 8px' }}
                          placeholder="条目名称"
                          value={entry.name}
                          onChange={(e) => updateEntry(entry.id, { name: e.target.value })}
                        />
                        <button
                          type="button"
                          className={styles.btn}
                          style={{ height: 28, padding: '0 8px' }}
                          title="删除条目"
                          onClick={() =>
                            updatePayload({
                              entries: world.payload.entries.filter((e) => e.id !== entry.id),
                            })
                          }
                        >
                          <IconTrash size={13} />
                        </button>
                      </div>

                      {!entry.constant ? (
                        <input
                          className={styles.input}
                          placeholder="触发关键词（多个用逗号分隔，例如：灯塔, 码头, 失踪）"
                          value={entry.keys.join(', ')}
                          onChange={(e) =>
                            updateEntry(entry.id, {
                              keys: e.target.value
                                .split(/[,，]/)
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      ) : null}

                      <textarea
                        className={styles.textarea}
                        style={{ minHeight: 72 }}
                        placeholder="设定正文（命中关键词后将自动注入上下文）…"
                        value={entry.content}
                        onChange={(e) => updateEntry(entry.id, { content: e.target.value })}
                      />

                      <details className={styles.fold} style={{ padding: '6px 10px' }}>
                        <summary style={{ fontSize: 12 }}>高级触发与注入位置</summary>
                        <div className={styles.foldBody} style={{ marginTop: 8 }}>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <div className={styles.field} style={{ flex: 1, minWidth: 140 }}>
                              <label className={styles.label}>注入位置</label>
                              <select
                                className={styles.select}
                                value={entry.position}
                                onChange={(e) =>
                                  updateEntry(entry.id, {
                                    position: e.target.value as WorldEntryPosition,
                                  })
                                }
                              >
                                <option value="before_char">角色设定之前</option>
                                <option value="after_char">角色设定之后</option>
                                <option value="at_depth">聊天记录内按深度注入</option>
                                <option value="before_an">剧情便签之前</option>
                                <option value="after_an">剧情便签之后</option>
                              </select>
                            </div>
                            <div className={styles.field} style={{ width: 90 }}>
                              <label className={styles.label}>优先级</label>
                              <input
                                className={styles.input}
                                type="number"
                                value={entry.order}
                                onChange={(e) =>
                                  updateEntry(entry.id, { order: Number(e.target.value) || 100 })
                                }
                              />
                            </div>
                            {entry.position === 'at_depth' ? (
                              <div className={styles.field} style={{ width: 80 }}>
                                <label className={styles.label}>深度</label>
                                <input
                                  className={styles.input}
                                  type="number"
                                  min={0}
                                  value={entry.depth}
                                  onChange={(e) =>
                                    updateEntry(entry.id, { depth: Number(e.target.value) || 0 })
                                  }
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </details>
                    </div>
                  ))}

                  <details className={styles.fold}>
                    <summary>世界卡全局扫描设置（递归扫描、深度、预算）</summary>
                    <div className={styles.foldBody}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={world.payload.recursive}
                          onChange={(e) => updatePayload({ recursive: e.target.checked })}
                        />
                        <span>开启递归扫描（已触发条目的内容可连锁触发其他条目）</span>
                      </label>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <div className={styles.field} style={{ flex: 1 }}>
                          <label className={styles.label}>扫描最近消息数</label>
                          <input
                            className={styles.input}
                            type="number"
                            min={1}
                            value={world.payload.scanDepth}
                            onChange={(e) =>
                              updatePayload({ scanDepth: Math.max(1, Number(e.target.value) || 4) })
                            }
                          />
                        </div>
                        <div className={styles.field} style={{ flex: 1 }}>
                          <label className={styles.label}>Token 预算上限（0 为自动）</label>
                          <input
                            className={styles.input}
                            type="number"
                            min={0}
                            step={256}
                            value={world.payload.tokenBudget}
                            onChange={(e) =>
                              updatePayload({ tokenBudget: Math.max(0, Number(e.target.value) || 0) })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </details>
                </>
              )
            })() : null}

            {/* 人设卡表单 */}
            {selected.kind === 'persona' ? (() => {
              const persona = selected as PersonaComponent
              const updatePayload = (patch: Partial<PersonaComponent['payload']>) =>
                patchSelected({ ...persona, payload: { ...persona.payload, ...patch } })
              return (
                <>
                  <div className={styles.field}>
                    <label className={styles.label}>你在对话中的称呼（对应 {'{{user}}'}）</label>
                    <input
                      className={styles.input}
                      placeholder="例如：我 / 旅人 / 阿明"
                      value={persona.payload.displayName}
                      onChange={(e) => updatePayload({ displayName: e.target.value })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>个人身份与背景描述</label>
                    <textarea
                      className={styles.textarea}
                      style={{ minHeight: 130 }}
                      placeholder="简短描述你在故事中的身份、外貌或性格…"
                      value={persona.payload.description}
                      onChange={(e) => updatePayload({ description: e.target.value })}
                    />
                  </div>
                </>
              )
            })() : null}

            {/* 规则/预设卡表单 */}
            {selected.kind === 'rule' ? (() => {
              const rule = selected as RuleComponent
              const updatePayload = (patch: Partial<RuleComponent['payload']>) =>
                patchSelected({ ...rule, payload: { ...rule.payload, ...patch } })
              return (
                <>
                  <div className={styles.field}>
                    <label className={styles.label}>简要说明</label>
                    <input
                      className={styles.input}
                      value={rule.payload.description}
                      onChange={(e) => updatePayload({ description: e.target.value })}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>核心系统指令（System Prompt）</label>
                    <textarea
                      className={styles.textarea}
                      style={{ minHeight: 140 }}
                      placeholder="定义整体文风、叙事视角与基本规则，支持 {{char}} / {{user}}…"
                      value={rule.payload.systemPrompt}
                      onChange={(e) => updatePayload({ systemPrompt: e.target.value })}
                    />
                  </div>
                  <details className={styles.fold}>
                    <summary>高级设置（尾部强化指令、温度与采样）</summary>
                    <div className={styles.foldBody}>
                      <div className={styles.field}>
                        <label className={styles.label}>对话末尾强化指令（Post-History Instructions）</label>
                        <textarea
                          className={styles.textarea}
                          value={rule.payload.postHistoryInstructions}
                          onChange={(e) => updatePayload({ postHistoryInstructions: e.target.value })}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <div className={styles.field} style={{ flex: 1 }}>
                          <label className={styles.label}>Temperature（留空跟随模型默认）</label>
                          <input
                            className={styles.input}
                            type="number"
                            step={0.05}
                            min={0}
                            max={2}
                            value={rule.payload.temperature ?? ''}
                            onChange={(e) =>
                              updatePayload({
                                temperature:
                                  e.target.value === '' ? undefined : Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        <div className={styles.field} style={{ flex: 1 }}>
                          <label className={styles.label}>最大回复 Token（可选）</label>
                          <input
                            className={styles.input}
                            type="number"
                            step={256}
                            value={rule.payload.maxTokens ?? ''}
                            onChange={(e) =>
                              updatePayload({
                                maxTokens:
                                  e.target.value === '' ? undefined : Number(e.target.value),
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </details>
                </>
              )
            })() : null}
          </div>
        )}
      </div>
    </Modal>
  )
}
