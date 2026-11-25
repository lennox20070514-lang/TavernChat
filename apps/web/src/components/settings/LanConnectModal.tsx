import clsx from 'clsx'
import { useState } from 'react'
import { getHostPlatform } from '../../services/lanHost.ts'
import { resetHostDiscoveryCache } from '../../services/llm/client.ts'
import { useSettings } from '../../services/settings.ts'
import { useAppStore } from '../../services/store.ts'
import { useSyncStore } from '../../services/sync.ts'
import { copyTextToClipboard } from '../../utils/clipboard.ts'
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconDevices,
  IconRefresh,
} from '../base/icons.tsx'
import { Modal } from '../base/Modal.tsx'
import styles from './LanConnectModal.module.css'

export const LanConnectModal = () => {
  const open = useAppStore((s) => s.lanConnectOpen)
  const setOpen = useAppStore((s) => s.setLanConnectOpen)
  const showToast = useAppStore((s) => s.showToast)

  const settings = useSettings()
  const role = useSyncStore((s) => s.role)
  const hostStatus = useSyncStore((s) => s.hostStatus)
  const syncing = useSyncStore((s) => s.syncing)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const lastError = useSyncStore((s) => s.lastError)
  const startHost = useSyncStore((s) => s.startHost)
  const stopHost = useSyncStore((s) => s.stopHost)
  const syncNow = useSyncStore((s) => s.syncNow)
  const connectClientToOrigin = useSyncStore((s) => s.connectClientToOrigin)

  const [toggling, setToggling] = useState(false)
  const [copied, setCopied] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [remoteDraft, setRemoteDraft] = useState(settings.customGatewayOrigin)
  const [connectingRemote, setConnectingRemote] = useState(false)

  if (!open) return null

  const platform = getHostPlatform()
  const isHostCapable = platform === 'android' || platform === 'desktop'
  const hostRunning = role === 'host' && hostStatus.running && Boolean(hostStatus.url)
  const isConnectedClient = role === 'client'

  const handleToggleHost = async () => {
    setToggling(true)
    try {
      if (hostRunning) {
        await stopHost()
        showToast('已停止多设备连接', 'info')
      } else {
        const res = await startHost()
        if (res.url) {
          showToast('连接已启动，请复制下方网址到电脑浏览器打开', 'success')
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '启动连接失败', 'error')
    } finally {
      setToggling(false)
    }
  }

  const handleCopyUrl = async () => {
    if (!hostStatus.url) return
    const ok = await copyTextToClipboard(hostStatus.url)
    if (ok) {
      setCopied(true)
      showToast('已复制连接网址，可前往电脑浏览器打开', 'success')
      window.setTimeout(() => setCopied(false), 2000)
    } else {
      showToast('自动复制失败，请长按上方网址手动复制', 'info')
    }
  }

  const handleConnectRemote = async () => {
    const clean = remoteDraft.trim().replace(/\/+$/, '')
    settings.updateGeneral({ customGatewayOrigin: clean })
    resetHostDiscoveryCache()
    if (!clean) {
      await connectClientToOrigin('')
      showToast('已清除外部主机地址', 'info')
      return
    }
    setConnectingRemote(true)
    try {
      const ok = await connectClientToOrigin(clean)
      if (ok) {
        showToast('已连接到主机并完成数据同步', 'success')
      } else {
        showToast('已保存地址，但暂未检测到同步服务', 'info')
      }
    } finally {
      setConnectingRemote(false)
    }
  }

  const syncTimeLabel = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '等待同步'

  return (
    <Modal open={open} title="多设备连接" size="md" onClose={() => setOpen(false)}>
      <div className={styles.wrap}>
        <div className={styles.noticeBanner}>
          <div className={styles.noticeTitle}>连接前请确认：电脑和手机在同一个 Wi-Fi / 局域网</div>
          <div className={styles.noticeSub}>
            {platform === 'android'
              ? '手机将作为主机提供访问，使用电脑端期间请保持手机上 TavernChat 在前台亮屏。'
              : '同一局域网下的手机与电脑可通过专属网址互通，角色卡、世界书、对话记录与模型配置会双向自动同步。'}
          </div>
        </div>

        {isConnectedClient ? (
          <div className={styles.connectedCard}>
            <div className={styles.statusRow}>
              <span className={styles.statusDotOnline} />
              <strong>已连接到局域网主机（数据双向同步中）</strong>
            </div>
            <div className={styles.stepDesc}>
              当前页面上的新增对话、角色卡与设置修改都会实时同步回主机设备。最近同步：{syncTimeLabel}
            </div>
            {lastError ? <div className={styles.errorText}>同步提示：{lastError}</div> : null}
            <div className={styles.actionRow}>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={syncing}
                onClick={() => void syncNow(true)}
              >
                <IconRefresh size={14} />
                <span>{syncing ? '正在同步…' : '立即同步一次'}</span>
              </button>
            </div>
          </div>
        ) : isHostCapable ? (
          <div className={styles.steps}>
            <div className={styles.stepCard}>
              <div className={styles.stepHeader}>
                <span className={styles.stepNum}>1</span>
                <div className={styles.stepInfo}>
                  <div className={styles.stepTitle}>启动连接</div>
                  <div className={styles.stepDesc}>
                    {platform === 'android'
                      ? '开启后，当前手机会作为主机在局域网内共享 TavernChat。'
                      : '开启后，当前电脑会作为主机在局域网内共享 TavernChat。'}
                  </div>
                </div>
              </div>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  className={clsx(styles.primaryBtn, hostRunning && styles.dangerBtn)}
                  disabled={toggling}
                  onClick={() => void handleToggleHost()}
                >
                  <IconDevices size={15} />
                  <span>
                    {toggling ? '处理中…' : hostRunning ? '停止连接' : '启动连接'}
                  </span>
                </button>
                {hostRunning ? (
                  <span className={styles.liveTag}>
                    <span className={styles.statusDotOnline} />
                    运行中
                  </span>
                ) : null}
              </div>
            </div>

            <div className={clsx(styles.stepCard, !hostRunning && styles.stepMuted)}>
              <div className={styles.stepHeader}>
                <span className={styles.stepNum}>2</span>
                <div className={styles.stepInfo}>
                  <div className={styles.stepTitle}>复制连接网址</div>
                  <div className={styles.stepDesc}>
                    {hostRunning
                      ? '把下方网址发给自己，或直接在另一台设备的浏览器地址栏输入即可。'
                      : '完成第 1 步启动后，这里会生成专属的局域网连接网址。'}
                  </div>
                </div>
              </div>

              {hostRunning ? (
                <div className={styles.urlBox}>
                  <code className={styles.urlText}>{hostStatus.url}</code>
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={() => void handleCopyUrl()}
                  >
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    <span>{copied ? '已复制' : '复制网址'}</span>
                  </button>
                </div>
              ) : (
                <div className={styles.urlPlaceholder}>http://192.168.x.x:18797（等待启动后生成）</div>
              )}
            </div>

            <div className={clsx(styles.stepCard, !hostRunning && styles.stepMuted)}>
              <div className={styles.stepHeader}>
                <span className={styles.stepNum}>3</span>
                <div className={styles.stepInfo}>
                  <div className={styles.stepTitle}>在电脑浏览器打开即可同步使用</div>
                  <div className={styles.stepDesc}>
                    把上面复制的网址粘贴到电脑浏览器（Chrome / Edge / Safari）打开即可直接开聊，手机里的角色卡、世界书、对话记录和模型配置都会自动同步。
                  </div>
                </div>
              </div>

              {hostRunning ? (
                <div className={styles.syncFooterRow}>
                  <span className={styles.syncMeta}>
                    最近同步：{syncTimeLabel}
                    {lastError ? ` · 提示：${lastError}` : ''}
                  </span>
                  <button
                    type="button"
                    className={styles.miniSyncBtn}
                    disabled={syncing}
                    onClick={() => void syncNow(true)}
                  >
                    <IconRefresh size={13} />
                    <span>{syncing ? '同步中…' : '立即同步'}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className={styles.stepCard}>
            <div className={styles.stepHeader}>
              <span className={styles.stepNum}>i</span>
              <div className={styles.stepInfo}>
                <div className={styles.stepTitle}>如何在手机与电脑之间互通？</div>
                <div className={styles.stepDesc}>
                  1. 请先确认手机和电脑连在同一个 Wi-Fi / 局域网。
                  <br />
                  2. 在安卓手机版（或电脑客户端）点开左侧「多设备连接」→ 点击「启动连接」。
                  <br />
                  3. 复制手机上给出的网址，直接粘贴到电脑浏览器地址栏打开即可开始使用并自动同步数据。
                </div>
              </div>
            </div>
          </div>
        )}

        <div className={styles.accordionCard}>
          <button
            type="button"
            className={styles.accordionTrigger}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <span>手动连接另一台主机（高级）</span>
            {advancedOpen ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
          </button>
          {advancedOpen ? (
            <div className={styles.accordionBody}>
              <div className={styles.stepDesc}>
                如果你想让当前设备主动连接另一台手机或电脑上的主机地址，可直接粘贴网址（例如{' '}
                <code>http://192.168.1.10:18797</code>），留空保存即可恢复本机独立模式。
              </div>
              <div className={styles.manualRow}>
                <input
                  className={styles.manualInput}
                  placeholder="http://192.168.1.10:18797"
                  value={remoteDraft}
                  onChange={(e) => setRemoteDraft(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={connectingRemote}
                  onClick={() => void handleConnectRemote()}
                >
                  {connectingRemote ? '连接中…' : '保存并连接'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
