import clsx from 'clsx'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createEmptyCharacter,
  createEmptyRule,
  createEmptyWorld,
  createEmptyWorldEntry,
  exportCharacterToSillyTavernPng,
  exportWorldToSillyTavernJson,
  type CharacterComponent,
  type ComponentItem,
  type ComponentKind,
  type RuleComponent,
  type WorldComponent,
  type WorldEntry,
  type WorldEntryPosition,
} from '@tavern-chat/core'
import {
  createMarketGroup,
  deleteMarketGroup,
  listMarketGroups,
  type MarketGroup,
} from '../../services/marketGroups.ts'
import { useAppStore } from '../../services/store.ts'
import { resizeImageFileToAvatarDataUrl } from '../../utils/defaultAvatars.ts'
import { saveFileBlob } from '../../utils/fileSave.ts'
import {
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconDownload,
  IconEdit,
  IconGlobe,
  IconHelpCircle,
  IconPlus,
  IconSearch,
  IconSliders,
  IconSparkles,
  IconTrash,
  IconUpload,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './LibraryModal.module.css'

type LibraryKind = 'character' | 'world' | 'rule'
type LibraryViewMode = 'list' | 'detail' | 'create' | 'edit'

const KIND_LABELS: Record<ComponentKind, string> = {
  character: '角色卡',
  world: '世界卡',
  persona: '人设卡',
  rule: '规则卡',
}

const LIBRARY_KINDS: Array<{ kind: LibraryKind; label: string }> = [
  { kind: 'character', label: '角色卡' },
  { kind: 'world', label: '世界卡' },
  { kind: 'rule', label: '规则卡' },
]

function buildDraftCard(kind: LibraryKind, seedName?: string, seedGroups?: string[]): ComponentItem {
  const base =
    kind === 'character'
      ? createEmptyCharacter(seedName || '新角色')
      : kind === 'world'
        ? createEmptyWorld(seedName || '新世界卡')
        : createEmptyRule(seedName || '新规则卡')
  return seedGroups && seedGroups.length > 0 ? { ...base, groups: seedGroups } : base
}

type CardFormFieldsProps = {
  card: ComponentItem
  groups: MarketGroup[]
  onChange: (next: ComponentItem) => void
  onUploadAvatar: (file: File) => void
}

const CardFormFields = ({ card, groups, onChange, onUploadAvatar }: CardFormFieldsProps) => {
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [lightHelpOpen, setLightHelpOpen] = useState(false)

  const toggleGroup = (groupId: string) => {
    const current = card.groups ?? []
    const next = current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId]
    onChange({ ...card, groups: next })
  }

  return (
    <>
      {/* 通用头像与名称 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        {card.kind === 'character' ? (
          <div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onUploadAvatar(f)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              title="点击上传角色头像"
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
                cursor: 'pointer',
              }}
            >
              {card.avatar ? (
                <img
                  src={card.avatar}
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
          <label className={styles.label}>卡牌名称</label>
          <input
            className={styles.input}
            value={card.name}
            onChange={(e) => onChange({ ...card, name: e.target.value })}
          />
        </div>
      </div>

      {card.kind === 'character' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => avatarInputRef.current?.click()}
            style={{
              height: 28,
              padding: '0 10px',
              borderRadius: 8,
              border: '1px dashed var(--border-default)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            从相册上传头像
          </button>
          {card.avatar ? (
            <button
              type="button"
              onClick={() => onChange({ ...card, avatar: undefined })}
              style={{
                height: 28,
                padding: '0 10px',
                borderRadius: 8,
                border: '1px solid var(--border-subtle)',
                background: 'transparent',
                color: 'var(--text-tertiary)',
                fontSize: 11.5,
                cursor: 'pointer',
              }}
            >
              恢复默认
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.groupEditor}>
        <span className={styles.groupEditorLabel}>分组</span>
        {groups.length === 0 ? (
          <span className={styles.groupEditorEmpty}>可在卡牌库列表上方「新建分组」归类。</span>
        ) : (
          <div className={styles.groupEditorOptions}>
            {groups.map((group) => {
              const active = (card.groups ?? []).includes(group.id)
              return (
                <button
                  key={group.id}
                  type="button"
                  className={clsx(styles.groupToggle, active && styles.groupToggleOn)}
                  onClick={() => toggleGroup(group.id)}
                >
                  {active ? <IconCheck size={10} /> : null}
                  {group.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 角色卡字段 */}
      {card.kind === 'character' ? (() => {
        const char = card as CharacterComponent
        const updatePayload = (patch: Partial<CharacterComponent['payload']>) =>
          onChange({ ...char, payload: { ...char.payload, ...patch } })
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

      {/* 世界卡字段 + 蓝灯常驻/绿灯关键词解释弹窗 */}
      {card.kind === 'world' ? (() => {
        const world = card as WorldComponent
        const updatePayload = (patch: Partial<WorldComponent['payload']>) =>
          onChange({ ...world, payload: { ...world.payload, ...patch } })
        const updateEntry = (entryId: string, patch: Partial<WorldEntry>) => {
          updatePayload({
            entries: world.payload.entries.map((e) =>
              e.id === entryId ? { ...e, ...patch } : e
            ),
          })
        }
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={styles.label}>
                  世界观条目（共 {world.payload.entries.length} 条）
                </span>
                <button
                  type="button"
                  className={clsx(styles.helpBtn, lightHelpOpen && styles.helpBtnActive)}
                  title="查看蓝灯常驻与绿灯关键词的区别"
                  aria-label="蓝灯和绿灯说明"
                  onClick={() => setLightHelpOpen((v) => !v)}
                >
                  <IconHelpCircle size={13} />
                </button>
              </div>
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

            {lightHelpOpen ? (
              <div className={styles.helpBox} role="note">
                <div className={styles.helpBoxHeader}>
                  <span>蓝灯常驻 vs 绿灯关键词 说明</span>
                  <button
                    type="button"
                    className={styles.searchClear}
                    style={{ position: 'static' }}
                    aria-label="收起说明"
                    onClick={() => setLightHelpOpen(false)}
                  >
                    <IconClose size={13} />
                  </button>
                </div>
                <div>
                  <span className={styles.helpDotBlue}>● 蓝灯常驻</span>
                  ：无论聊天提到什么，这条设定<strong>每次都会固定发给 AI</strong>，适合核心世界观、基础规则或时代背景。
                </div>
                <div>
                  <span className={styles.helpDotGreen}>● 绿灯关键词</span>
                  ：平时隐藏不占额度，<strong>只有最近对话出现你填的任意关键词时</strong>才自动触发注入，适合特定地点、NPC、道具或支线设定。
                </div>
              </div>
            ) : null}

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
                    title="点击切换：蓝灯常驻 / 绿灯关键词触发"
                    onClick={() => updateEntry(entry.id, { constant: !entry.constant })}
                  >
                    {entry.constant ? '● 蓝灯常驻' : '● 绿灯关键词'}
                  </button>
                  <button
                    type="button"
                    className={clsx(styles.helpBtn, lightHelpOpen && styles.helpBtnActive)}
                    title="蓝灯与绿灯有什么区别？"
                    aria-label="触发方式说明"
                    onClick={() => setLightHelpOpen((v) => !v)}
                  >
                    <IconHelpCircle size={13} />
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
                  placeholder="设定正文（命中关键词或蓝灯常驻时自动注入上下文）…"
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

      {/* 规则卡字段 */}
      {card.kind === 'rule' ? (() => {
        const rule = card as RuleComponent
        const updatePayload = (patch: Partial<RuleComponent['payload']>) =>
          onChange({ ...rule, payload: { ...rule.payload, ...patch } })
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
                          temperature: e.target.value === '' ? undefined : Number(e.target.value),
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
                          maxTokens: e.target.value === '' ? undefined : Number(e.target.value),
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
    </>
  )
}

const DetailSection = ({
  title,
  value,
  mono,
}: {
  title: string
  value?: string
  mono?: boolean
}) => {
  const cleaned = value?.trim()
  if (!cleaned) return null
  return (
    <section className={styles.detailSection}>
      <h4 className={styles.detailSectionTitle}>{title}</h4>
      <div className={clsx(styles.detailText, mono && styles.detailTextMono)}>{cleaned}</div>
    </section>
  )
}

const CardDetailView = ({
  card,
  groupNameOf,
}: {
  card: ComponentItem
  groupNameOf: (groupId: string) => string
}) => {
  const groupNames = (card.groups ?? []).map(groupNameOf).filter(Boolean)

  return (
    <div className={styles.detailWrap}>
      <div className={styles.detailHero}>
        {card.avatar ? (
          <img className={styles.detailAvatar} src={card.avatar} alt={card.name} />
        ) : (
          <span className={styles.detailAvatarFallback}>
            {card.kind === 'character' ? (
              <IconSparkles size={24} />
            ) : card.kind === 'world' ? (
              <IconGlobe size={24} />
            ) : (
              <IconSliders size={24} />
            )}
          </span>
        )}
        <div className={styles.detailHeroMeta}>
          <h3 className={styles.detailTitle}>{card.name}</h3>
          <div className={styles.detailBadgeRow}>
            <span className={styles.detailKindBadge}>{KIND_LABELS[card.kind]}</span>
            {groupNames.map((g) => (
              <span key={g} className={styles.detailTag}>
                分组：{g}
              </span>
            ))}
            {card.tags.map((t) => (
              <span key={t} className={styles.detailTag}>
                #{t}
              </span>
            ))}
          </div>
          {card.origin ? (
            <div className={styles.detailOrigin}>
              来源：{card.origin.providerName}
              {card.origin.creator ? ` · 作者：${card.origin.creator}` : ''}
            </div>
          ) : null}
        </div>
      </div>

      {card.kind === 'character'
        ? (() => {
            const char = card as CharacterComponent
            const p = char.payload
            const hasAny = Boolean(
              p.description.trim() ||
                p.personality.trim() ||
                p.scenario.trim() ||
                p.firstMessage.trim() ||
                p.alternateGreetings.some((g) => g.trim()) ||
                p.exampleDialogue.trim() ||
                p.creatorNotes.trim() ||
                p.systemPrompt.trim() ||
                p.postHistoryInstructions.trim()
            )
            return hasAny ? (
              <>
                <DetailSection title="角色设定（外貌、背景与说话风格）" value={p.description} />
                <DetailSection title="性格关键词" value={p.personality} />
                <DetailSection title="默认场景" value={p.scenario} />
                <DetailSection title="开场白" value={p.firstMessage} />
                {p.alternateGreetings.filter((g) => g.trim()).length > 0 ? (
                  <section className={styles.detailSection}>
                    <h4 className={styles.detailSectionTitle}>
                      备选开场白（{p.alternateGreetings.filter((g) => g.trim()).length} 条）
                    </h4>
                    <div className={styles.detailStack}>
                      {p.alternateGreetings
                        .filter((g) => g.trim())
                        .map((g, idx) => (
                          <div key={idx} className={styles.detailQuoteCard}>
                            <span className={styles.detailSubIdx}>#{idx + 2}</span>
                            <div className={styles.detailText}>{g.trim()}</div>
                          </div>
                        ))}
                    </div>
                  </section>
                ) : null}
                <DetailSection title="示例对话" value={p.exampleDialogue} mono />
                <DetailSection title="角色系统指令" value={p.systemPrompt} />
                <DetailSection title="尾部强化指令" value={p.postHistoryInstructions} />
                <DetailSection title="作者说明 / 备注" value={p.creatorNotes} />
              </>
            ) : (
              <div className={styles.detailEmpty}>
                当前暂未填写设定内容。你可以点击上方「编辑」补充角色人设、开场白或更换头像。
              </div>
            )
          })()
        : null}

      {card.kind === 'world'
        ? (() => {
            const world = card as WorldComponent
            const entries = world.payload.entries
            return (
              <>
                <DetailSection title="世界观背景说明" value={world.payload.description} />
                <section className={styles.detailSection}>
                  <h4 className={styles.detailSectionTitle}>设定条目（共 {entries.length} 条）</h4>
                  {entries.length === 0 ? (
                    <div className={styles.detailEmpty}>暂无条目，点击上方「编辑」添加世界观设定。</div>
                  ) : (
                    <div className={styles.detailStack}>
                      {entries.map((entry) => (
                        <div key={entry.id} className={styles.detailEntryCard}>
                          <div className={styles.detailEntryHead}>
                            <strong>{entry.name}</strong>
                            <span
                              className={clsx(
                                styles.detailLightBadge,
                                entry.constant ? styles.detailLightBlue : styles.detailLightGreen
                              )}
                            >
                              {entry.constant ? '蓝灯常驻' : '绿灯关键词'}
                            </span>
                          </div>
                          {!entry.constant && entry.keys.length > 0 ? (
                            <div className={styles.detailBadgeRow}>
                              {entry.keys.map((k) => (
                                <span key={k} className={styles.detailTag}>
                                  {k}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {entry.content.trim() ? (
                            <div className={styles.detailText}>{entry.content.trim()}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )
          })()
        : null}

      {card.kind === 'rule'
        ? (() => {
            const rule = card as RuleComponent
            const p = rule.payload
            const hasSampling =
              typeof p.temperature === 'number' ||
              typeof p.topP === 'number' ||
              typeof p.maxTokens === 'number' ||
              typeof p.maxContextTokens === 'number'
            return (
              <>
                <DetailSection title="规则说明" value={p.description} />
                <DetailSection title="系统预设指令（System Prompt）" value={p.systemPrompt} />
                <DetailSection
                  title="对话末尾强化指令（Post-History）"
                  value={p.postHistoryInstructions}
                />
                {hasSampling ? (
                  <section className={styles.detailSection}>
                    <h4 className={styles.detailSectionTitle}>采样与窗口参数</h4>
                    <div className={styles.detailBadgeRow}>
                      {typeof p.temperature === 'number' ? (
                        <span className={styles.detailTag}>Temperature: {p.temperature}</span>
                      ) : null}
                      {typeof p.topP === 'number' ? (
                        <span className={styles.detailTag}>Top P: {p.topP}</span>
                      ) : null}
                      {typeof p.maxTokens === 'number' ? (
                        <span className={styles.detailTag}>最大回复: {p.maxTokens} tok</span>
                      ) : null}
                      {typeof p.maxContextTokens === 'number' ? (
                        <span className={styles.detailTag}>上下文上限: {p.maxContextTokens} tok</span>
                      ) : null}
                    </div>
                  </section>
                ) : null}
              </>
            )
          })()
        : null}
    </div>
  )
}

export const LibraryModal = () => {
  const open = useAppStore((s) => s.libraryOpen)
  const initialTab = useAppStore((s) => s.libraryInitialTab)
  const editingId = useAppStore((s) => s.libraryEditingId)
  const creatingKind = useAppStore((s) => s.libraryCreatingKind)
  const closeLibrary = useAppStore((s) => s.closeLibrary)

  const components = useAppStore((s) => s.components)
  const upsertComponent = useAppStore((s) => s.upsertComponent)
  const deleteComponent = useAppStore((s) => s.deleteComponent)
  const importFiles = useAppStore((s) => s.importFiles)
  const showToast = useAppStore((s) => s.showToast)

  const [viewMode, setViewMode] = useState<LibraryViewMode>('list')
  const [tab, setTab] = useState<LibraryKind | 'all'>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftCard, setDraftCard] = useState<ComponentItem | null>(null)
  const [groups, setGroups] = useState<MarketGroup[]>([])
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [dragging, setDragging] = useState(false)

  const importInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const nextTab = initialTab === 'persona' ? 'all' : initialTab
    setTab(nextTab)
    setGroups(listMarketGroups())
    setGroupFilter('all')
    setCreatingGroup(false)
    setNewGroupName('')
    setSearchOpen(false)
    setQuery('')

    if (creatingKind) {
      setDraftCard(buildDraftCard(creatingKind))
      setSelectedId(null)
      setViewMode('create')
    } else if (editingId && components.some((c) => c.id === editingId && c.kind !== 'persona')) {
      setSelectedId(editingId)
      setDraftCard(null)
      setViewMode('detail')
    } else {
      setSelectedId(null)
      setDraftCard(null)
      setViewMode('list')
    }
  }, [open, initialTab, editingId, creatingKind])

  useEffect(() => {
    if (searchOpen && open && viewMode === 'list') {
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [searchOpen, open, viewMode])

  if (!open) return null

  const normalizedQuery = searchOpen ? query.trim().toLowerCase() : ''
  const filtered = components.filter((c) => {
    if (c.kind === 'persona') return false
    if (tab !== 'all' && c.kind !== tab) return false
    if (groupFilter !== 'all' && !(c.groups ?? []).includes(groupFilter)) return false
    if (normalizedQuery && !c.name.toLowerCase().includes(normalizedQuery)) return false
    return true
  })

  const selected = components.find((c) => c.id === selectedId && c.kind !== 'persona') ?? null
  const groupNameOf = (groupId: string) =>
    groups.find((group) => group.id === groupId)?.name ?? ''

  const openCreateView = (preferredKind?: LibraryKind) => {
    const kind = preferredKind ?? (tab === 'all' ? 'character' : tab)
    setDraftCard(buildDraftCard(kind))
    setSelectedId(null)
    setViewMode('create')
  }

  const openDetailView = (item: ComponentItem) => {
    setSelectedId(item.id)
    setDraftCard(null)
    setViewMode('detail')
  }

  const openEditView = (item: ComponentItem) => {
    setSelectedId(item.id)
    setDraftCard(null)
    setViewMode('edit')
  }

  const handleSaveCreate = async () => {
    if (!draftCard) return
    const trimmedName = draftCard.name.trim()
    if (!trimmedName) {
      showToast('请输入卡牌名称', 'info')
      return
    }
    const finalCard: ComponentItem = { ...draftCard, name: trimmedName }
    await upsertComponent(finalCard)
    setTab(finalCard.kind as LibraryKind)
    setDraftCard(null)
    setSelectedId(finalCard.id)
    setViewMode('list')
    showToast(`已创建${KIND_LABELS[finalCard.kind]}「${finalCard.name}」`, 'success')
  }

  const switchCreateKind = (nextKind: LibraryKind) => {
    if (!draftCard || draftCard.kind === nextKind) return
    const isDefaultTitle =
      draftCard.name === '新角色' || draftCard.name === '新世界卡' || draftCard.name === '新规则卡'
    setDraftCard(buildDraftCard(nextKind, isDefaultTitle ? undefined : draftCard.name, draftCard.groups))
  }

  const patchEditedCard = (next: ComponentItem) => {
    if (!selected) return
    // 同来源分组同步逻辑保留
    if (selected.origin && next.groups !== selected.groups) {
      const origin = selected.origin
      for (const component of components) {
        if (component.id === selected.id) continue
        if (
          component.origin?.providerId === origin.providerId &&
          component.origin.listingId === origin.listingId
        ) {
          void upsertComponent({ ...component, groups: next.groups })
        }
      }
    }
    void upsertComponent(next)
  }

  const handleCreateGroup = (event: FormEvent) => {
    event.preventDefault()
    const created = createMarketGroup(newGroupName)
    if (!created) {
      showToast('请输入分组名称', 'info')
      return
    }
    setGroups(listMarketGroups())
    setNewGroupName('')
    setCreatingGroup(false)
    setGroupFilter('all')
    showToast(`已创建分组「${created.name}」`, 'success')
  }

  const handleDeleteGroup = (group: MarketGroup) => {
    if (!window.confirm(`删除分组「${group.name}」？卡牌本身不会被删除。`)) return
    deleteMarketGroup(group.id)
    setGroups(listMarketGroups())
    if (groupFilter === group.id) setGroupFilter('all')
    for (const component of components) {
      if (!(component.groups ?? []).includes(group.id)) continue
      void upsertComponent({
        ...component,
        groups: (component.groups ?? []).filter((id) => id !== group.id),
      })
    }
  }

  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    await importFiles(files)
    setTab('all')
    setGroupFilter('all')
    setViewMode('list')
  }

  const handleUploadAvatar = (
    file: File,
    target: ComponentItem,
    apply: (next: ComponentItem) => void
  ) => {
    void resizeImageFileToAvatarDataUrl(file)
      .then((dataUrl) => {
        apply({ ...target, avatar: dataUrl })
      })
      .catch(() => {
        showToast('读取图片失败，请换一张图片重试', 'error')
      })
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
      title="卡牌库"
      size="lg"
      onClose={closeLibrary}
      headerExtra={
        viewMode === 'list' ? (
          <>
            <button
              type="button"
              className={styles.btn}
              onClick={() => importInputRef.current?.click()}
            >
              <IconUpload size={14} />
              <span>导入</span>
            </button>
            <button
              type="button"
              className={clsx(styles.btn, styles.btnPrimary)}
              onClick={() => openCreateView()}
            >
              <IconPlus size={14} />
              <span>创建卡牌</span>
            </button>
          </>
        ) : null
      }
    >
      <input
        ref={importInputRef}
        type="file"
        multiple
        accept=".png,.json,.jsonl,.charx,.zip,.lorebook,.card"
        style={{ display: 'none' }}
        onChange={async (e) => {
          if (e.target.files && e.target.files.length > 0) {
            await handleImport(e.target.files)
            e.target.value = ''
          }
        }}
      />

      <div
        className={clsx(styles.shell, dragging && styles.shellDragging)}
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false)
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (event.dataTransfer.files.length > 0) void handleImport(event.dataTransfer.files)
        }}
      >
        {viewMode === 'list' ? (
          <>
            <div className={styles.listTop}>
              <div className={styles.tabsBar}>
                <div className={styles.tabs}>
                  {(['all', 'character', 'world', 'rule'] as const).map((k) => (
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
                <button
                  type="button"
                  className={clsx(styles.iconBtn, searchOpen && styles.iconBtnActive)}
                  title={searchOpen ? '收起搜索' : '搜索卡牌'}
                  aria-label="搜索卡牌"
                  onClick={() => {
                    if (searchOpen) setQuery('')
                    setSearchOpen(!searchOpen)
                  }}
                >
                  <IconSearch size={15} />
                </button>
              </div>

              {searchOpen ? (
                <div className={styles.searchWrap}>
                  <span className={styles.searchIcon}>
                    <IconSearch size={14} />
                  </span>
                  <input
                    ref={searchInputRef}
                    className={styles.searchInput}
                    placeholder="搜索卡牌名称…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setQuery('')
                        setSearchOpen(false)
                      }
                    }}
                  />
                  {query ? (
                    <button
                      type="button"
                      className={styles.searchClear}
                      aria-label="清除搜索"
                      onClick={() => setQuery('')}
                    >
                      <IconClose size={12} />
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className={styles.groupRow}>
                <button
                  type="button"
                  className={clsx(
                    styles.groupChip,
                    groupFilter === 'all' && styles.groupChipActive
                  )}
                  onClick={() => setGroupFilter('all')}
                >
                  全部
                </button>
                {groups.map((group) => (
                  <span
                    key={group.id}
                    className={clsx(
                      styles.groupPill,
                      groupFilter === group.id && styles.groupPillActive
                    )}
                  >
                    <button
                      type="button"
                      className={styles.groupName}
                      onClick={() => setGroupFilter(group.id)}
                      title={`只看「${group.name}」`}
                    >
                      {group.name}
                    </button>
                    {groupFilter === group.id ? (
                      <button
                        type="button"
                        className={styles.groupDelete}
                        title="删除分组"
                        aria-label={`删除分组 ${group.name}`}
                        onClick={() => handleDeleteGroup(group)}
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                {creatingGroup ? (
                  <form className={styles.newGroupForm} onSubmit={handleCreateGroup}>
                    <input
                      autoFocus
                      value={newGroupName}
                      maxLength={40}
                      placeholder="分组名称"
                      onChange={(event) => setNewGroupName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setCreatingGroup(false)
                          setNewGroupName('')
                        }
                      }}
                    />
                    <button type="submit" className={styles.newGroupSave}>
                      创建
                    </button>
                    <button
                      type="button"
                      className={styles.newGroupCancel}
                      onClick={() => {
                        setCreatingGroup(false)
                        setNewGroupName('')
                      }}
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className={styles.newGroupBtn}
                    onClick={() => setCreatingGroup(true)}
                  >
                    <IconPlus size={12} /> 新建分组
                  </button>
                )}
              </div>
            </div>

            <div className={styles.listBody}>
              {filtered.length === 0 ? (
                <div className={styles.emptyList}>
                  <div>
                    {normalizedQuery
                      ? `没有找到名称包含「${query.trim()}」的卡牌。`
                      : groupFilter !== 'all'
                        ? '这个分组下还没有卡牌。'
                        : '暂无卡牌，点击右上角「创建卡牌」或直接导入酒馆 PNG / JSON。'}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button
                      type="button"
                      className={clsx(styles.btn, styles.btnPrimary)}
                      onClick={() => openCreateView()}
                    >
                      <IconPlus size={14} />
                      <span>创建卡牌</span>
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => importInputRef.current?.click()}
                    >
                      <IconUpload size={14} />
                      <span>导入酒馆文件</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.grid}>
                  {filtered.map((item) => (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      className={clsx(styles.card, styles.cardClickable)}
                      onClick={() => openDetailView(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openDetailView(item)
                        }
                      }}
                    >
                      {item.avatar ? (
                        <img className={styles.avatar} src={item.avatar} alt="" />
                      ) : (
                        <span className={styles.avatar}>
                          {item.kind === 'character' ? (
                            <IconSparkles size={17} />
                          ) : item.kind === 'world' ? (
                            <IconGlobe size={17} />
                          ) : (
                            <IconSliders size={17} />
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
                          {(item.groups ?? []).length > 0
                            ? ` · ${(item.groups ?? [])
                                .map(groupNameOf)
                                .filter(Boolean)
                                .join(' / ')}`
                            : ''}
                        </div>
                      </div>
                      <span className={styles.detailCue}>
                        <span>详情</span>
                        <IconChevronRight size={13} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : viewMode === 'create' && draftCard ? (
          <>
            <div className={styles.editorBar}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  className={styles.backBtn}
                  onClick={() => {
                    setDraftCard(null)
                    setViewMode('list')
                  }}
                >
                  <IconArrowLeft size={14} />
                  <span>返回</span>
                </button>
                <span className={styles.editorTitle}>创建新卡牌</span>
              </div>
              <div className={styles.editorActions}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => {
                    setDraftCard(null)
                    setViewMode('list')
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={clsx(styles.btn, styles.btnAccent)}
                  onClick={() => void handleSaveCreate()}
                >
                  <IconCheck size={14} />
                  <span>保存创建</span>
                </button>
              </div>
            </div>

            <div className={styles.editor}>
              <div className={styles.typePicker}>
                <span className={styles.label}>选择卡牌类型</span>
                <div className={styles.typePills}>
                  {LIBRARY_KINDS.map((opt) => (
                    <button
                      key={opt.kind}
                      type="button"
                      className={clsx(
                        styles.typePill,
                        draftCard.kind === opt.kind && styles.typePillActive
                      )}
                      onClick={() => switchCreateKind(opt.kind)}
                    >
                      {opt.kind === 'character' ? (
                        <IconSparkles size={14} />
                      ) : opt.kind === 'world' ? (
                        <IconGlobe size={14} />
                      ) : (
                        <IconSliders size={14} />
                      )}
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <CardFormFields
                card={draftCard}
                groups={groups}
                onChange={setDraftCard}
                onUploadAvatar={(file) => handleUploadAvatar(file, draftCard, setDraftCard)}
              />
            </div>
          </>
        ) : viewMode === 'detail' && selected ? (
          <>
            <div className={styles.editorBar}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  className={styles.backBtn}
                  onClick={() => {
                    setSelectedId(null)
                    setViewMode('list')
                  }}
                >
                  <IconArrowLeft size={14} />
                  <span>返回卡牌库</span>
                </button>
                <span className={styles.editorTitle}>{KIND_LABELS[selected.kind]}详情</span>
              </div>
              <div className={styles.editorActions}>
                <button
                  type="button"
                  className={clsx(styles.btn, styles.btnPrimary)}
                  onClick={() => openEditView(selected)}
                >
                  <IconEdit size={14} />
                  <span>编辑</span>
                </button>
                {selected.kind === 'character' || selected.kind === 'world' ? (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void handleExportCard(selected)}
                  >
                    <IconDownload size={14} />
                    <span>{selected.kind === 'character' ? '导出 PNG' : '导出 JSON'}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={clsx(styles.btn, styles.btnDanger)}
                  onClick={() => {
                    if (window.confirm(`确定删除「${selected.name}」吗？`)) {
                      const delId = selected.id
                      setSelectedId(null)
                      setViewMode('list')
                      void deleteComponent(delId)
                    }
                  }}
                >
                  <IconTrash size={14} />
                  <span>删除</span>
                </button>
              </div>
            </div>

            <div className={styles.editor}>
              <CardDetailView card={selected} groupNameOf={groupNameOf} />
            </div>
          </>
        ) : selected ? (
          <>
            <div className={styles.editorBar}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  className={styles.backBtn}
                  onClick={() => setViewMode('detail')}
                >
                  <IconArrowLeft size={14} />
                  <span>返回详情</span>
                </button>
                <span className={styles.editorTitle}>编辑{KIND_LABELS[selected.kind]}</span>
              </div>
              <div className={styles.editorActions}>
                <button
                  type="button"
                  className={clsx(styles.btn, styles.btnAccent)}
                  onClick={() => setViewMode('detail')}
                >
                  <IconCheck size={14} />
                  <span>完成</span>
                </button>
                {selected.kind === 'character' || selected.kind === 'world' ? (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void handleExportCard(selected)}
                  >
                    <IconDownload size={14} />
                    <span>{selected.kind === 'character' ? '导出 PNG' : '导出 JSON'}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={clsx(styles.btn, styles.btnDanger)}
                  onClick={() => {
                    if (window.confirm(`确定删除「${selected.name}」吗？`)) {
                      const delId = selected.id
                      setSelectedId(null)
                      setViewMode('list')
                      void deleteComponent(delId)
                    }
                  }}
                >
                  <IconTrash size={14} />
                  <span>删除</span>
                </button>
              </div>
            </div>

            <div className={styles.editor}>
              <CardFormFields
                card={selected}
                groups={groups}
                onChange={patchEditedCard}
                onUploadAvatar={(file) => handleUploadAvatar(file, selected, patchEditedCard)}
              />
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
