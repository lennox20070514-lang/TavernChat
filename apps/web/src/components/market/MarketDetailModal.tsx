import { useEffect, useState } from 'react'
import type { MarketCard } from '@tavern-chat/core'
import {
  IconCheck,
  IconDownload,
  IconGlobe,
  IconSliders,
  IconTrash,
  IconUser,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './MarketDetailModal.module.css'

type Props = {
  card: MarketCard | null
  installed: boolean
  busy: boolean
  onClose: () => void
  onInstall: (card: MarketCard) => void
  onRemove: (card: MarketCard) => void
}

const KIND_LABELS = { character: '角色卡', world: '世界书', rule: '规则' } as const

const Preview = ({ url }: { url?: string }) => {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (!url || failed) {
    return (
      <div className={styles.heroFallback}>
        <span className={styles.heroKind}>来源预览</span>
      </div>
    )
  }
  return (
    <div className={styles.hero}>
      <img
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
      <span className={styles.heroKind}>来源预览</span>
    </div>
  )
}

const KindIcon = ({ kind }: { kind: MarketCard['kind'] }) => {
  if (kind === 'world') return <IconGlobe size={42} />
  if (kind === 'rule') return <IconSliders size={42} />
  return <IconUser size={42} />
}

export const MarketDetailModal = ({
  card,
  installed,
  busy,
  onClose,
  onInstall,
  onRemove,
}: Props) => {
  if (!card) return null
  const meta: Array<[string, string]> = [
    ['作者', card.creator || '未知'],
    ['来源', card.pluginName],
  ]
  if (card.category) meta.push(['分类', card.category])
  if (card.series) meta.push(['系列', card.series])
  if (card.license) meta.push(['授权', card.license])
  if (typeof card.downloadCount === 'number') meta.push(['下载量', String(card.downloadCount)])
  if (typeof card.rating === 'number' && card.rating > 0) {
    meta.push([
      '评分',
      `${card.rating.toFixed(2)}${card.ratingCount ? `（${card.ratingCount} 人）` : ''}`,
    ])
  }
  if (card.createdAt) meta.push(['收录时间', card.createdAt])

  return (
    <Modal open title={card.name} size="md" onClose={onClose}>
      <div className={styles.page}>
        {card.coverUrl ? (
          <Preview url={card.coverUrl} />
        ) : (
          <div className={styles.heroFallback}>
            <KindIcon kind={card.kind} />
            <span className={styles.heroKind}>来源预览</span>
          </div>
        )}

        <div className={styles.content}>
          <div className={styles.titleRow}>
            <h3>{card.name}</h3>
            <span className={styles.kindBadge}>{KIND_LABELS[card.kind]}</span>
            {installed ? (
              <span className={styles.installedBadge}>
                <IconCheck size={10} /> 已下载
              </span>
            ) : null}
          </div>

          <div className={styles.metaGrid}>
            {meta.map(([label, value]) => (
              <div className={styles.metaItem} key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <p className={styles.description}>
            {card.summary || card.description || '来源没有提供更详细的介绍。'}
          </p>

          {card.tags.length > 0 ? (
            <div className={styles.tags}>
              {card.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          ) : null}

          <div className={styles.footer}>
            <div className={styles.links}>
              {card.sourceUrl ? (
                <a href={card.sourceUrl} target="_blank" rel="noreferrer">
                  <IconGlobe size={12} /> 来源页面
                </a>
              ) : null}
              {card.licenseUrl ? (
                <a href={card.licenseUrl} target="_blank" rel="noreferrer">
                  授权说明
                </a>
              ) : null}
            </div>
            {installed ? (
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => onRemove(card)}
              >
                <IconTrash size={13} /> 从卡牌库移除
              </button>
            ) : (
              <button
                type="button"
                className={styles.installBtn}
                disabled={busy}
                onClick={() => onInstall(card)}
              >
                {busy ? (
                  '下载中…'
                ) : (
                  <>
                    <IconDownload size={14} /> 下载到卡牌库
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
