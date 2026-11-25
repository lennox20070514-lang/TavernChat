import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type LanHostStatus = {
  running: boolean
  url: string
  ip: string
  port: number
  revision?: number
}

interface LanHostNativePlugin {
  startServer: () => Promise<LanHostStatus>
  stopServer: () => Promise<LanHostStatus>
  getStatus: () => Promise<LanHostStatus>
  addListener: (
    eventName: 'syncUpdated',
    listenerFunc: (data: { revision?: number }) => void
  ) => Promise<PluginListenerHandle>
}

const LanHostNative = registerPlugin<LanHostNativePlugin>('LanHost')

export type HostPlatform = 'android' | 'desktop' | 'none'

export function getHostPlatform(): HostPlatform {
  if (Capacitor.getPlatform() === 'android') return 'android'
  if (typeof window !== 'undefined' && window.tavernDesktop?.startLanHost) return 'desktop'
  return 'none'
}

export async function startNativeLanHost(): Promise<LanHostStatus> {
  const platform = getHostPlatform()
  if (platform === 'android') {
    return LanHostNative.startServer()
  }
  if (platform === 'desktop' && window.tavernDesktop?.startLanHost) {
    return window.tavernDesktop.startLanHost()
  }
  throw new Error('当前网页环境不支持直接作为主机启动服务')
}

export async function stopNativeLanHost(): Promise<LanHostStatus> {
  const platform = getHostPlatform()
  if (platform === 'android') {
    return LanHostNative.stopServer()
  }
  if (platform === 'desktop' && window.tavernDesktop?.stopLanHost) {
    return window.tavernDesktop.stopLanHost()
  }
  return { running: false, url: '', ip: '', port: 0 }
}

export async function getNativeLanHostStatus(): Promise<LanHostStatus> {
  const platform = getHostPlatform()
  if (platform === 'android') {
    return LanHostNative.getStatus()
  }
  if (platform === 'desktop' && window.tavernDesktop?.getLanStatus) {
    return window.tavernDesktop.getLanStatus()
  }
  return { running: false, url: '', ip: '', port: 0 }
}

export async function subscribeAndroidLanSync(
  onUpdate: () => void
): Promise<() => void> {
  if (Capacitor.getPlatform() !== 'android') return () => {}
  const handle = await LanHostNative.addListener('syncUpdated', () => {
    onUpdate()
  })
  return () => {
    void handle.remove()
  }
}
