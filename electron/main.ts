// Conversations — Electron main process
//
// Phase 2.6 — tabbed architecture:
//   - TabBarView at the top (inline HTML)
//   - Two content views: WhatsApp and LinkedIn (switchable, sessions persist)
//   - Sidebar on the right (shared across tabs, context-aware)
//
// The main process gates sidebar events so only the active tab's latest
// context is shown. Switching tabs re-emits the stored context.

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
const LINKEDIN_URL = 'https://www.linkedin.com/feed/'

const IS_DEV = process.env.CONV_DEV === '1'
const SIDEBAR_DEV_URL = 'http://localhost:5173/'
const SIDEBAR_PROD_FILE = path.join(__dirname, '../renderer/index.html')

// ─── State ───────────────────────────────────────────────────────────
type Tab = 'wa' | 'li'

let mainWindow: BaseWindow | null = null
let tabBarView: WebContentsView | null = null
let whatsappView: WebContentsView | null = null
let linkedinView: WebContentsView | null = null
let sidebarView: WebContentsView | null = null
let sidebarVisible = true
let activeTab: Tab = 'wa'

// Cached context per tab so we can re-emit on tab switch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let waContext: any = { kind: 'none' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let liContext: any = { kind: 'none' }

// ─── Tab bar HTML ────────────────────────────────────────────────────
const TAB_BAR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><style>
  :root {
    --burnham: #003720;
    --shuttle: #536471;
    --mercury: #e3e3e3;
    --bg: #f7f7f5;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    background: var(--bg);
    user-select: none;
    -webkit-user-select: none;
    -webkit-app-region: drag;
  }
  .tab-bar {
    display: flex;
    align-items: center;
    height: 38px;
    padding: 0 10px 0 82px; /* left padding leaves room for macOS traffic lights */
    border-bottom: 1px solid var(--mercury);
    gap: 4px;
  }
  .nav {
    -webkit-app-region: no-drag;
    display: flex;
    gap: 2px;
    margin-right: 8px;
  }
  .nav button {
    background: transparent;
    border: none;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 5px;
    color: var(--shuttle);
    font-size: 13px;
    font-family: inherit;
  }
  .nav button:hover { background: rgba(0, 55, 32, 0.08); color: var(--burnham); }
  .tab {
    -webkit-app-region: no-drag;
    background: transparent;
    border: none;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    color: var(--shuttle);
    cursor: pointer;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: inherit;
  }
  .tab:hover { background: rgba(0, 55, 32, 0.05); }
  .tab.active {
    background: white;
    color: var(--burnham);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .tab .dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
  }
  .tab .shortcut {
    font-size: 10px;
    color: var(--shuttle);
    opacity: 0.5;
    font-weight: 400;
    margin-left: 2px;
  }
  .tab.active .shortcut { color: var(--burnham); opacity: 0.7; }
</style></head><body>
  <div class="tab-bar">
    <div class="nav">
      <button id="nav-back" title="Back (⌘[)">‹</button>
      <button id="nav-forward" title="Forward (⌘])">›</button>
      <button id="nav-reload" title="Reload (⌘R)">⟳</button>
      <button id="nav-home" title="Home (⌘⇧H)">⌂</button>
    </div>
    <button class="tab active" data-tab="wa"><span class="dot" style="background:#25D366"></span>WhatsApp<span class="shortcut">⌘1</span></button>
    <button class="tab" data-tab="li"><span class="dot" style="background:#0A66C2"></span>LinkedIn<span class="shortcut">⌘2</span></button>
  </div>
  <script>
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(el => {
      el.addEventListener('click', () => window.convTab.switchTab(el.dataset.tab));
    });
    document.getElementById('nav-back').addEventListener('click', () => window.convTab.back());
    document.getElementById('nav-forward').addEventListener('click', () => window.convTab.forward());
    document.getElementById('nav-reload').addEventListener('click', () => window.convTab.reload());
    document.getElementById('nav-home').addEventListener('click', () => window.convTab.home());
    window.convTab.onActiveChanged((name) => {
      tabs.forEach(el => el.classList.toggle('active', el.dataset.tab === name));
    });
  </script>
