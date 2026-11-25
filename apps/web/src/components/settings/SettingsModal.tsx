import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  dismissIosTip,
  getIosInstallContext,
  getLastBackupTime,
  isIosTipDismissed,
  recordLastBackupTime,
} from '../../app/pwaInstall.ts'
import { fetchProviderModels } from '../../services/llm/client.ts'
import {
  getActiveProvider,
  PROVIDER_TEMPLATES,
  useSettings,
  type ProviderConfig,
  type ProviderFormat,
  type ThemeMode,
} from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  CURRENT_ANDROID_VERSION_CODE,
  CURRENT_APP_VERSION,
  useUpdaterStore,
} from '../../services/updater.ts'
import { saveFileBlob } from '../../utils/fileSave.ts'
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './SettingsModal.module.css'

type SettingsTab = 'service' | 'general' | 'data' | 'update'

type PillMenuState = {
  provider: ProviderConfig
  x: number
  y: number
}

const CONTEXT_TIERS = [
  { tokens: 8192, label: '紧凑', approx: '约 1 万字' },
  { tokens: 32768, label: '标准（推荐）', approx: '约 4 万字' },
  { tokens: 65536, label: '长篇', approx: '约 8 万字' },
  { tokens: 131072, label: '超长', approx: '约 16 万字' },
] as const

const REPLY_TIERS = [
  { tokens: 1024, label: '简短', approx: '约 1300 字' },
  { tokens: 2048, label: '适中（推荐）', approx: '约 2600 字' },
  { tokens: 4096, label: '详尽', approx: '约 5200 字' },
  { tokens: 8192, label: '长文', approx: '约 1 万字' },
] as const

function formatApproxChineseChars(tokens: number): string {
  const chars = Math.round(tokens * 1.25)
  if (chars >= 10000) return `约 ${(chars / 10000).toFixed(1).replace(/\.0$/, '')} 万字`
  return `约 ${chars} 字`
}

function getKeyGuide(provider: ProviderConfig): { hint: string; linkUrl?: string; linkText?: string } {
  const url = provider.baseUrl.toLowerCase()
  if (url.includes('deepseek.com')) {
    return {
      hint: '推荐使用 DeepSeek 官方 Key，仅保存在你的本机。',
      linkUrl: 'https://platform.deepseek.com/api_keys',
      linkText: '前往申请 Key →',
    }
  }
  if (url.includes('siliconflow.cn')) {
    return {
      hint: '支持国内直连低延迟，Key 仅保存在你的本机。',
      linkUrl: 'https://cloud.siliconflow.cn/account/ak',
      linkText: '前往获取 Key →',
    }
  }
  if (url.includes('openrouter.ai')) {
    return {
      hint: '聚合多家大模型，Key 仅保存在你的本机。',
      linkUrl: 'https://openrouter.ai/keys',
      linkText: '前往获取 Key →',
    }
  }
  if (provider.format === 'ollama') {
    return { hint: '本地模型服务一般无需填写 API Key。' }
  }
  if (provider.isRelay || provider.id.startsWith('prov_relay')) {
    return { hint: '填写中转站后台签发的令牌 Key（通常以 sk- 开头），仅保存在本机。' }
  }
  return { hint: '需在对应服务商后台创建 API Key，仅保存在本机。' }
}

