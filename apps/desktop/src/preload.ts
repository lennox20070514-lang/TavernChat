import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('tavernDesktop', {
  isDesktop: true,
  edition: 'lite' as const,
  getGatewayOrigin: (): string => ipcRenderer.sendSync('tavern:get-gateway-origin') as string,
})
