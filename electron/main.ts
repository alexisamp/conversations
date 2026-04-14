// Conversations — Electron main process
// Phase 0: embed WhatsApp Web in a native macOS window.
// Future phases will add a sidebar WebContentsView + preload DOM observer.

import { app, BrowserWindow, session, shell } from 'electron'
import * as path from 'path'

// Spoof a modern Chrome on macOS — WhatsApp Web refuses Electron's default UA.
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const WHATSAPP_URL = 'https://web.whatsapp.com/'

let mainWindow: BrowserWindow | null = null

async function createMainWindow(): Promise<void> {
  // Apply the Chrome UA at the session level BEFORE any request goes out.
  session.defaultSession.setUserAgent(CHROME_UA)

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Conversations',
    // Phase 0: default title bar — clean traffic lights above the webview.
    // We can polish to hiddenInset + drag region in a cosmetic phase later.
    titleBarStyle: 'default',
    backgroundColor: '#111b21', // WhatsApp Web dark background
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Persist partition so login survives restarts (QR scan once)
      partition: 'persist:whatsapp',
    },
  })

  mainWindow.webContents.setUserAgent(CHROME_UA)

  // Open any external link (clicks on links inside WhatsApp) in the default browser,
  // never in our app window — otherwise we'd stop being a WhatsApp client.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://web.whatsapp.com')) {
      event.preventDefault()
      shell.openExternal(url).catch(() => {})
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  await mainWindow.loadURL(WHATSAPP_URL)

  if (process.env.CONV_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.setName('Conversations')

app.whenReady().then(async () => {
  await createMainWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS keep the app alive (standard Mac behavior — Cmd+Q to quit).
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
