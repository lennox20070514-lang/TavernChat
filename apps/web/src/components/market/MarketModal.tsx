import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import {
  smartImportFile,
  type ComponentItem,
  type ComponentKind,
  type ComponentOrigin,
  type MarketplaceCatalog,
  type MarketplaceItem,
} from '@tavern-chat/core'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import {
  downloadMarketplaceItem,
  getMarketplaceGateway,
  loadMarketplaceCatalog,
} from '../../services/market.ts'
import {
  IconCheck,
  IconDownload,
  IconGlobe,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconUser,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './MarketModal.module.css'

const EMPTY_CATALOG: MarketplaceCatalog = { sources: [], items: [] }

export const MarketModal = () => {
  const open = useAppStore((s) => s.marketOpen)
  const setOpen = useAppStore((s) => s.setMarketOpen)
  const components = useAppStore((s) => s.components)
  const upsertComponent = useAppStore((s) => s.upsertComponent)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const showToast = useAppStore((s) => s.showToast)
  const settings = useSettings()

  const [catalog, setCatalog] = useState<MarketplaceCatalog>(EMPTY_CATALOG)
  const [sourceFilter, setSourceFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [gatewayAvailable, setGatewayAvailable] = useState(false)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [downloadingId, setDownloadingId] = useState('')
  const [downloadError, setDownloadError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingCatalog(true)
    void Promise.all([
      loadMarketplaceCatalog(settings.customGatewayOrigin),
      getMarketplaceGateway(settings.customGatewayOrigin),
    ])
      .then(([nextCatalog, gateway]) => {
        if (cancelled) return
        setCatalog(nextCatalog)
        setGatewayAvailable(gateway !== null)
        setSelectedId((current) =>
          current && nextCatalog.items.some((item) => item.id === current)
            ? current
            : nextCatalog.items[0]?.id ?? ''
        )
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, settings.customGatewayOrigin])

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    return catalog.items.filter((item) => {
      if (sourceFilter !== 'all' && item.providerId !== sourceFilter) return false
      if (!q) return true
      return [item.name, item.description, item.creator, item.providerName, ...item.tags]
        .join(' ')
        .toLocaleLowerCase()
        .includes(q)
    })
  }, [catalog.items, sourceFilter, query])

  const selected =
    filtered.find((item) => item.id === selectedId) ??
    filtered[0] ??
    catalog.items.find((item) => item.id === selectedId) ??
    null

  useEffect(() => {
    if (selected && !filtered.some((item) => item.id === selected.id)) {
      setSelectedId(filtered[0]?.id ?? '')
    }
  }, [selected, filtered])

  const savedComponents = selected
    ? components.filter(
        (component) =>
          component.origin?.providerId === selected.providerId &&
          component.origin.listingId === selected.id
      )
    : []
  const saved = savedComponents.some((component) => component.kind === 'character')

  const createOrigin = (
    item: MarketplaceItem,
    componentKind: ComponentKind
  ): ComponentOrigin => ({
    providerId: item.providerId,
    providerName: item.providerName,
    listingId: item.id,
    listingName: item.name,
    sourceUrl: item.sourceUrl,
    creator: item.creator,
    license: item.license,
    licenseUrl: item.licenseUrl,
    version: item.version,
    importedAt: Date.now(),
    componentKind,
  })

  const saveWithOrigin = async (item: MarketplaceItem, component: ComponentItem) => {
    const existing = useAppStore
      .getState()
      .components.find(
        (savedComponent) =>
          savedComponent.origin?.providerId === item.providerId &&
          savedComponent.origin.listingId === item.id &&
          savedComponent.origin.componentKind === component.kind
      )
    if (existing) return existing
    const next = { ...component, origin: createOrigin(item, component.kind) } as ComponentItem
    await upsertComponent(next)
    return next
  }

  const handleDownload = async (item: MarketplaceItem) => {
    setDownloadingId(item.id)
    setDownloadError('')
    try {
      const bytes = await downloadMarketplaceItem(item, settings.customGatewayOrigin)
      const imported = smartImportFile(item.fileName, bytes, 'market-download')
      if (imported.kind !== 'character') {
        throw new Error('来源返回的文件不是角色卡')
      }
      await saveWithOrigin(item, imported.bundle.character)
      if (imported.bundle.embeddedWorld) {
        await saveWithOrigin(item, imported.bundle.embeddedWorld)
      }
      showToast(item.name + ' 已下载到素材库', 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setDownloadError(message)
      showToast(message, 'error')
    } finally {
      setDownloadingId('')
    }
  }

  const openGatewaySettings = () => {
    setOpen(false)
    setSettingsOpen(true)
  }

  const sourceCount = catalog.sources.filter((source) => source.available).length

  return (
    <Modal open={open} title="角色卡市场" size="lg" onClose={() => setOpen(false)}>
      <div className={styles.market}>
        <div className={styles.intro}>
          <div>
            <div className={styles.eyebrow}>社区来源 · 免费卡片</div>
            <h3>从社区来源发现角色卡</h3>
            <p>作者和来源随卡片保留；选择卡片即可查看并下载。</p>
          </div>
          <div className={clsx(styles.gatewayBadge, gatewayAvailable && styles.gatewayReady)}>
            <span className={styles.gatewayDot} />
            {gatewayAvailable ? `${sourceCount} 个来源已连接` : '等待连接市场网关'}
          </div>
        </div>

        <div className={styles.toolbar}>
          <label className={styles.searchBox}>
            <IconSearch size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索角色卡、题材或作者…"
            />
          </label>
        </div>

        <div className={styles.sourceRow}>
          <span className={styles.sourceLabel}>来源</span>
          <button
            type="button"
            className={clsx(styles.sourceChip, sourceFilter === 'all' && styles.sourceChipActive)}
            onClick={() => setSourceFilter('all')}
          >
            全部
          </button>
          {catalog.sources.map((source) => (
            <button
              type="button"
              key={source.id}
              className={clsx(
                styles.sourceChip,
                sourceFilter === source.id && styles.sourceChipActive,
                !source.available && styles.sourceChipOffline
              )}
              title={source.available ? source.description : source.error || '来源暂不可用'}
              onClick={() => setSourceFilter(source.id)}
            >
              {source.name}
              <span className={styles.sourceCount}>
                {catalog.items.filter((item) => item.providerId === source.id).length}
              </span>
            </button>
          ))}
          <span className={styles.freeOnly}>免费来源</span>
        </div>

        <div className={styles.content}>
          <section className={styles.resultsPane} aria-label="角色卡列表">
            <div className={styles.resultsHeading}>
              <span>{loadingCatalog ? '正在读取来源…' : '社区角色卡'}</span>
              <span className={styles.resultCount}>{filtered.length} 张</span>
            </div>
            {filtered.length === 0 ? (
              <div className={styles.empty}>
                <IconSearch size={22} />
                <strong>{gatewayAvailable ? '这个来源暂时没有可显示的卡片' : '尚未连接卡片来源'}</strong>
                <span>
                  {gatewayAvailable
                    ? '可以切换来源，或稍后重试。'
                    : '连接本地或局域网网关后，即可实时读取各来源的卡片目录。'}
                </span>
                {!gatewayAvailable ? (
                  <button type="button" className={styles.gatewayButton} onClick={openGatewaySettings}>
                    <IconSettings size={13} />
                    配置市场网关
                  </button>
                ) : null}
              </div>
            ) : (
              <div className={styles.grid}>
                {filtered.map((item) => {
                  const isSaved = components.some(
                    (component) =>
                      component.origin?.providerId === item.providerId &&
                      component.origin.listingId === item.id &&
                      component.kind === 'character'
                  )
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={clsx(styles.card, selected?.id === item.id && styles.cardSelected)}
                      onClick={() => {
                        setSelectedId(item.id)
                        setDownloadError('')
                      }}
                    >
                      <span className={styles.cover}>
                        {item.coverUrl ? (
                          <img src={item.coverUrl} alt="" loading="lazy" />
                        ) : (
                          <span className={styles.coverFallback}><IconSparkles size={25} /></span>
                        )}
                        <span className={styles.kindBadge}><IconUser size={11} /> 角色卡</span>
                        {isSaved ? <span className={styles.downloadedBadge}><IconCheck size={11} /> 已下载</span> : null}
                      </span>
                      <span className={styles.cardBody}>
                        <span className={styles.cardTitle}>{item.name}</span>
                        <span className={styles.cardAuthor}>{item.creator}</span>
                        <span className={styles.cardDescription}>{item.description}</span>
                        <span className={styles.cardFooter}>
                          <span className={styles.freeBadge}>免费</span>
                          <span className={styles.sourceMeta}><IconGlobe size={11} />{item.providerName}</span>
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {selected ? (
            <aside className={styles.detailPane} aria-label="角色卡详情">
              <div className={styles.detailCover}>
                {selected.coverUrl ? (
                  <img src={selected.coverUrl} alt="" />
                ) : (
                  <div className={styles.detailCoverFallback}><IconUser size={34} /></div>
                )}
                <span className={styles.detailKind}>CHARACTER CARD</span>
              </div>
              <div className={styles.detailContent}>
                <div className={styles.detailTitleRow}>
                  <h3>{selected.name}</h3>
                  <span className={styles.freeBadge}>免费</span>
                </div>
                <p className={styles.detailDescription}>{selected.description}</p>
                {selected.tags.length > 0 ? (
                  <div className={styles.tagList}>
                    {selected.tags.map((tag) => <span className={styles.tag} key={tag}>{tag}</span>)}
                  </div>
                ) : null}
                <div className={styles.metaList}>
                  <div className={styles.metaRow}><span>作者</span><strong>{selected.creator}</strong></div>
                  <div className={styles.metaRow}><span>来源</span><strong>{selected.providerName}</strong></div>
                  <div className={styles.metaRow}>
                    <span>授权</span>
                    <strong>
                      {selected.licenseUrl ? (
                        <a href={selected.licenseUrl} target="_blank" rel="noreferrer">{selected.license}</a>
                      ) : selected.license}
                    </strong>
                  </div>
                </div>
                <a className={styles.sourceLink} href={selected.sourceUrl} target="_blank" rel="noreferrer">
                  <IconGlobe size={13} /> 查看来源页面
                </a>
                {saved ? (
                  <div className={styles.savedState}>
                    <span className={styles.savedIcon}><IconCheck size={14} /></span>
                    <div><strong>已下载到素材库</strong><span>{selected.name}</span></div>
                  </div>
                ) : null}
                {downloadError ? <div className={styles.error}>{downloadError}</div> : null}
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={downloadingId === selected.id || saved || !gatewayAvailable}
                  onClick={() => void handleDownload(selected)}
                >
                  {downloadingId === selected.id ? (
                    <><span className={styles.spinner} /> 正在下载角色卡…</>
                  ) : saved ? (
                    <><IconCheck size={15} /> 已下载</>
                  ) : (
                    <><IconDownload size={15} /> 下载角色卡</>
                  )}
                </button>
                {!gatewayAvailable ? (
                  <button type="button" className={styles.gatewayButton} onClick={openGatewaySettings}>
                    <IconSettings size={13} /> 配置市场网关
                  </button>
                ) : null}
              </div>
            </aside>
          ) : (
            <aside className={styles.detailEmpty}>
              <IconUser size={24} /><span>选择一张角色卡查看作者并下载</span>
            </aside>
          )}
        </div>

        <div className={styles.footerNote}>
          <span><IconCheck size={12} /> 下载到本地素材库并保留作者与来源</span>
          <span>目录由社区来源实时读取</span>
        </div>
      </div>
    </Modal>
  )
}
