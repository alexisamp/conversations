// Conversations — Electron main process
// Phase 1: BaseWindow + two WebContentsView (WhatsApp left, React sidebar right).

import {
  app,
  BaseWindow,
  WebContentsView,
  session,
  shell,
  ipcMain,
  Menu,
} from 'electron'
import * as path from 'path'
import { loadEnvFile } from './supabase/env'
import { registerAuthIpc } from './supabase/auth'
import { registerContactIpc } from './supabase/contacts'
import { applyLayout } from './layout'

loadEnvFile()

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

const WHATSAPP_URL = 'https://web.whatsapp.com/'

const IS_DEV = process.env.CONV_DEV === '1'
const SIDEBAR_DEV_URL = 'http://localhost:5173/'
const SIDEBAR_PROD_FILE = path.join(__dirname, '../renderer/index.html')

let mainWindow: BaseWindow | null = null
let whatsappView: WebContentsView | null = null
let sidebarView: WebContentsView | null = null
let sidebarVisible = true

async function createMainWindow(): Promise<void> {
  session.defaultSession.setUserAgent(CHROME_UA)

  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Conversations',
    titleBarStyle: 'default',
    backgroundColor: '#111b21',
  })

  // ---------- WhatsApp view ----------
  whatsappView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-whatsapp.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'persist:whatsapp',
    },
  })
  whatsappView.webContents.setUserAgent(CHROME_UA)

  whatsappView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  whatsappView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://web.whatsapp.com')) {
      event.preventDefault()
      shell.openExternal(url).catch(() => {})
    }
  })

  // ---------- Sidebar view ----------
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-sidebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Separate partition so the sidebar never shares cookies with WhatsApp.
      partition: 'persist:sidebar',
    },
  })

  mainWindow.contentView.addChildView(whatsappView)
  mainWindow.contentView.addChildView(sidebarView)

  applyLayout(mainWindow, whatsappView, sidebarView, sidebarVisible)
  mainWindow.on('resize', () => {
    if (!mainWindow || !whatsappView || !sidebarView) return
    applyLayout(mainWindow, whatsappView, sidebarView, sidebarVisible)
  })

  // Load content
  await whatsappView.webContents.loadURL(WHATSAPP_URL)

  if (IS_DEV) {
    await sidebarView.webContents.loadURL(SIDEBAR_DEV_URL)
  } else {
    await sidebarView.webContents.loadFile(SIDEBAR_PROD_FILE)
  }

  if (process.env.CONV_DEVTOOLS === '1') {
    sidebarView.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    whatsappView = null
    sidebarView = null
  })
}

function toggleSidebar(): void {
  if (!mainWindow || !whatsappView || !sidebarView) return
  sidebarVisible = !sidebarVisible
  applyLayout(mainWindow, whatsappView, sidebarView, sidebarVisible)
}

// ---------- Application menu ----------
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => toggleSidebar(),
        },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- IPC registration ----------
function registerIpc(): void {
  ipcMain.handle('sidebar:toggle', () => {
    toggleSidebar()
  })

  registerAuthIpc((status) => {
    sidebarView?.webContents.send('auth:changed', status)
  })
  registerContactIpc()
}

// ---------- Lifecycle ----------
app.setName('Conversations')

app.whenReady().then(async () => {
  buildMenu()
  registerIpc()
  await createMainWindow()

  app.on('activate', async () => {
    if (!mainWindow) await createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
