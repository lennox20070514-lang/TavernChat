import { isIosDevice, isStandalonePwa } from '../app/pwaInstall.ts'

type SharePayload = { files: File[]; title?: string }
type ShareNavigator = Navigator & {
  canShare?: (data: SharePayload) => boolean
  share?: (data: SharePayload) => Promise<void>
}

export type SaveFileResult = 'shared' | 'downloaded' | 'cancelled'

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 跨端文件导出：
 * 在 iPhone / iPad Safari 及独立主屏幕 PWA 下优先调用系统分享面板（可直接「存储到文件」），
 * 桌面端与普通浏览器走标准下载。
 */
export const saveFileBlob = async (blob: Blob, filename: string): Promise<SaveFileResult> => {
  const nav = navigator as ShareNavigator
  const preferShare = isIosDevice() || isStandalonePwa()

  if (preferShare && typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: filename })
        return 'shared'
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return 'cancelled'
        }
      }
    }
  }

  triggerDownload(blob, filename)
  return 'downloaded'
}
