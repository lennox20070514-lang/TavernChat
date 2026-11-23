declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}

interface TavernDesktopBridge {
  isDesktop: boolean
  edition: 'lite' | 'pro'
  getGatewayOrigin: () => string
}

interface Window {
  tavernDesktop?: TavernDesktopBridge
}
