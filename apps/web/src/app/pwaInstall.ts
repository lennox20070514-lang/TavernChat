const IOS_TIP_DISMISSED_KEY = 'tavernchat_ios_tip_dismissed'
const LAST_BACKUP_AT_KEY = 'tavernchat_last_backup_at'

export type IosInstallContext = 'wechat_qq' | 'safari_browser' | 'none'

export const isIosDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const touchMac = ua.includes('Mac') && navigator.maxTouchPoints > 1
  return /iPhone|iPad|iPod/i.test(ua) || touchMac
}

export const isStandalonePwa = (): boolean => {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

export const getIosInstallContext = (): IosInstallContext => {
  if (typeof navigator === 'undefined' || !isIosDevice() || isStandalonePwa()) {
    return 'none'
  }
  const ua = navigator.userAgent
  if (/MicroMessenger|QQ\//i.test(ua)) return 'wechat_qq'
  return 'safari_browser'
}

export const isIosTipDismissed = (): boolean => {
  try {
    return localStorage.getItem(IOS_TIP_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export const dismissIosTip = (): void => {
  try {
    localStorage.setItem(IOS_TIP_DISMISSED_KEY, '1')
  } catch {
    // 忽略隐私模式异常
  }
}

export const recordLastBackupTime = (): void => {
  try {
    localStorage.setItem(LAST_BACKUP_AT_KEY, String(Date.now()))
  } catch {
    // 忽略异常
  }
}

export const getLastBackupTime = (): number | null => {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_AT_KEY)
    const num = raw ? Number(raw) : NaN
    return Number.isFinite(num) && num > 0 ? num : null
  } catch {
    return null
  }
}
