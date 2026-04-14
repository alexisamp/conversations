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

  // Don't fight WhatsApp's internal layout — let it render natively.
  // Just zoom the whole pane down so everything is denser, which gives the
  // messages area more breathing room without any CSS injection.
  whatsappView.webContents.on('did-finish-load', () => {
    if (!whatsappView) return
    whatsappView.webContents.setZoomFactor(0.8)

    // Hide the "Get WhatsApp for Mac" promo banner.
    // Class names are obfuscated, so we walk up from any text-matching node
    // until the parent has substantially more text — that's the row container.
    // A MutationObserver keeps it hidden across WA's re-renders.
    whatsappView.webContents
      .executeJavaScript(
        `
          (() => {
            const NEEDLE = 'Get WhatsApp for Mac';
            function hideBanner() {
              const all = document.querySelectorAll('a, button, div, span');
              for (const el of all) {
                const txt = (el.textContent || '').trim();
                if (!txt.includes(NEEDLE)) continue;
                let target = el;
                while (target.parentElement) {
                  const parentText = (target.parentElement.textContent || '').trim();
                  if (parentText.length > txt.length + 40) break;
                  target = target.parentElement;
                }
                target.style.setProperty('display', 'none', 'important');
              }
            }
            hideBanner();
            const obs = new MutationObserver(() => hideBanner());
            obs.observe(document.body, { childList: true, subtree: true });
          })();
        `,
      )
      .catch(() => {
        /* ignore */
      })
  })

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

  // Forward active-chat changes detected by the WhatsApp preload to the sidebar.
  ipcMain.on(
    'wa:chat:changed',
    (_event, payload: { phone: string | null; name: string | null }) => {
      console.log('[main] wa:chat:changed →', payload)
      sidebarView?.webContents.send('chat:changed', payload)
    },
  )
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
