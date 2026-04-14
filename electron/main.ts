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

  // ── WhatsApp layout shaping ────────────────────────────────────────────
  // Goal: more horizontal room for the messages pane.
  //
  // WhatsApp Web's main layout is CSS Grid with hard-coded column widths on
  // the *parent* of #pane-side (not on #pane-side itself). Narrowing only
  // #pane-side leaves a blank gutter where the grid column still occupies
  // the original width. We have to override the parent grid + flex rules.
  //
  // Selectors are obfuscated and change between releases, so the strategy is:
  //   1. Inject CSS that targets stable IDs (#pane-side, #main) and a few
  //      common attribute selectors that have survived for years.
  //   2. Run a JS pass that walks up from #pane-side until it finds a grid
  //      ancestor, then rewrites its grid-template-columns to "280px 1fr".
  //      That part is robust against class-name churn.
  //   3. Log layout diagnostics to the main process console so we can
  //      iterate quickly if a future WA release changes the structure.
  //
  // Re-runs on every did-finish-load (so SPA-style reloads of WA are covered).
  whatsappView.webContents.on('did-finish-load', () => {
    if (!whatsappView) return

    whatsappView.webContents.setZoomFactor(0.85)

    whatsappView.webContents
      .insertCSS(
        `
          /* 1. Narrow the chat list pane */
          #pane-side {
            flex: 0 0 280px !important;
            width: 280px !important;
            min-width: 280px !important;
            max-width: 280px !important;
          }

          /* 2. Force the main messages pane to fill remaining space */
          #main,
          #main > *,
          [data-tab],
          .app-wrapper-main {
            min-width: 0 !important;
            max-width: none !important;
          }

          /* 3. Strip any max-width from common WA root containers */
          #app,
          #app > div,
          #app > div > div,
          .two,
          .three,
          ._aigy,
          .app-wrapper {
            max-width: none !important;
          }
        `,
      )
      .catch(() => {
        /* ignore */
      })

    // JS pass: walk up from #pane-side, find the grid ancestor, rewrite columns.
    whatsappView.webContents
      .executeJavaScript(
        `
          (() => {
            const ps = document.querySelector('#pane-side');
            if (!ps) return { ok: false, reason: 'no #pane-side' };

            // Walk up looking for a grid container that defines columns.
            let node = ps.parentElement;
            let depth = 0;
            const trail = [];
            while (node && depth < 8) {
              const cs = getComputedStyle(node);
              trail.push({
                tag: node.tagName,
                cls: (node.className || '').toString().slice(0, 80),
                display: cs.display,
                gridCols: cs.gridTemplateColumns,
                maxWidth: cs.maxWidth,
                width: node.offsetWidth,
              });
              if (cs.display === 'grid' && cs.gridTemplateColumns && cs.gridTemplateColumns !== 'none') {
                node.style.setProperty('grid-template-columns', '280px 1fr', 'important');
                node.style.setProperty('max-width', 'none', 'important');
                node.style.setProperty('width', '100%', 'important');
                return { ok: true, fixed: true, trail, fixedClass: (node.className || '').toString().slice(0, 80) };
              }
              node = node.parentElement;
              depth++;
            }
            return { ok: true, fixed: false, trail };
          })()
        `,
      )
      .then((info) => {
        console.log('[wa-layout]', JSON.stringify(info, null, 2))
      })
      .catch((err) => {
        console.error('[wa-layout] inspect failed:', err)
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
