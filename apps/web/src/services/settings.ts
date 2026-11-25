import { create } from 'zustand'
import type { ContextCompressionMode } from '@tavern-chat/core'

export type ProviderFormat = 'openai' | 'anthropic' | 'ollama'
export type ThemeMode = 'system' | 'light' | 'dark'

export type ProviderConfig = {
  id: string
  name: string
  format: ProviderFormat
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
}

export type ProviderPresetTemplate = {
  key: string
  name: string
  format: ProviderFormat
  baseUrl: string
  defaultModel: string
  models: string[]
  hint: string
}

export const PROVIDER_TEMPLATES: ProviderPresetTemplate[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    hint: '官方 V4：Flash 快、Pro 强，1M 上下文',
  },
  {
    key: 'openai',
    name: 'OpenAI / 兼容中转',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    hint: '支持所有 OpenAI 协议中转站',
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    hint: '细腻长文与角色扮演口碑模型',
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-pro',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    hint: '超大上下文窗口，适合厚重世界书',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat-v3-0324',
    models: ['deepseek/deepseek-chat-v3-0324', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro'],
    hint: '一站式聚合主流云端模型',
  },
  {
    key: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    format: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    hint: '国内直连低延迟',
  },
  {
    key: 'ollama',
    name: '本地 Ollama / LM Studio',
    format: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'qwen2.5:14b',
    models: ['qwen2.5:14b', 'llama3.1:8b'],
    hint: '纯本机离线模型，无需 API Key',
  },
]

export type SettingsState = {
  theme: ThemeMode
  siderCollapsed: boolean
  providers: ProviderConfig[]
  activeProviderId: string
  defaultMaxContextTokens: number
  defaultMaxResponseTokens: number
  /** 上下文压缩：关闭 / 均衡 / 长记忆 */
  contextCompression: ContextCompressionMode
  autoInsertGreeting: boolean
  /** 可选自定义远端/局域网网关地址（如手机连接电脑桌面端网关） */
  customGatewayOrigin: string
}

const STORAGE_KEY = 'tavernchat.settings.v1'

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'prov_deepseek',
    name: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
]

const LEGACY_DEEPSEEK_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner'])

function migrateProvider(provider: ProviderConfig): ProviderConfig {
  if (!/api\.deepseek\.com/i.test(provider.baseUrl)) return provider
  const hasLegacy =
    LEGACY_DEEPSEEK_MODELS.has(provider.model) ||
    provider.models.some((model) => LEGACY_DEEPSEEK_MODELS.has(model))
  if (!hasLegacy) return provider
  const model =
    provider.model === 'deepseek-chat'
      ? 'deepseek-flash'
      : provider.model === 'deepseek-reasoner'
        ? 'deepseek-v4-pro'
        : provider.model
  const custom = provider.models.filter(
    (entry) =>
      !LEGACY_DEEPSEEK_MODELS.has(entry) &&
      entry !== 'deepseek-flash' &&
      entry !== 'deepseek-v4-pro'
  )
  return { ...provider, model, models: ['deepseek-flash', 'deepseek-v4-pro', ...custom] }
}

function loadSettings(): SettingsState {
  const defaults: SettingsState = {
    theme: 'system',
    siderCollapsed: false,
    providers: DEFAULT_PROVIDERS,
    activeProviderId: DEFAULT_PROVIDERS[0]!.id,
    defaultMaxContextTokens: 32768,
    defaultMaxResponseTokens: 2048,
    contextCompression: 'balanced',
    autoInsertGreeting: true,
    customGatewayOrigin: '',
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<SettingsState>
    const providers =
      Array.isArray(parsed.providers) && parsed.providers.length > 0
        ? parsed.providers.map(migrateProvider)
        : defaults.providers
    const activeId =
      typeof parsed.activeProviderId === 'string' &&
      providers.some((p) => p.id === parsed.activeProviderId)
        ? parsed.activeProviderId
        : providers[0]!.id
    return {
      ...defaults,
      ...parsed,
      providers,
      activeProviderId: activeId,
    }
  } catch {
    return defaults
  }
}

function saveSettings(state: SettingsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 忽略隐私模式配额错误
  }
}

export function applyThemeToDom(theme: ThemeMode): void {
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', isDark ? '#141518' : '#ffffff')
  }
}

type SettingsActions = {
  setTheme: (theme: ThemeMode) => void
  setSiderCollapsed: (collapsed: boolean) => void
  setActiveProvider: (id: string) => void
  upsertProvider: (provider: ProviderConfig) => void
  deleteProvider: (id: string) => void
  updateGeneral: (
    patch: Partial<
      Pick<
        SettingsState,
        | 'defaultMaxContextTokens'
        | 'defaultMaxResponseTokens'
        | 'contextCompression'
        | 'autoInsertGreeting'
        | 'customGatewayOrigin'
      >
    >
  ) => void
}

export const useSettings = create<SettingsState & SettingsActions>((set, get) => ({
  ...loadSettings(),

  setTheme: (theme) => {
    set({ theme })
    applyThemeToDom(theme)
    saveSettings(extractData(get()))
  },

  setSiderCollapsed: (siderCollapsed) => {
    set({ siderCollapsed })
    saveSettings(extractData(get()))
  },

  setActiveProvider: (activeProviderId) => {
    set({ activeProviderId })
    saveSettings(extractData(get()))
  },

  upsertProvider: (provider) => {
    const prev = get().providers
    const exists = prev.some((p) => p.id === provider.id)
    const providers = exists
      ? prev.map((p) => (p.id === provider.id ? provider : p))
      : [...prev, provider]
    set({ providers, activeProviderId: provider.id })
    saveSettings(extractData(get()))
  },

  deleteProvider: (id) => {
    const remaining = get().providers.filter((p) => p.id !== id)
    if (remaining.length === 0) return
    const activeProviderId =
      get().activeProviderId === id ? remaining[0]!.id : get().activeProviderId
    set({ providers: remaining, activeProviderId })
    saveSettings(extractData(get()))
  },

  updateGeneral: (patch) => {
    set(patch)
    saveSettings(extractData(get()))
  },
}))

function extractData(s: SettingsState & SettingsActions): SettingsState {
  return {
    theme: s.theme,
    siderCollapsed: s.siderCollapsed,
    providers: s.providers,
    activeProviderId: s.activeProviderId,
    defaultMaxContextTokens: s.defaultMaxContextTokens,
    defaultMaxResponseTokens: s.defaultMaxResponseTokens,
    contextCompression: s.contextCompression,
    autoInsertGreeting: s.autoInsertGreeting,
    customGatewayOrigin: s.customGatewayOrigin,
  }
}

export function getActiveProvider(state: SettingsState): ProviderConfig {
  return state.providers.find((p) => p.id === state.activeProviderId) ?? state.providers[0]!
}