</body></html>`

// ─── Session hardening ──────────────────────────────────────────────
// Google (and a few other sites) detect embedded browsers by sniffing the
// Sec-CH-UA client-hint headers, which Chromium/Electron populates with
// "Electron" in the brand list. Stripping those headers drops Google's
// detection heuristic to UA-only, which we already spoof.
function sanitizeClientHints(s: Electron.Session): void {
  s.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('sec-ch-ua')) {
        delete headers[key]
      }
    }
    callback({ requestHeaders: headers })
  })
}

// ─── Window creation ─────────────────────────────────────────────────
async function createMainWindow(): Promise<void> {
  session.defaultSession.setUserAgent(CHROME_UA)

  // Strip Electron-flavored client hints from every partition we drive.
  const waSession = session.fromPartition('persist:whatsapp')
  const liSession = session.fromPartition('persist:linkedin')
  waSession.setUserAgent(CHROME_UA)
  liSession.setUserAgent(CHROME_UA)
  sanitizeClientHints(waSession)
  sanitizeClientHints(liSession)
  sanitizeClientHints(session.defaultSession)

  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Conversations',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#111b21',
  })

  // ── Tab bar view ──
  tabBarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-tabbar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  await tabBarView.webContents.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(TAB_BAR_HTML),
  )

  // ── WhatsApp view ──
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
  attachDiagnosticListeners(whatsappView, 'wa')
  whatsappView.webContents.setWindowOpenHandler(({ url }) => {
    handleExternalLink(url)
    return { action: 'deny' }
  })
  whatsappView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://web.whatsapp.com')) {
      event.preventDefault()
      handleExternalLink(url)
    }
  })
  whatsappView.webContents.on('did-finish-load', () => {
    whatsappView?.webContents.setZoomFactor(0.8)
    injectBannerHider(whatsappView!)
  })

  // ── LinkedIn view ──
  linkedinView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-linkedin.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'persist:linkedin',
    },
  })
  linkedinView.webContents.setUserAgent(CHROME_UA)
  attachDiagnosticListeners(linkedinView, 'li')

  // Mirror the WhatsApp zoom (0.8) so LinkedIn also renders denser.
  linkedinView.webContents.on('did-finish-load', () => {
    linkedinView?.webContents.setZoomFactor(0.8)
  })
  linkedinView.webContents.setWindowOpenHandler(({ url }) => {
    // If LinkedIn opens a new window to another LI profile, navigate in-place.
    if (url.includes('linkedin.com')) {
      linkedinView?.webContents.loadURL(url).catch(() => {})
      return { action: 'deny' }
    }
    handleExternalLink(url)
    return { action: 'deny' }
  })

  // ── Sidebar view ──
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-sidebar.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: 'persist:sidebar',
    },
  })
  sidebarView.webContents.setWindowOpenHandler(({ url }) => {
    // External links from the sidebar (e.g., the LinkedIn chip) should
    // route to the LinkedIn tab rather than opening a new Electron window.
    if (url.includes('linkedin.com')) {
      switchTab('li')
      linkedinView?.webContents.loadURL(url).catch(() => {})
      return { action: 'deny' }
    }
    handleExternalLink(url)
    return { action: 'deny' }
  })

  // ── Add to window (order matters: later = on top in z-order) ──
  mainWindow.contentView.addChildView(whatsappView)
  mainWindow.contentView.addChildView(linkedinView)
  mainWindow.contentView.addChildView(sidebarView)
  mainWindow.contentView.addChildView(tabBarView)

  refreshLayout()
  mainWindow.on('resize', refreshLayout)

  // ── Load content ──
  await whatsappView.webContents.loadURL(WHATSAPP_URL)
  await linkedinView.webContents.loadURL(LINKEDIN_URL)

  if (IS_DEV) {
    await sidebarView.webContents.loadURL(SIDEBAR_DEV_URL)
  } else {
    await sidebarView.webContents.loadFile(SIDEBAR_PROD_FILE)
  }

  // Broadcast initial active tab to the tab bar
  tabBarView.webContents.send('tab:active-changed', activeTab)

  if (process.env.CONV_DEVTOOLS === '1') {
    sidebarView.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    tabBarView = null
    whatsappView = null
    linkedinView = null
    sidebarView = null
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────

function activeContentView(): WebContentsView | null {
  return activeTab === 'wa' ? whatsappView : linkedinView
}

function refreshLayout(): void {
  if (!mainWindow || !tabBarView || !whatsappView || !linkedinView || !sidebarView) return
  const active = activeTab === 'wa' ? whatsappView : linkedinView
  const inactive = activeTab === 'wa' ? [linkedinView] : [whatsappView]
  applyLayout({
    win: mainWindow,
    tabBarView,
    activeContentView: active,
    inactiveContentViews: inactive,
    sidebarView,
    sidebarVisible,
  })
}

function switchTab(next: Tab): void {
  if (next === activeTab) return
  activeTab = next
  refreshLayout()
  tabBarView?.webContents.send('tab:active-changed', activeTab)
  // Re-emit the context for the newly active tab
  const context = activeTab === 'wa' ? waContext : liContext
  sidebarView?.webContents.send('sidebar:context', { tab: activeTab, state: context })
}

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible
  refreshLayout()
}

function handleExternalLink(url: string): void {
  if (url.startsWith('https://') || url.startsWith('http://')) {
    shell.openExternal(url).catch(() => {})
  }
}

function attachDiagnosticListeners(view: WebContentsView, label: 'wa' | 'li'): void {
  view.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      const levels = ['VERBOSE', 'INFO', 'WARNING', 'ERROR']
      const tag = levels[level] ?? `L${level}`
      console.log(`[${label}:${tag}] ${message}` + (sourceId ? ` (${sourceId}:${line})` : ''))
    },
  )
  view.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    console.error(`[${label}] did-fail-load: code=${code} desc=${desc} url=${url} main=${isMain}`)
  })
  view.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[${label}] preload-error:`, preloadPath, error)
  })
  view.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${label}] render-process-gone:`, details)
  })
}

function injectBannerHider(view: WebContentsView): void {
  view.webContents
    .executeJavaScript(
      `
        (() => {
          const NEEDLE = 'Get WhatsApp for Mac';
          let scheduled = false;
          function findAndHide() {
            const candidates = document.querySelectorAll('a, button');
            for (const el of candidates) {
              const txt = (el.textContent || '').trim();
              if (!txt.includes(NEEDLE)) continue;
              let target = el;
              while (target.parentElement) {
                const parentText = (target.parentElement.textContent || '').trim();
                if (parentText.length > txt.length + 40) break;
                target = target.parentElement;
              }
              target.style.setProperty('display', 'none', 'important');
              return true;
            }
            return false;
          }
          function schedule() {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; findAndHide(); });
          }
          setTimeout(findAndHide, 500);
          setTimeout(findAndHide, 2000);
          const obs = new MutationObserver(schedule);
          obs.observe(document.body, { childList: true, subtree: true });
        })();
      `,
    )
    .catch(() => {
      /* ignore */
    })
}

// ─── Application menu ────────────────────────────────────────────────
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
          label: 'WhatsApp',
          accelerator: 'CmdOrCtrl+1',
          click: () => switchTab('wa'),
        },
        {
          label: 'LinkedIn',
          accelerator: 'CmdOrCtrl+2',
          click: () => switchTab('li'),
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: () => {
            const view = activeContentView()
            if (view?.webContents.navigationHistory.canGoBack()) {
              view.webContents.navigationHistory.goBack()
            }
          },
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: () => {
            const view = activeContentView()
            if (view?.webContents.navigationHistory.canGoForward()) {
              view.webContents.navigationHistory.goForward()
            }
          },
        },
        {
          label: 'Home',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            const url = activeTab === 'wa' ? WHATSAPP_URL : LINKEDIN_URL
            activeContentView()?.webContents.loadURL(url).catch(() => {})
          },
        },
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

// ─── IPC registration ────────────────────────────────────────────────
function registerIpc(): void {
  ipcMain.handle('sidebar:toggle', () => toggleSidebar())

  registerAuthIpc((status) => {
    sidebarView?.webContents.send('auth:changed', status)
  })
  registerContactIpc()

  // Tab bar → switch tab
  ipcMain.on('tab:switch', (_event, next: Tab) => {
    if (next === 'wa' || next === 'li') switchTab(next)
  })

  // Tab bar → navigate the active content view
  ipcMain.on('tab:back', () => {
    const view = activeContentView()
    if (view?.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack()
    }
  })
  ipcMain.on('tab:forward', () => {
    const view = activeContentView()
    if (view?.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward()
    }
  })
  ipcMain.on('tab:reload', () => {
    activeContentView()?.webContents.reload()
  })
  ipcMain.on('tab:home', () => {
    const url = activeTab === 'wa' ? WHATSAPP_URL : LINKEDIN_URL
    activeContentView()?.webContents.loadURL(url).catch(() => {})
  })

  // WhatsApp preload → store + gate
  ipcMain.on('wa:chat:changed', (_event, payload: unknown) => {
    console.log('[main] wa:chat:changed →', payload)
    waContext = payload
    if (activeTab === 'wa') {
      sidebarView?.webContents.send('sidebar:context', { tab: 'wa', state: payload })
    }
  })

  // LinkedIn preload → store + gate
  ipcMain.on('li:profile:changed', (_event, payload: unknown) => {
    console.log('[main] li:profile:changed →', payload)
    liContext = payload
    if (activeTab === 'li') {
      sidebarView?.webContents.send('sidebar:context', { tab: 'li', state: payload })
    }
  })

  // Navigate the WhatsApp view to a private DM with a phone number.
  ipcMain.handle('wa:navigate-to-dm', async (_event, phone: string) => {
    if (!whatsappView) return { ok: false, error: 'WhatsApp view not ready' }
    const normalized = phone.replace(/^\+/, '').replace(/\D/g, '')
    if (!normalized) return { ok: false, error: 'Invalid phone' }
    const url = `https://web.whatsapp.com/send?phone=${normalized}`
    try {
      switchTab('wa')
      await whatsappView.webContents.loadURL(url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Navigation failed' }
    }
  })

  // Navigate the LinkedIn view to a specific URL and switch to that tab.
  ipcMain.handle('li:navigate', async (_event, url: string) => {
    if (!linkedinView) return { ok: false, error: 'LinkedIn view not ready' }
    if (!url || !url.includes('linkedin.com')) {
      return { ok: false, error: 'Not a LinkedIn URL' }
    }
    try {
      switchTab('li')
      await linkedinView.webContents.loadURL(url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Navigation failed' }
    }
  })
}

// ─── Lifecycle ───────────────────────────────────────────────────────
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
  if (process.platform !== 'darwin') app.quit()
})
