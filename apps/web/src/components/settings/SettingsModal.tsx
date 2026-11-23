import clsx from 'clsx'
import { useRef, useState } from 'react'
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
import { saveFileBlob } from '../../utils/fileSave.ts'
import { IconDownload, IconRefresh, IconTrash, IconUpload } from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './SettingsModal.module.css'

type SettingsTab = 'service' | 'general' | 'data'

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
  const [iosTipDismissed, setIosTipDismissed] = useState(() => isIosTipDismissed())
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(() => getLastBackupTime())
  const fileRef = useRef<HTMLInputElement>(null)

  if (!open) return null

  const iosContext = getIosInstallContext()
  const needsBackupReminder =
    lastBackupAt === null || Date.now() - lastBackupAt > 7 * 24 * 60 * 60 * 1000

  const updateActive = (patch: Partial<ProviderConfig>) => {
    settings.upsertProvider({ ...active, ...patch })
  }

  const addFromTemplate = (tplKey: string) => {
    const tpl = PROVIDER_TEMPLATES.find((t) => t.key === tplKey)
    if (!tpl) return
    const next: ProviderConfig = {
      id: `prov_${tpl.key}_${Date.now().toString(36)}`,
      name: tpl.name,
      format: tpl.format,
      baseUrl: tpl.baseUrl,
      apiKey: '',
      model: tpl.defaultModel,
      models: [...tpl.models],
    }
    settings.upsertProvider(next)
    showToast(`已添加「${tpl.name}」配置`, 'success')
  }

  const handleFetchModels = async () => {
    setFetchingModels(true)
    try {
      const models = await fetchProviderModels(active, settings.customGatewayOrigin)
      if (models.length === 0) {
        showToast('接口连接成功，但未返回模型列表', 'info')
      } else {
        updateActive({
          models,
          model: models.includes(active.model) ? active.model : models[0]!,
        })
        showToast(`已获取 ${models.length} 个可用模型`, 'success')
      }
    } catch (err) {
      showToast(`拉取模型失败：${err instanceof Error ? err.message : String(err)}`, 'error')
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
        </nav>

        <div className={styles.content}>
          {tab === 'service' ? (
            <>
              <div>
                <div className={styles.sectionTitle}>已配置的服务商</div>
                <div className={styles.providerPills}>
                  {settings.providers.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={clsx(styles.pill, p.id === active.id && styles.pillActive)}
                      onClick={() => settings.setActiveProvider(p.id)}
                    >
                      {p.name}
                    </button>
                  ))}
                  <select
                    className={styles.pill}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addFromTemplate(e.target.value)
                    }}
                  >
                    <option value="">+ 添加厂商预设</option>
                    {PROVIDER_TEMPLATES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={styles.card}>
                <div className={styles.field}>
                  <label className={styles.label}>显示名称</label>
                  <input
                    className={styles.input}
                    value={active.name}
                    onChange={(e) => updateActive({ name: e.target.value })}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>协议格式</label>
                  <select
                    className={styles.select}
                    value={active.format}
                    onChange={(e) => updateActive({ format: e.target.value as ProviderFormat })}
                  >
                    <option value="openai">OpenAI 兼容协议（DeepSeek / Gemini / 中转）</option>
                    <option value="anthropic">Anthropic Claude 协议</option>
                    <option value="ollama">本地 Ollama / LM Studio</option>
                  </select>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>API 地址（Base URL）</label>
                  <input
                    className={styles.input}
                    placeholder="https://api.deepseek.com"
                    value={active.baseUrl}
                    onChange={(e) => updateActive({ baseUrl: e.target.value })}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>API Key（仅保存在你的本机）</label>
                  <input
                    className={styles.input}
                    type="password"
                    placeholder={active.format === 'ollama' ? '本地模型可留空' : 'sk-...'}
                    value={active.apiKey}
                    onChange={(e) => updateActive({ apiKey: e.target.value })}
                  />
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>当前模型名称</label>
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      style={{ flex: 1 }}
                      value={active.model}
                      onChange={(e) => {
                        const model = e.target.value
                        const models = active.models.includes(model)
                          ? active.models
                          : [model, ...active.models].filter(Boolean)
                        updateActive({ model, models })
                      }}
                    />
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={fetchingModels}
                      onClick={() => void handleFetchModels()}
                    >
                      <IconRefresh size={14} />
                      <span>{fetchingModels ? '拉取中…' : '获取模型列表'}</span>
                    </button>
                  </div>
                </div>

                {settings.providers.length > 1 ? (
                  <div>
                    <button
                      type="button"
                      className={clsx(styles.btn, styles.btnDanger)}
                      onClick={() => settings.deleteProvider(active.id)}
                    >
                      <IconTrash size={14} />
                      <span>删除此服务商</span>
                    </button>
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
                  <div className={styles.row}>
                    {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={clsx(styles.pill, settings.theme === mode && styles.pillActive)}
                        onClick={() => settings.setTheme(mode)}
                      >
                        {mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色' : '深色'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>默认上下文 Token 上限</label>
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
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>默认最大单次回复 Token</label>
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
                </div>

                <label className={styles.row} style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={settings.autoInsertGreeting}
                    onChange={(e) =>
                      settings.updateGeneral({ autoInsertGreeting: e.target.checked })
                    }
                  />
                  <span style={{ fontSize: 13 }}>空对话首次选入角色卡时，自动带入角色开场白</span>
                </label>

                <div className={styles.field}>
                  <label className={styles.label}>自定义局域网本地网关（可选，供手机连接电脑）</label>
                  <input
                    className={styles.input}
                    placeholder="留空自动探测本机网关或直连，如 http://192.168.1.10:8797"
                    value={settings.customGatewayOrigin}
                    onChange={(e) =>
                      settings.updateGeneral({ customGatewayOrigin: e.target.value })
                    }
                  />
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
                accept=".png,.json,.jsonl"
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
    </Modal>
  )
}
