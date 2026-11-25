import clsx from 'clsx'
import { useSettings } from '../../services/settings.ts'
import {
  CURRENT_APP_VERSION,
  useUpdaterStore,
} from '../../services/updater.ts'
import { IconDownload, IconGlobe } from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './UpdatePromptModal.module.css'

export const UpdatePromptModal = () => {
  const promptOpen = useUpdaterStore((s) => s.promptOpen)
  const availableUpdate = useUpdaterStore((s) => s.availableUpdate)
  const closePrompt = useUpdaterStore((s) => s.closePrompt)

  if (!promptOpen || !availableUpdate) return null

  const { manifest, preferredUrl, fallbackUrl, viaMirror } = availableUpdate

  const openExternal = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleDismissVersion = () => {
    useSettings.getState().updateGeneral({ dismissedUpdateVersion: manifest.version })
    closePrompt()
  }

  return (
    <Modal open={promptOpen} title="发现新版本" size="sm" onClose={closePrompt}>
      <div className={styles.body}>
        <div className={styles.versionRow}>
          <span className={styles.oldVer}>v{CURRENT_APP_VERSION}</span>
          <span className={styles.arrow}>→</span>
          <span className={styles.newVer}>v{manifest.version}</span>
          {manifest.androidVersionCode ? (
            <span className={styles.buildTag}>Build {manifest.androidVersionCode}</span>
          ) : null}
        </div>

        {manifest.publishedAt ? (
          <div className={styles.dateText}>
            发布时间：{new Date(manifest.publishedAt).toLocaleString()}
          </div>
        ) : null}

        <div className={styles.changelogBox}>
          <div className={styles.changelogTitle}>更新说明</div>
          <div className={styles.changelogText}>
            {manifest.changelog || '包含体验优化与问题修复，建议下载最新安装包覆盖安装（本地角色卡与对话数据会保留）。'}
          </div>
        </div>

        <div className={styles.tip}>
          安卓安装提示：下载 APK 后直接覆盖安装即可，本地角色卡、世界书与聊天记录不会丢失。
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={clsx(styles.btn, styles.primary)}
            onClick={() => openExternal(preferredUrl)}
          >
            <IconDownload size={15} />
            <span>{viaMirror ? '镜像高速下载 APK' : '前往下载新版 APK'}</span>
          </button>

          {fallbackUrl ? (
            <button
              type="button"
              className={styles.btn}
              onClick={() => openExternal(fallbackUrl)}
            >
              <IconGlobe size={14} />
              <span>GitHub Release 原地址下载</span>
            </button>
          ) : null}

          <div className={styles.subActions}>
            <button type="button" className={styles.textBtn} onClick={handleDismissVersion}>
              忽略此版本
            </button>
            <button type="button" className={styles.textBtn} onClick={closePrompt}>
              稍后提醒
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