function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '••••••••'
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`
}

export const SettingsModal = () => {
  const open = useAppStore((s) => s.settingsOpen)
  const setOpen = useAppStore((s) => s.setSettingsOpen)
  const importFiles = useAppStore((s) => s.importFiles)
  const exportFullBackupJson = useAppStore((s) => s.exportFullBackupJson)
  const clearAllLocalData = useAppStore((s) => s.clearAllLocalData)
  const showToast = useAppStore((s) => s.showToast)

  const settings = useSettings()
  const active = getActiveProvider(settings)

  const [tab, setTab] = useState<SettingsTab>('service')
  const [fetchingModels, setFetchingModels] = useState(false)
  const [addingServiceOpen, setAddingServiceOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customModelOpen, setCustomModelOpen] = useState(false)
  const [editingKey, setEditingKey] = useState(() => !active.apiKey.trim())
  const [keyDraft, setKeyDraft] = useState(active.apiKey)
  const [customContextOpen, setCustomContextOpen] = useState(
    () => !CONTEXT_TIERS.some((t) => t.tokens === settings.defaultMaxContextTokens)
  )
  const [customReplyOpen, setCustomReplyOpen] = useState(
    () => !REPLY_TIERS.some((t) => t.tokens === settings.defaultMaxResponseTokens)
  )
  const [iosTipDismissed, setIosTipDismissed] = useState(() => isIosTipDismissed())
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(() => getLastBackupTime())
  const [pillMenu, setPillMenu] = useState<PillMenuState | null>(null)
  const checkingUpdate = useUpdaterStore((s) => s.checking)
  const availableUpdate = useUpdaterStore((s) => s.availableUpdate)
  const updateError = useUpdaterStore((s) => s.lastError)
  const openUpdatePrompt = useUpdaterStore((s) => s.openPrompt)
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates)
  const fileRef = useRef<HTMLInputElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null)
  const longPressTriggeredRef = useRef(false)

  useEffect(() => {
    setKeyDraft(active.apiKey)
    setEditingKey(!active.apiKey.trim())
    setCustomModelOpen(false)
  }, [active.id, active.apiKey])

  useEffect(() => {
    if (!open) {
      setPillMenu(null)
    }
  }, [open])

  useEffect(() => {
    if (!pillMenu) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPillMenu(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [pillMenu])

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current)
      }
    },
    []
  )

  if (!open) return null

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    pressOriginRef.current = null
  }

  const openPillMenuAt = (provider: ProviderConfig, clientX: number, clientY: number) => {
    const x = Math.min(Math.max(12, clientX), Math.max(12, window.innerWidth - 204))
    const y = Math.min(Math.max(12, clientY), Math.max(12, window.innerHeight - 170))
    setPillMenu({ provider, x, y })
  }

  const handleDeleteProvider = (provider: ProviderConfig) => {
    if (settings.providers.length <= 1) {
      showToast('至少保留一个模型服务配置', 'info')
      return
    }
    settings.deleteProvider(provider.id)
    setPillMenu(null)
    showToast(`已删除「${provider.name}」`, 'success')
  }

  const iosContext = getIosInstallContext()
  const needsBackupReminder =
    lastBackupAt === null || Date.now() - lastBackupAt > 7 * 24 * 60 * 60 * 1000
  const keyGuide = getKeyGuide(active)
  const showRelayUrlUpfront = Boolean(
    active.isRelay ||
      active.format === 'ollama' ||
      active.id.startsWith('prov_relay') ||
      active.id.startsWith('prov_openai') ||
      !active.baseUrl.trim()
  )
  const contextMatchedTier = CONTEXT_TIERS.some(
    (t) => t.tokens === settings.defaultMaxContextTokens
  )
  const replyMatchedTier = REPLY_TIERS.some(
    (t) => t.tokens === settings.defaultMaxResponseTokens
  )
  const modelChips = Array.from(new Set([active.model, ...active.models].filter(Boolean))).slice(
    0,
    18
  )

  const updateActive = (patch: Partial<ProviderConfig>) => {
    settings.upsertProvider({ ...active, ...patch })
  }

  const commitKeyDraft = () => {
    const cleaned = keyDraft.trim()
    updateActive({ apiKey: cleaned })
    if (cleaned) {
      setEditingKey(false)
      showToast('API Key 已保存到本机', 'success')
    }
  }

  const addFromTemplate = (tplKey: string) => {
    const tpl = PROVIDER_TEMPLATES.find((t) => t.key === tplKey)
    if (!tpl) return
    const next: ProviderConfig = {
      id: `prov_${tpl.key}_${Date.now().toString(36)}`,
      name: tpl.name,
      format: tpl.format,
      baseUrl: tpl.baseUrl,
      isRelay: tpl.isRelay,
      apiKey: '',
      model: tpl.defaultModel,
      models: [...tpl.models],
    }
    settings.upsertProvider(next)
    setAddingServiceOpen(false)
    showToast(`已切换到新增的「${tpl.name}」`, 'success')
  }

  const handleFetchModels = async () => {
    const candidateKey = editingKey ? keyDraft.trim() : active.apiKey.trim()
    const targetProvider =
      candidateKey !== active.apiKey ? { ...active, apiKey: candidateKey } : active
    if (targetProvider.format !== 'ollama' && !targetProvider.apiKey.trim()) {
      showToast('请先填写 API Key，再刷新模型列表', 'info')
      return
    }
    if (candidateKey !== active.apiKey) {
      updateActive({ apiKey: candidateKey })
      setEditingKey(false)
    }
    setFetchingModels(true)
    try {
      const models = await fetchProviderModels(targetProvider, settings.customGatewayOrigin)
      if (models.length === 0) {
        showToast('连接成功，但接口未返回可选模型', 'info')
      } else {
        updateActive({
          apiKey: targetProvider.apiKey,
          models,
          model: models.includes(targetProvider.model) ? targetProvider.model : models[0]!,
        })
        showToast(`已获取 ${models.length} 个可用模型`, 'success')
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const message = /401|authentication|api key/i.test(raw)
        ? 'API Key 无效或未填写，请检查后重试'
        : raw
      showToast(`刷新模型失败：${message}`, 'error')
    } finally {
      setFetchingModels(false)
    }
  }

  const handleExportBackup = async () => {
    const json = await exportFullBackupJson()
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
    const res = await saveFileBlob(
      blob,
      `tavernchat-backup-${new Date().toISOString().slice(0, 10)}.json`
    )
    if (res !== 'cancelled') {
      recordLastBackupTime()
      setLastBackupAt(Date.now())
      showToast(res === 'shared' ? '已调起系统分享保存备份' : '已导出全量本地备份', 'success')
    }
  }

  return (
    <Modal open={open} title="设置" size="md" onClose={() => setOpen(false)}>
      <div className={styles.shell}>
        <nav className={styles.nav}>
          <button
            type="button"
            className={clsx(styles.navBtn, tab === 'service' && styles.navActive)}
            onClick={() => setTab('service')}
          >
            模型服务
          </button>
          <button
            type="button"
            className={clsx(styles.navBtn, tab === 'general' && styles.navActive)}
            onClick={() => setTab('general')}
          >
            通用偏好
          </button>
          <button
            type="button"
            className={clsx(styles.navBtn, tab === 'data' && styles.navActive)}
            onClick={() => setTab('data')}
          >
            数据与导入
          </button>
          <button
            type="button"
            className={clsx(styles.navBtn, tab === 'update' && styles.navActive)}
            onClick={() => setTab('update')}
          >
            <span>检查更新</span>
            {availableUpdate ? <span className={styles.navDot} aria-label="有新版本" /> : null}
          </button>
        </nav>

        <div className={styles.content}>
          {tab === 'service' ? (
            <>
              <div className={styles.providerHeader}>
                <div className={styles.providerPills}>
                  {settings.providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      title={settings.providers.length > 1 ? '点击切换，长按或右键可管理/删除' : p.name}
                      className={clsx(styles.pill, p.id === active.id && styles.pillActive)}
                      onPointerDown={(e) => {
                        if (e.button !== 0 && e.pointerType === 'mouse') return
                        longPressTriggeredRef.current = false
                        clearLongPress()
                        pressOriginRef.current = { x: e.clientX, y: e.clientY }
                        longPressTimerRef.current = window.setTimeout(() => {
                          longPressTriggeredRef.current = true
                          openPillMenuAt(p, e.clientX, e.clientY)
                        }, 450)
                      }}
                      onPointerMove={(e) => {
                        if (!pressOriginRef.current || longPressTimerRef.current === null) return
                        const dx = Math.abs(e.clientX - pressOriginRef.current.x)
                        const dy = Math.abs(e.clientY - pressOriginRef.current.y)
                        if (dx > 8 || dy > 8) {
                          clearLongPress()
                        }
                      }}
                      onPointerUp={() => clearLongPress()}
                      onPointerCancel={() => clearLongPress()}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        clearLongPress()
                        openPillMenuAt(p, e.clientX, e.clientY)
                      }}
                      onClick={() => {
                        if (longPressTriggeredRef.current) {
                          longPressTriggeredRef.current = false
                          return
                        }
                        settings.setActiveProvider(p.id)
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={clsx(
                      styles.addServiceBtn,
                      addingServiceOpen && styles.addServiceBtnOpen
                    )}
                    onClick={() => setAddingServiceOpen((prev) => !prev)}
                  >
                    <IconPlus size={13} />
                    <span>添加其他服务</span>
                  </button>
                </div>
                {settings.providers.length > 1 ? (
                  <div className={styles.hint}>提示：长按或右键上方服务标签可快速删除或重命名</div>
                ) : null}

                {addingServiceOpen ? (
                  <div className={styles.presetGrid}>
                    {PROVIDER_TEMPLATES.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        className={styles.presetCard}
                        onClick={() => addFromTemplate(t.key)}
                      >
                        <div className={styles.presetName}>{t.name}</div>
                        <div className={styles.presetHint}>{t.hint}</div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className={styles.card}>
                <div className={styles.cardTopRow}>
                  <div>
                    <div className={styles.cardTitle}>{active.name}</div>
                    <div className={styles.hint}>
                      {showRelayUrlUpfront
                        ? '填写中转站地址与令牌 Key，刷新模型后即可对话'
                        : '填入 API Key 并点选模型即可开始对话'}
                    </div>
                  </div>
                  {settings.providers.length > 1 ? (
                    <button
                      type="button"
                      className={styles.iconDeleteBtn}
                      title="删除此服务"
                      aria-label="删除此服务"
                      onClick={() => handleDeleteProvider(active)}
                    >
                      <IconTrash size={14} />
                      <span>删除</span>
                    </button>
                  ) : null}
                </div>

                {showRelayUrlUpfront ? (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>
                        {active.format === 'ollama' ? 'Ollama 服务地址' : '中转站 / 接口地址（Base URL）'}
                      </label>
                      <input
                        className={styles.input}
                        placeholder={
                          active.format === 'ollama'
                            ? 'http://127.0.0.1:11434'
                            : '例如 https://api.your-relay.com/v1'
                        }
                        value={active.baseUrl}
                        onChange={(e) => updateActive({ baseUrl: e.target.value })}
                      />
                      <span className={styles.hint}>
                        {active.format === 'ollama'
                          ? '填本机或局域网 Ollama 地址，无需带 /api 后缀。'
                          : '支持 OneAPI / NewAPI / 各类兼容中转站，通常填到 /v1（误贴了 /v1/chat/completions 也会自动兼容）。'}
                      </span>
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>中转协议格式</label>
                      <div className={styles.tierGrid}>
                        {(
                          [
                            { id: 'openai', label: 'OpenAI 兼容（常用中转）' },
                            { id: 'anthropic', label: 'Claude 协议' },
                            { id: 'ollama', label: '本地 Ollama' },
                          ] as Array<{ id: ProviderFormat; label: string }>
                        ).map((fmt) => (
                          <button
                            key={fmt.id}
                            type="button"
                            className={clsx(
                              styles.tierBtn,
                              active.format === fmt.id && styles.tierBtnActive
                            )}
                            onClick={() => updateActive({ format: fmt.id })}
                          >
                            <span className={styles.tierTitle}>{fmt.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                <div className={styles.field}>
                  <label className={styles.label}>API Key</label>
                  {active.apiKey.trim() && !editingKey ? (
                    <div className={styles.keySavedRow}>
                      <span className={styles.keyMask}>{maskApiKey(active.apiKey)}</span>
                      <button
                        type="button"
                        className={styles.inlineActionBtn}
                        onClick={() => {
                          setKeyDraft(active.apiKey)
                          setEditingKey(true)
                        }}
                      >
                        <IconEdit size={13} />
                        <span>修改</span>
                      </button>
                    </div>
                  ) : (
                    <div className={styles.keyInputShell}>
                      <input
                        className={styles.keyInputInner}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={
                          active.format === 'ollama' ? '本地运行可留空' : '粘贴 API Key（sk-...）'
                        }
                        value={keyDraft}
                        onChange={(e) => {
                          setKeyDraft(e.target.value)
                          if (active.format === 'ollama' || e.target.value.trim() === '') {
                            updateActive({ apiKey: e.target.value.trim() })
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            commitKeyDraft()
                          }
                        }}
                      />
                      {keyDraft.trim() ? (
                        <button
                          type="button"
                          className={styles.confirmKeyBtn}
                          onClick={commitKeyDraft}
                        >
                          <IconCheck size={13} />
                          <span>确定</span>
                        </button>
                      ) : null}
                    </div>
                  )}
                  <div className={styles.guideFooter}>
                    <span className={styles.hint}>{keyGuide.hint}</span>
                    {keyGuide.linkUrl ? (
                      <a
                        className={styles.guideLink}
                        href={keyGuide.linkUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {keyGuide.linkText}
                      </a>
                    ) : null}
                  </div>
                </div>

                <div className={styles.field}>
                  <div className={styles.labelRow}>
                    <label className={styles.label}>选择模型</label>
                    <div className={styles.labelActions}>
                      <button
                        type="button"
                        className={styles.linkAction}
                        disabled={fetchingModels}
                        onClick={() => void handleFetchModels()}
                      >
                        <IconRefresh size={12} />
                        <span>{fetchingModels ? '刷新中…' : '刷新模型列表'}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.linkAction}
                        onClick={() => setCustomModelOpen((v) => !v)}
                      >
                        {customModelOpen ? '收起手动输入' : '手动填写模型'}
                      </button>
                    </div>
                  </div>

                  {modelChips.length > 0 ? (
                    <div className={styles.modelChipGrid}>
                      {modelChips.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={clsx(
                            styles.modelChip,
                            active.model === m && styles.modelChipActive
                          )}
                          onClick={() => updateActive({ model: m })}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {customModelOpen ? (
                    <input
                      className={styles.input}
                      placeholder="输入自定义模型 ID，例如 deepseek-flash"
                      value={active.model}
                      onChange={(e) => {
                        const model = e.target.value
                        const models = active.models.includes(model)
                          ? active.models
                          : [model, ...active.models].filter(Boolean)
                        updateActive({ model, models })
                      }}
                    />
                  ) : null}
                </div>
              </div>

              <div className={styles.accordionCard}>
                <button
                  type="button"
                  className={styles.accordionTrigger}
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  <div className={styles.accordionTitleBlock}>
                    <span className={styles.cardTitle}>高级设置</span>
                    <span className={styles.hint}>
                      显示名称、接口协议与 Base URL（默认已配置好，通常无需改动）
                    </span>
                  </div>
                  <span className={styles.accordionChevron}>
                    {advancedOpen ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                  </span>
                </button>

                {advancedOpen ? (
                  <div className={styles.accordionBody}>
                    <div className={styles.field}>
                      <label className={styles.label}>显示名称</label>
                      <input
                        ref={nameInputRef}
                        className={styles.input}
                        value={active.name}
                        onChange={(e) => updateActive({ name: e.target.value })}
                      />
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>协议格式</label>
                      <div className={styles.tierGrid}>
                        {(
                          [
                            { id: 'openai', label: 'OpenAI 兼容' },
                            { id: 'anthropic', label: 'Claude 协议' },
                            { id: 'ollama', label: '本地 Ollama' },
                          ] as Array<{ id: ProviderFormat; label: string }>
                        ).map((fmt) => (
                          <button
                            key={fmt.id}
                            type="button"
                            className={clsx(
                              styles.tierBtn,
                              active.format === fmt.id && styles.tierBtnActive
                            )}
                            onClick={() => updateActive({ format: fmt.id })}
                          >
                            <span className={styles.tierTitle}>{fmt.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className={styles.field}>
                      <label className={styles.label}>接口地址（Base URL）</label>
                      <input
                        className={styles.input}
                        placeholder="https://api.deepseek.com"
                        value={active.baseUrl}
                        onChange={(e) => updateActive({ baseUrl: e.target.value })}
                      />
                    </div>

                    {settings.providers.length > 1 ? (
                      <div>
                        <button
                          type="button"
                          className={clsx(styles.btn, styles.btnDanger)}
                          onClick={() => handleDeleteProvider(active)}
                        >
                          <IconTrash size={14} />
                          <span>删除此服务</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {tab === 'general' ? (
            <>
              <div className={styles.card}>
                <div className={styles.field}>
                  <label className={styles.label}>外观主题</label>
                  <div className={styles.segmentedRow}>
                    {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={clsx(
                          styles.segmentedBtn,
                          settings.theme === mode && styles.segmentedBtnActive
                        )}
                        onClick={() => settings.setTheme(mode)}
                      >
                        {mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色' : '深色'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>对话记忆容量（每次参考的历史篇幅）</label>
                  <div className={styles.tierGrid}>
                    {CONTEXT_TIERS.map((tier) => {
                      const activeTier =
                        !customContextOpen && settings.defaultMaxContextTokens === tier.tokens
                      return (
                        <button
                          key={tier.tokens}
                          type="button"
                          className={clsx(styles.tierBtn, activeTier && styles.tierBtnActive)}
                          onClick={() => {
                            setCustomContextOpen(false)
                            settings.updateGeneral({ defaultMaxContextTokens: tier.tokens })
                          }}
                        >
                          <span className={styles.tierTitle}>{tier.label}</span>
                          <span className={styles.tierSub}>{tier.approx}</span>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      className={clsx(
                        styles.tierBtn,
                        (customContextOpen || !contextMatchedTier) && styles.tierBtnActive
                      )}
                      onClick={() => setCustomContextOpen(true)}
                    >
                      <span className={styles.tierTitle}>自定义</span>
                      <span className={styles.tierSub}>
                        {formatApproxChineseChars(settings.defaultMaxContextTokens)}
                      </span>
                    </button>
                  </div>

                  {customContextOpen || !contextMatchedTier ? (
                    <div className={styles.customInputRow}>
                      <input
                        className={styles.input}
                        type="number"
                        min={2048}
                        step={2048}
                        value={settings.defaultMaxContextTokens}
                        onChange={(e) =>
                          settings.updateGeneral({
                            defaultMaxContextTokens: Math.max(2048, Number(e.target.value) || 32768),
                          })
                        }
                      />
                      <span className={styles.hint}>
                        Token（{formatApproxChineseChars(settings.defaultMaxContextTokens)}）
                      </span>
                    </div>
                  ) : null}
                  <div className={styles.hint}>
                    超出容量时会自动先总结早期对话为长期记忆，避免角色突然失忆。
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>单次回复篇幅</label>
                  <div className={styles.tierGrid}>
                    {REPLY_TIERS.map((tier) => {
                      const activeTier =
                        !customReplyOpen && settings.defaultMaxResponseTokens === tier.tokens
                      return (
                        <button
                          key={tier.tokens}
                          type="button"
                          className={clsx(styles.tierBtn, activeTier && styles.tierBtnActive)}
                          onClick={() => {
                            setCustomReplyOpen(false)
                            settings.updateGeneral({ defaultMaxResponseTokens: tier.tokens })
                          }}
                        >
                          <span className={styles.tierTitle}>{tier.label}</span>
                          <span className={styles.tierSub}>{tier.approx}</span>
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      className={clsx(
                        styles.tierBtn,
                        (customReplyOpen || !replyMatchedTier) && styles.tierBtnActive
                      )}
                      onClick={() => setCustomReplyOpen(true)}
                    >
                      <span className={styles.tierTitle}>自定义</span>
                      <span className={styles.tierSub}>
                        {formatApproxChineseChars(settings.defaultMaxResponseTokens)}
                      </span>
                    </button>
                  </div>

                  {customReplyOpen || !replyMatchedTier ? (
                    <div className={styles.customInputRow}>
                      <input
                        className={styles.input}
                        type="number"
                        min={256}
                        step={256}
                        value={settings.defaultMaxResponseTokens}
                        onChange={(e) =>
                          settings.updateGeneral({
                            defaultMaxResponseTokens: Math.max(256, Number(e.target.value) || 2048),
                          })
                        }
                      />
                      <span className={styles.hint}>
                        Token（{formatApproxChineseChars(settings.defaultMaxResponseTokens)}）
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>长对话记忆整理</label>
                  <div className={styles.segmentedRow}>
                    {(['off', 'balanced', 'extended'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={clsx(
                          styles.segmentedBtn,
                          settings.contextCompression === mode && styles.segmentedBtnActive
                        )}
                        onClick={() => settings.updateGeneral({ contextCompression: mode })}
                      >
                        {mode === 'off' ? '关闭' : mode === 'balanced' ? '均衡（推荐）' : '长记忆'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.switchFieldRow}>
                  <span className={styles.switchFieldLabel}>
                    空对话首次选入角色卡时，自动带入角色开场白
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.autoInsertGreeting}
                    className={clsx(
                      styles.toggleSwitch,
                      settings.autoInsertGreeting && styles.toggleSwitchOn
                    )}
                    onClick={() =>
                      settings.updateGeneral({ autoInsertGreeting: !settings.autoInsertGreeting })
                    }
                  >
                    <span className={styles.toggleThumb} />
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {tab === 'update' ? (
            <>
              <div className={styles.card}>
                <div className={styles.cardTopRow}>
                  <div>
                    <div className={styles.sectionTitle}>应用版本与更新</div>
                    <div className={styles.hint}>
                      当前版本：v{CURRENT_APP_VERSION}（Build {CURRENT_ANDROID_VERSION_CODE}）
                    </div>
                  </div>
                </div>

                {availableUpdate ? (
                  <div className={styles.updateHighlight}>
                    <div className={styles.updateHighlightBody}>
                      <strong>发现新版本 v{availableUpdate.manifest.version}</strong>
                      <span className={styles.hint}>
                        {availableUpdate.viaMirror
                          ? '已通过国内镜像加速线路就绪，可直连下载安装包。'
                          : '发现新版本，点击即可查看更新日志并下载安装包。'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={clsx(styles.btn, styles.btnPrimary)}
                      onClick={() => {
                        openUpdatePrompt(availableUpdate)
                        setOpen(false)
                      }}
                    >
                      <IconDownload size={14} />
                      <span>查看详情并更新</span>
                    </button>
                  </div>
                ) : null}

                {updateError ? (
                  <div className={styles.hint}>最近一次检查遇到网络问题：{updateError}</div>
                ) : null}

                <div className={styles.row}>
                  <button
                    type="button"
                    className={clsx(styles.btn, styles.btnPrimary)}
                    disabled={checkingUpdate}
                    onClick={async () => {
                      const outcome = await checkForUpdates({ force: true, silent: false })
                      if (outcome.status === 'unconfigured') {
                        showToast('当前为测试构建版，官方发布通道接入后即可自动检查更新', 'info')
                      } else if (outcome.status === 'latest') {
                        showToast(`当前已是最新版本 v${outcome.version}`, 'success')
                      } else if (outcome.status === 'error') {
                        showToast('检查更新失败：' + outcome.message, 'error')
                      } else if (outcome.status === 'update') {
                        setOpen(false)
                      }
                    }}
                  >
                    <IconRefresh size={14} />
                    <span>{checkingUpdate ? '正在检查…' : '立即检查更新'}</span>
                  </button>
                </div>

                <div className={styles.hint}>
                  打开应用时会自动在后台检测新版本，发现更新会弹窗提醒并自动优先走国内加速下载线路。
                </div>
              </div>
            </>
          ) : null}

          {tab === 'data' ? (
            <>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept=".png,.json,.jsonl,.charx,.zip,.lorebook,.card"
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    void importFiles(e.target.files)
                    e.target.value = ''
                  }
                }}
              />

              <div className={styles.card}>
                <div className={styles.sectionTitle}>兼容导入 SillyTavern 资产</div>
                <div className={styles.hint}>
                  支持一次性多选导入酒馆 PNG 角色卡（V2/V3，自动提取内嵌世界书）、世界书 JSON、OpenAI 预设 JSON、群聊 JSON、聊天记录 JSONL，以及 TavernChat 备份包。
                </div>
                <div className={styles.row}>
                  <button
                    type="button"
                    className={clsx(styles.btn, styles.btnPrimary)}
                    onClick={() => fileRef.current?.click()}
                  >
                    <IconUpload size={14} />
                    <span>选择文件导入</span>
                  </button>
                </div>
              </div>

              {iosContext !== 'none' && !iosTipDismissed ? (
                <div className={styles.card}>
                  <div className={styles.sectionTitle}>iPhone / iPad 独立主屏幕体验（免安装永不掉签）</div>
                  <div className={styles.hint}>
                    {iosContext === 'wechat_qq'
                      ? '当前在微信/QQ 内打开：请点右上角「…」选择「在默认浏览器（Safari）打开」，再点击底部分享图标 →「添加到主屏幕」，即可像原生 App 一样全屏离线使用。'
                      : '点击 Safari 底部中央「分享」图标（带向上箭头的方框）→ 下滑选择「添加到主屏幕」，即可获得全屏桌面图标与更稳固的本地离线存储。'}
                  </div>
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => {
                        dismissIosTip()
                        setIosTipDismissed(true)
                      }}
                    >
                      知道了
                    </button>
                  </div>
                </div>
              ) : null}

              <div className={styles.card}>
                <div className={styles.sectionTitle}>本地数据备份与重置</div>
                <div className={styles.hint}>
                  你的全部角色卡、世界卡、对话记录与密钥均仅存储在当前设备本地。
                  {lastBackupAt
                    ? `上次备份：${new Date(lastBackupAt).toLocaleString()}。`
                    : '尚未导出过本地备份。'}
                  {needsBackupReminder ? ' 建议定期导出留档（iPhone 会优先唤起系统分享「存储到文件」），也便于在电脑与手机之间同步。' : ''}
                </div>
                <div className={styles.row}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void handleExportBackup()}
                  >
                    <IconDownload size={14} />
                    <span>导出全量 JSON 备份</span>
                  </button>
                  <button
                    type="button"
                    className={clsx(styles.btn, styles.btnDanger)}
                    onClick={() => {
                      if (window.confirm('确定清空本地所有组件与对话记录吗？此操作不可撤销。')) {
                        void clearAllLocalData()
                      }
                    }}
                  >
                    <IconTrash size={14} />
                    <span>清空本地数据</span>
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {pillMenu
        ? createPortal(
            <div
              className={styles.pillMenuOverlay}
              onClick={() => setPillMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault()
                setPillMenu(null)
              }}
            >
              <div
                className={styles.pillMenuCard}
                style={{ left: `${pillMenu.x}px`, top: `${pillMenu.y}px` }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.pillMenuTitle}>{pillMenu.provider.name}</div>
                {pillMenu.provider.id !== active.id ? (
                  <button
                    type="button"
                    className={styles.pillMenuItem}
                    onClick={() => {
                      settings.setActiveProvider(pillMenu.provider.id)
                      setPillMenu(null)
                    }}
                  >
                    <IconCheck size={14} />
                    <span>设为当前使用服务</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.pillMenuItem}
                  onClick={() => {
                    settings.setActiveProvider(pillMenu.provider.id)
                    setAdvancedOpen(true)
                    setPillMenu(null)
                    window.requestAnimationFrame(() => nameInputRef.current?.focus())
                  }}
                >
                  <IconEdit size={14} />
                  <span>重命名与高级配置</span>
                </button>
                {settings.providers.length > 1 ? (
                  <button
                    type="button"
                    className={clsx(styles.pillMenuItem, styles.pillMenuDanger)}
                    onClick={() => handleDeleteProvider(pillMenu.provider)}
                  >
                    <IconTrash size={14} />
                    <span>删除此服务</span>
                  </button>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </Modal>
  )
}
