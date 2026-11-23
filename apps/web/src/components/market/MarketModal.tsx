import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  smartImportFile,
  type ComponentItem,
  type ComponentOrigin,
  type MarketCard,
  type MarketResourceKind,
} from '@tavern-chat/core'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  addManifestPlugin,
  downloadMarketCard,
  listMarketPlugins,
  loadMarketCatalog,
  removeManifestPlugin,
  type MarketCatalog,
  type MarketPluginView,
} from '../../services/market.ts'
import {
  getMarketAuthStatus,
  marketLogout,
  type MarketAuthStatus,
} from '../../services/marketAuth.ts'
import {
  IconCheck,
  IconChevronLeft,
  IconDownload,
  IconGlobe,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import { MarketAuthModal } from './MarketAuthModal.tsx'
import styles from './MarketModal.module.css'

type MarketView = 'catalog' | 'sources'
type Category = 'all' | MarketResourceKind

const EMPTY_CATALOG: MarketCatalog = { cards: [], sources: [] }
const KIND_ORDER: Record<MarketResourceKind, number> = { character: 0, world: 1, rule: 2 }
const KIND_LABELS: Record<MarketResourceKind, string> = {
  character: '角色',
  world: '世界',
  rule: '规则',
}
const CATEGORY_TABS: Array<{ key: Category; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'character', label: '角色' },
  { key: 'world', label: '世界' },
  { key: 'rule', label: '规则' },
]

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const cardKey = (card: MarketCard): string => card.pluginId + ':' + card.id

const SkeletonCard = () => (
  <div className={styles.skeletonCard} aria-hidden="true">
    <span className={styles.skeletonTitle} />
    <span className={styles.skeletonMeta} />
    <span className={styles.skeletonText} />
    <span className={styles.skeletonTextShort} />
  </div>
)

