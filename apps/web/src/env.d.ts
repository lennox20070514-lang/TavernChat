declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}

declare const __APP_VERSION__: string
declare const __ANDROID_VERSION_CODE__: number
declare const __DEFAULT_UPDATE_MANIFEST_URL__: string
declare const __DEFAULT_UPDATE_MIRROR_URL__: string

interface LanHostStatusInfo {
  running: boolean
  url: string
  ip: string
  port: number
  revision?: number
}

interface TavernDesktopBridge {
  isDesktop: boolean
  edition: 'lite' | 'pro'
  getGatewayOrigin: () => string
  startLanHost?: () => Promise<LanHostStatusInfo>
  stopLanHost?: () => Promise<LanHostStatusInfo>
  getLanStatus?: () => Promise<LanHostStatusInfo>
}

interface Window {
  tavernDesktop?: TavernDesktopBridge
}
