import { contextBridge, ipcRenderer } from 'electron'

type LanHostStatus = {
  running: boolean
  url: string
  ip: string
  port: number
}

contextBridge.exposeInMainWorld('tavernDesktop', {
  isDesktop: true,
  edition: 'lite' as const,
  getGatewayOrigin: (): string => ipcRenderer.sendSync('tavern:get-gateway-origin') as string,
  startLanHost: (): Promise<LanHostStatus> => ipcRenderer.invoke('tavern:lan-start'),
  stopLanHost: (): Promise<LanHostStatus> => ipcRenderer.invoke('tavern:lan-stop'),
  getLanStatus: (): Promise<LanHostStatus> => ipcRenderer.invoke('tavern:lan-status'),
})