export const MarketModal = () => {
  const open = useAppStore((s) => s.marketOpen)
  const setOpen = useAppStore((s) => s.setMarketOpen)
  const components = useAppStore((s) => s.components)
  const upsertComponent = useAppStore((s) => s.upsertComponent)
  const deleteComponent = useAppStore((s) => s.deleteComponent)
  const showToast = useAppStore((s) => s.showToast)
  const settings = useSettings()

  const [view, setView] = useState<MarketView>('catalog')
  const [catalog, setCatalog] = useState<MarketCatalog>(EMPTY_CATALOG)
  const [loading, setLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [plugins, setPlugins] = useState<MarketPluginView[]>([])
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [manifestInput, setManifestInput] = useState('')
  const [addingManifest, setAddingManifest] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category>('all')
  const [onlyInstalled, setOnlyInstalled] = useState(false)
  const [downloadingKey, setDownloadingKey] = useState('')
  const [authStatus, setAuthStatus] = useState<Record<string, MarketAuthStatus>>({})
  const [authPlugin, setAuthPlugin] = useState<MarketPluginView | null>(null)
  const [pendingCard, setPendingCard] = useState<MarketCard | null>(null)

  const refreshCatalog = useCallback(async () => {
    setLoading(true)
    setCatalogError('')
    try {
      const result = await loadMarketCatalog(settings.customGatewayOrigin, (partial) => {
        setCatalog(partial)
      })
      setCatalog(result)
    } catch (err) {
      setCatalogError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [settings.customGatewayOrigin])

  const refreshPlugins = useCallback(async () => {
    setLoadingPlugins(true)
    setSourceError('')
    try {
      const next = await listMarketPlugins()
      setPlugins(next)
      const authEntries = await Promise.all(
        next
          .filter((plugin) => plugin.auth)
          .map(
            async (plugin) =>
              [plugin.id, await getMarketAuthStatus(plugin.id, settings.customGatewayOrigin)] as const
          )
      )
      setAuthStatus(Object.fromEntries(authEntries))
    } catch (err) {
      setSourceError(errorMessage(err))
    } finally {
      setLoadingPlugins(false)
    }
  }, [settings.customGatewayOrigin])

  useEffect(() => {
    if (!open) return
    setView('catalog')
    void refreshCatalog()
    void refreshPlugins()
  }, [open, refreshCatalog, refreshPlugins])

  const installedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const component of components) {
      if (component.origin) {
        keys.add(component.origin.providerId + ':' + component.origin.listingId)
      }
    }
    return keys
  }, [components])

  const isInstalled = useCallback(
    (card: MarketCard) => installedKeys.has(cardKey(card)),
    [installedKeys]
  )

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return catalog.cards
      .filter((card) => category === 'all' || card.kind === category)
      .filter((card) => !onlyInstalled || installedKeys.has(cardKey(card)))
      .filter((card) =>
        keyword === ''
          ? true
          : [card.name, card.description, card.creator, card.pluginName, ...card.tags]
              .join(' ')
              .toLocaleLowerCase()
              .includes(keyword)
      )
      .sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          a.name.localeCompare(b.name, 'zh-Hans-CN')
      )
  }, [catalog.cards, category, installedKeys, onlyInstalled, query])

  const failedSources = catalog.sources.filter((source) => source.error)
  const sourceMap = useMemo(
    () => new Map(catalog.sources.map((source) => [source.id, source])),
    [catalog.sources]
  )

  const buildOrigin = (
    card: MarketCard,
    componentKind: ComponentOrigin['componentKind']
  ): ComponentOrigin => ({
    providerId: card.pluginId,
    providerName: card.pluginName,
    listingId: card.id,
    listingName: card.name,
    sourceUrl: card.sourceUrl,
    creator: card.creator,
    license: card.license,
    licenseUrl: card.licenseUrl,
    version: plugins.find((plugin) => plugin.id === card.pluginId)?.version,
    importedAt: Date.now(),
    componentKind,
  })

  const saveWithOrigin = async (card: MarketCard, component: ComponentItem) => {
    const existing = useAppStore
      .getState()
      .components.find(
        (entry) =>
          entry.origin?.providerId === card.pluginId &&
          entry.origin.listingId === card.id &&
          entry.origin.componentKind === component.kind
      )
    if (existing) return
    await upsertComponent({ ...component, origin: buildOrigin(card, component.kind) })
  }

  const installCard = async (card: MarketCard) => {
    const source = sourceMap.get(card.pluginId)
    setDownloadingKey(cardKey(card))
    try {
      const bytes = await downloadMarketCard(
        card,
        source?.builtin ?? true,
        settings.customGatewayOrigin
      )
      const imported = smartImportFile(card.fileName, bytes, 'market-download')

      if (imported.kind === 'character' && card.kind === 'character') {
        await saveWithOrigin(card, imported.bundle.character)
        if (imported.bundle.embeddedWorld) {
          await saveWithOrigin(card, imported.bundle.embeddedWorld)
        }
      } else if (imported.kind === 'world' && card.kind === 'world') {
        await saveWithOrigin(card, imported.world)
      } else if (imported.kind === 'rule' && card.kind === 'rule') {
        await saveWithOrigin(card, imported.rule)
      } else {
        throw new Error('来源文件与资源分类不一致')
      }
      showToast(`${card.name} 已下载到素材库`, 'success')
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setDownloadingKey('')
    }
  }

  const handleInstall = async (card: MarketCard) => {
    const plugin = plugins.find((entry) => entry.id === card.pluginId)
    if (plugin?.auth && !authStatus[plugin.id]?.loggedIn) {
      setPendingCard(card)
      setAuthPlugin(plugin)
      showToast('请先登录' + plugin.name, 'info')
      return
    }
    await installCard(card)
  }

  const handleRemove = async (card: MarketCard) => {
    const matches = components.filter(
      (component) =>
        component.origin?.providerId === card.pluginId &&
        component.origin.listingId === card.id
    )
    if (matches.length === 0) return
    const extra = matches.length > 1 ? '及其配套内容' : ''
    if (!window.confirm(`从素材库移除「${card.name}」${extra}？`)) return
    try {
      for (const component of matches) {
        await deleteComponent(component.id)
      }
      showToast(`已移除 ${card.name}`, 'success')
    } catch (err) {
      showToast(errorMessage(err), 'error')
    }
  }

  const handleAddManifest = async (event: FormEvent) => {
    event.preventDefault()
    setAddingManifest(true)
    setSourceError('')
    try {
      const plugin = await addManifestPlugin(manifestInput)
      setManifestInput('')
      await Promise.all([refreshPlugins(), refreshCatalog()])
      setView('catalog')
      setCategory('all')
      setQuery('')
      showToast(`已添加来源：${plugin.name}`, 'success')
    } catch (err) {
      setSourceError(errorMessage(err))
    } finally {
      setAddingManifest(false)
    }
  }

  const handleRemoveManifest = async (plugin: MarketPluginView) => {
    if (!plugin.manifestUrl) return
    if (!window.confirm(`移除来源插件“${plugin.name}”？已经下载到素材库的内容不会被删除。`)) return
    removeManifestPlugin(plugin.manifestUrl)
    await Promise.all([refreshPlugins(), refreshCatalog()])
  }

  const handleLogout = async (plugin: MarketPluginView) => {
    try {
      await marketLogout(plugin.id, settings.customGatewayOrigin)
      setAuthStatus((current) => ({ ...current, [plugin.id]: { loggedIn: false } }))
      showToast(`已退出 ${plugin.name}`, 'success')
    } catch (err) {
      showToast(errorMessage(err), 'error')
    }
  }

  const renderCatalog = () => (
    <>
      <div className={styles.topbar}>
        <label className={styles.searchBox}>
          <IconSearch size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索角色、世界书、规则或作者…"
          />
        </label>
        <button
          type="button"
          className={styles.sourcesBtn}
          onClick={() => setView('sources')}
          title="来源插件"
          aria-label="来源插件"
        >
          <IconGlobe size={16} />
        </button>
      </div>

      <div className={styles.filterRow}>
        <button
          type="button"
          role="switch"
          aria-checked={onlyInstalled}
          className={clsx(styles.toggle, onlyInstalled && styles.toggleOn)}
          onClick={() => setOnlyInstalled((current) => !current)}
        >
          <span className={styles.switch}>
            <span className={styles.knob} />
          </span>
          仅显示已下载
        </button>
      </div>

      <div className={styles.tabs}>
        {CATEGORY_TABS.map((tab) => (
          <button
            type="button"
            key={tab.key}
            className={clsx(styles.tab, category === tab.key && styles.tabActive)}
            onClick={() => setCategory(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {catalogError ? (
        <div className={styles.error}>
          {catalogError}
          <button type="button" className={styles.retryBtn} onClick={() => void refreshCatalog()}>
            重试
          </button>
        </div>
      ) : null}

      {failedSources.length > 0 ? (
        <div className={styles.warn}>
          <span>部分来源暂时不可用</span>
          <button type="button" className={styles.linkBtn} onClick={() => setView('sources')}>
            查看来源
          </button>
        </div>
      ) : null}

      {loading && catalog.cards.length === 0 ? (
        <div className={styles.grid}>
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
          <div className={styles.loadingHint}>正在读取来源…</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.state}>
          {onlyInstalled ? '这个分类下还没有已下载的资源。' : '没有匹配的资源。'}
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((card) => {
            const installed = isInstalled(card)
            const busy = downloadingKey === cardKey(card)
            return (
              <article className={styles.card} key={cardKey(card)}>
                <div className={styles.cardTitleRow}>
                  <h3>{card.name}</h3>
                  <span className={styles.kindBadge}>{KIND_LABELS[card.kind]}</span>
                  {installed ? (
                    <span className={styles.installedBadge}>
                      <IconCheck size={10} /> 已下载
                    </span>
                  ) : null}
                </div>
                <div className={styles.cardMeta}>
                  <span>作者：{card.creator}</span>
                  <span>来源：{card.pluginName}</span>
                </div>
                {card.license ? <div className={styles.cardMeta}>授权：{card.license}</div> : null}
                <p className={styles.cardDescription}>{card.description || '来源没有提供简介。'}</p>
                {card.tags.length > 0 ? (
                  <div className={styles.tags}>
                    {card.tags.slice(0, 5).map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                ) : null}
                <div className={styles.cardFooter}>
                  {card.sourceUrl ? (
                    <a
                      className={styles.sourceLink}
                      href={card.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <IconGlobe size={11} /> 来源页面
                    </a>
                  ) : (
                    <span />
                  )}
                  {card.licenseUrl ? (
                    <a
                      className={styles.sourceLink}
                      href={card.licenseUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      授权说明
                    </a>
                  ) : null}
                  {installed ? (
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => void handleRemove(card)}
                    >
                      <IconTrash size={11} /> 移除
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={styles.installBtn}
                      disabled={busy}
                      onClick={() => void handleInstall(card)}
                    >
                      {busy ? (
                        '下载中…'
                      ) : (
                        <>
                          <IconDownload size={12} /> 下载
                        </>
                      )}
                    </button>
                  )}
                </div>
              </article>
            )
          })}
          {loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <div className={styles.loadingHint}>正在加载更多来源…</div>
            </>
          ) : null}
        </div>
      )}
    </>
  )

  const renderSources = () => (
    <>
      <div className={styles.viewHeader}>
        <button type="button" className={styles.backBtn} onClick={() => setView('catalog')}>
          <IconChevronLeft size={14} />
          市场
        </button>
        <strong>来源插件</strong>
        <button
          type="button"
          className={styles.refreshBtn}
          title="刷新来源"
          aria-label="刷新来源"
          onClick={() => {
            void refreshPlugins()
            void refreshCatalog()
          }}
        >
          <IconRefresh size={14} />
        </button>
      </div>

      <form className={styles.addRow} onSubmit={handleAddManifest}>
        <IconPlus size={14} />
        <input
          value={manifestInput}
          onChange={(event) => setManifestInput(event.target.value)}
          placeholder="粘贴插件清单 JSON 地址（如 GitHub raw）"
          spellCheck={false}
        />
        <button type="submit" disabled={addingManifest || manifestInput.trim() === ''}>
          {addingManifest ? '读取中…' : '添加来源'}
        </button>
      </form>

      {sourceError ? <div className={styles.error}>{sourceError}</div> : null}

      <div className={styles.pluginList}>
        {loadingPlugins && plugins.length === 0 ? (
          <div className={styles.state}>正在读取来源…</div>
        ) : plugins.length === 0 ? (
          <div className={styles.state}>还没有来源插件。</div>
        ) : (
          plugins.map((plugin) => {
            const status = sourceMap.get(plugin.id)
            const pluginIssue = plugin.error || status?.error
            return (
              <article className={styles.pluginRow} key={plugin.manifestUrl ?? plugin.id}>
                <span className={styles.pluginIcon}>
                  <IconGlobe size={17} />
                </span>
                <div className={styles.pluginBody}>
                  <div className={styles.pluginTitleRow}>
                    <strong>{plugin.name}</strong>
                    {plugin.version ? <span className={styles.version}>v{plugin.version}</span> : null}
                    <span className={plugin.builtin ? styles.builtinBadge : styles.subscribedBadge}>
                      {plugin.builtin ? '内置' : '订阅'}
                    </span>
                  </div>
                  <p className={pluginIssue ? styles.pluginErrorText : undefined}>
                    {pluginIssue || plugin.description || '这个来源没有提供说明。'}
                  </p>
                  <div className={styles.pluginMeta}>
                    {plugin.author}
                    {plugin.license ? ` · ${plugin.license}` : ''}
                  </div>
                  {plugin.auth ? (
                    <div className={styles.authBox}>
                      {authStatus[plugin.id]?.loggedIn ? (
                        <>
                          <span className={styles.authUser}>
                            已登录：
                            {authStatus[plugin.id]?.user?.username ||
                              authStatus[plugin.id]?.user?.email ||
                              '账号'}
                          </span>
                          <button
                            type="button"
                            className={styles.authBtn}
                            onClick={() => void handleLogout(plugin)}
                          >
                            退出
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.authBtn}
                          onClick={() => setAuthPlugin(plugin)}
                        >
                          登录 / 注册
                        </button>
                      )}
                      {authStatus[plugin.id]?.error ? (
                        <span className={styles.authError}>{authStatus[plugin.id]?.error}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {!plugin.builtin && plugin.manifestUrl ? (
                  <button
                    type="button"
                    className={styles.removeIconBtn}
                    title="移除来源"
                    aria-label="移除来源"
                    onClick={() => void handleRemoveManifest(plugin)}
                  >
                    <IconTrash size={13} />
                  </button>
                ) : null}
              </article>
            )
          })
        )}
      </div>

      <div className={styles.footnote}>
        <span>
          <IconCheck size={11} /> 插件只描述来源与资源，不执行远程代码
        </span>
        <span>目前只接入免费来源</span>
      </div>
    </>
  )

  return (
    <>
      <Modal open={open} title="插件市场" size="lg" onClose={() => setOpen(false)}>
        <div className={styles.page}>{view === 'catalog' ? renderCatalog() : renderSources()}</div>
      </Modal>
      <MarketAuthModal
        open={authPlugin !== null}
        plugin={authPlugin}
        onClose={() => {
          setAuthPlugin(null)
          setPendingCard(null)
        }}
        onLoggedIn={(status) => {
          if (!authPlugin) return
          setAuthStatus((current) => ({ ...current, [authPlugin.id]: status }))
          showToast(`已登录 ${authPlugin.name}`, 'success')
          const card = pendingCard
          setPendingCard(null)
          if (card && card.pluginId === authPlugin.id) {
            void installCard(card)
          }
        }}
      />
    </>
  )
}
