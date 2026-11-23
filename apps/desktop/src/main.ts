import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { createGatewayHandler } from '../../server/src/gateway.ts'

const APP_SCHEME = 'app'
const APP_HOST = 'tavern-chat'
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

let localGateway: Server | null = null
let gatewayOrigin = ''
let mainWindow: BrowserWindow | null = null

const startEmbeddedGateway = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = createServer(createGatewayHandler('desktop-embedded'))
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      localGateway = server
      const address = server.address() as AddressInfo | null
      resolve(`http://127.0.0.1:${address?.port ?? 0}`)
    })
  })

const registerAppProtocol = (webRoot: string) => {
  const resolvedRoot = path.resolve(webRoot)
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) {
      return new Response('Forbidden', { status: 403 })
    }
    let relPath = decodeURIComponent(url.pathname)
    if (relPath === '/' || relPath === '') relPath = '/index.html'
    const candidate = path.resolve(resolvedRoot, `.${relPath}`)
    if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const data = await readFile(candidate)
      const ext = path.extname(candidate).toLowerCase()
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' },
      })
    } catch {
      const html = await readFile(path.join(resolvedRoot, 'index.html'))
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }
  })
}

const createMainWindow = () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 400,
    minHeight: 580,
    title: 'TavernChat',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  void win.loadURL(`${APP_ORIGIN}/index.html`)
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app
    .whenReady()
    .then(async () => {
      gatewayOrigin = await startEmbeddedGateway()
      const webRoot = path.join(__dirname, '../web-dist')
      registerAppProtocol(webRoot)

      ipcMain.on('tavern:get-gateway-origin', (event) => {
        event.returnValue = gatewayOrigin
      })

      createMainWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      })
    })
    .catch((err) => {
      dialog.showErrorBox('TavernChat 启动失败', err instanceof Error ? err.message : String(err))
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    localGateway?.close()
    localGateway = null
  })
}
