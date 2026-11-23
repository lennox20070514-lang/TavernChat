import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  smartImportFile,
  type ComponentItem,
  type ComponentOrigin,
  type MarketCard,
} from '@tavern-chat/core'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  addManifestPlugin,
  downloadMarketCard,
  listMarketPlugins,
  loadMarketCards,
  removeManifestPlugin,
  type MarketPluginView,
} from '../../services/market.ts'
import {
  IconCheck,
  IconChevronLeft,
  IconDownload,
  IconGlobe,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUser,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './MarketModal.module.css'

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const CardCover = ({ url }: { url?: string }) => {
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return (
      <span className={styles.coverFallback}>
        <IconUser size={24} />
      </span>
    )
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

export const MarketModal = () => {
  const open = useAppStore((s) => s.marketOpen)
  const setOpen = useAppStore((s) => s.setMarketOpen)
  const components = useAppStore((s) => s.components)
  const upsertComponent = useAppStore((s) => s.upsertComponent)
  const showToast = useAppStore((s) => s.showToast)
  const settings = useSettings()

  const [plugins, setPlugins] = useState<MarketPluginView[]>([])
  const [activeId, setActiveId] = useState('')
  const [cards, setCards] = useState<MarketCard[]>([])
  const [query, setQuery] = useState('')
  const [loadingPlugins, setLoadingPlugins] = useState(false)
  const [loadingCards, setLoadingCards] = useState(false)
  const [pluginError, setPluginError] = useState('')
  const [cardsError, setCardsError] = useState('')
  const [manifestInput, setManifestInput] = useState('')
  const [addingManifest, setAddingManifest] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')

  const active = plugins.find((plugin) => plugin.id === activeId) ?? null

  const refreshPlugins = useCallback(async () => {
    setLoadingPlugins(true)
    setPluginError('')
    try {
      setPlugins(await listMarketPlugins())
    } catch (err) {
      setPluginError(errorMessage(err))
    } finally {
      setLoadingPlugins(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshPlugins()
  }, [open, refreshPlugins])

  const loadCards = useCallback(
    async (plugin: MarketPluginView) => {
      setCards([])
      setCardsError('')
      if (plugin.error) {
        setCardsError(plugin.error)
        return
      }
      setLoadingCards(true)
      try {
        setCards(await loadMarketCards(plugin, settings.customGatewayOrigin))
      } catch (err) {
        setCardsError(errorMessage(err))
      } finally {
        setLoadingCards(false)
      }
    },
    [settings.customGatewayOrigin]
  )

  const openPlugin = (plugin: MarketPluginView) => {
    setActiveId(plugin.id)
    setQuery('')
    void loadCards(plugin)
  }

  const backToPlugins = () => {
    setActiveId('')
    setCards([])
    setQuery('')
    setCardsError('')
  }

  const handleAddManifest = async (event: FormEvent) => {
    event.preventDefault()
    setAddingManifest(true)
    setPluginError('')
    try {
      const plugin = await addManifestPlugin(manifestInput)
      setManifestInput('')
      await refreshPlugins()
      openPlugin(plugin)
    } catch (err) {
      setPluginError(errorMessage(err))
    } finally {
      setAddingManifest(false)
    }
  }

  const handleRemoveManifest = async (plugin: MarketPluginView) => {
    if (!plugin.manifestUrl) return
    if (!window.confirm(`移除插件“${plugin.name}”？已经下载到素材库的卡片不会被删除。`)) return
    removeManifestPlugin(plugin.manifestUrl)
    if (activeId === plugin.id) backToPlugins()
    await refreshPlugins()
  }

  const buildOrigin = (
    card: MarketCard,
    plugin: MarketPluginView,
    componentKind: ComponentOrigin['componentKind']
  ): ComponentOrigin => ({
    providerId: plugin.id,
    providerName: plugin.name,
    listingId: card.id,
    listingName: card.name,
    sourceUrl: card.sourceUrl,
    creator: card.creator,
    license: card.license,
    licenseUrl: card.licenseUrl,
    version: plugin.version,
    importedAt: Date.now(),
    componentKind,
  })

  const saveWithOrigin = async (
    card: MarketCard,
    plugin: MarketPluginView,
    component: ComponentItem
  ) => {
    const existing = useAppStore
      .getState()
      .components.find(
        (entry) =>
          entry.origin?.providerId === plugin.id &&
          entry.origin.listingId === card.id &&
          entry.origin.componentKind === component.kind
      )
    if (existing) return
    await upsertComponent({ ...component, origin: buildOrigin(card, plugin, component.kind) })
  }

  const handleDownload = async (card: MarketCard) => {
    if (!active) return
    setDownloadingId(card.id)
    try {
      const bytes = await downloadMarketCard(card, active, settings.customGatewayOrigin)
      const imported = smartImportFile(card.fileName, bytes, 'market-download')
      if (imported.kind !== 'character') {
        throw new Error('来源返回的文件不是角色卡')
      }
      await saveWithOrigin(card, active, imported.bundle.character)
      if (imported.bundle.embeddedWorld) {
        await saveWithOrigin(card, active, imported.bundle.embeddedWorld)
      }
      showToast(`${card.name} 已导入素材库`, 'success')
    } catch (err) {
      showToast(errorMessage(err), 'error')
    } finally {
      setDownloadingId('')
    }
  }

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    if (!keyword) return cards
    return cards.filter((card) =>
      [card.name, card.description, card.creator, ...card.tags]
        .join(' ')
        .toLocaleLowerCase()
        .includes(keyword)
    )
  }, [cards, query])

  const isSaved = (card: MarketCard) =>
    components.some(
      (component) =>
        component.origin?.providerId === card.pluginId &&
        component.origin.listingId === card.id &&
        component.kind === 'character'
    )

  return (
    <Modal open={open} title="插件市场" size="lg" onClose={() => setOpen(false)}>
      <div className={styles.page}>
        {active === null ? (
          <>
            <div className={styles.intro}>
              <div>
                <span className={styles.eyebrow}>社区来源 · 插件驱动</span>
                <h3>安装来源插件，浏览并下载角色卡</h3>
                <p>卡片由来源实时提供；作者、来源和授权会随卡片保存在素材库。</p>
              </div>
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
                {addingManifest ? '读取中…' : '添加插件'}
              </button>
            </form>

            {pluginError ? <div className={styles.error}>{pluginError}</div> : null}

            <div className={styles.pluginList} aria-label="来源插件">
              {loadingPlugins && plugins.length === 0 ? (
                <div className={styles.state}>正在读取插件…</div>
              ) : plugins.length === 0 ? (
                <div className={styles.state}>还没有插件。添加一个来源清单即可开始。</div>
              ) : (
                plugins.map((plugin) => (
                  <article className={styles.pluginRow} key={(plugin.manifestUrl ?? plugin.id) + plugin.name}>
                    <span className={styles.pluginIcon}>
                      <IconGlobe size={18} />
                    </span>
                    <div className={styles.pluginBody}>
                      <div className={styles.pluginTitleRow}>
                        <strong>{plugin.name}</strong>
                        {plugin.version ? <span className={styles.version}>v{plugin.version}</span> : null}
                        <span className={plugin.builtin ? styles.builtinBadge : styles.subscribedBadge}>
                          {plugin.builtin ? '内置' : '订阅'}
                        </span>
                      </div>
                      <p className={plugin.error ? styles.pluginErrorText : undefined}>
                        {plugin.error || plugin.description || '这个插件没有提供说明。'}
                      </p>
                      <div className={styles.pluginMeta}>
                        {plugin.author}
                        {plugin.license ? ` · ${plugin.license}` : ''}
                      </div>
                    </div>
                    <div className={styles.pluginActions}>
                      {plugin.error ? null : (
                        <button type="button" className={styles.browseBtn} onClick={() => openPlugin(plugin)}>
                          浏览
                        </button>
                      )}
                      {!plugin.builtin && plugin.manifestUrl ? (
                        <button
                          type="button"
                          className={styles.removeBtn}
                          title="移除插件"
                          aria-label="移除插件"
                          onClick={() => void handleRemoveManifest(plugin)}
                        >
                          <IconTrash size={13} />
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))
              )}
            </div>

            <div className={styles.footnote}>
              <span><IconCheck size={11} /> 插件只描述来源与卡片，不执行远程代码</span>
              <span>目前只接入免费来源</span>
            </div>
          </>
        ) : (
          <>
            <div className={styles.toolbar}>
              <button type="button" className={styles.backBtn} onClick={backToPlugins}>
                <IconChevronLeft size={14} />
                <span>插件</span>
              </button>
              <div className={styles.activeTitle}>
                <strong>{active.name}</strong>
                <span>{active.author}</span>
              </div>
              <label className={styles.searchBox}>
                <IconSearch size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索角色、题材或作者…"
                />
              </label>
              <button
                type="button"
                className={styles.refreshBtn}
                title="重新读取来源"
                aria-label="重新读取来源"
                onClick={() => void loadCards(active)}
              >
                <IconRefresh size={14} />
              </button>
            </div>

            {loadingCards ? (
              <div className={styles.state}>正在读取「{active.name}」的卡片…</div>
            ) : cardsError ? (
              <div className={styles.error}>
                {cardsError}
                <button type="button" className={styles.retryBtn} onClick={() => void loadCards(active)}>
                  重试
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <div className={styles.state}>
                {cards.length === 0 ? '这个来源暂时没有卡片。' : '没有匹配的卡片。'}
              </div>
            ) : (
              <div className={styles.grid}>
                {filtered.map((card) => {
                  const saved = isSaved(card)
                  return (
                    <article className={styles.card} key={card.id}>
                      <div className={styles.cover}>
                        <CardCover url={card.coverUrl} />
                      </div>
                      <div className={styles.cardBody}>
                        <div className={styles.cardTitleRow}>
                          <strong title={card.name}>{card.name}</strong>
                          {saved ? <span className={styles.savedBadge}><IconCheck size={10} /> 已导入</span> : null}
                        </div>
                        <span className={styles.cardAuthor}>{card.creator}</span>
                        <p className={styles.cardDescription}>{card.description || '来源没有提供简介。'}</p>
                        {card.tags.length > 0 ? (
                          <div className={styles.tags}>
                            {card.tags.slice(0, 4).map((tag) => (
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
                              title="打开来源页面"
                            >
                              <IconGlobe size={11} /> 来源
                            </a>
                          ) : null}
                          <span className={styles.license}>{card.license || '见来源说明'}</span>
                          <button
                            type="button"
                            className={styles.downloadBtn}
                            disabled={saved || downloadingId === card.id}
                            onClick={() => void handleDownload(card)}
                          >
                            {downloadingId === card.id ? (
                              '下载中…'
                            ) : saved ? (
                              <><IconCheck size={12} /> 已导入</>
                            ) : (
                              <><IconDownload size={12} /> 下载</>
                            )}
                          </button>
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
