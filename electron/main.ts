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
import { insertMessage, assignMessageToSession, type MessageInput } from './db/local'
import { handleMessage, recoverOpenSessions } from './session-manager'
import { startSync, stopSync } from './sync/supabase-sync'
import { autoUpdater } from 'electron-updater'

// Cache phone → contactId so we don't re-resolve on every message.
// Populated lazily when a message arrives for a new phone.
const phoneContactIdCache = new Map<string, string | null>()

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

/** Accessor for other modules that need the authenticated LI WebContents
 *  (e.g. scrape-company.ts navigates it to /company/<slug>/about/ to pull
 *  enrichment data). Returns null before the main window is initialized. */
export function getLinkedinWebContents(): Electron.WebContents | null {
  return linkedinView?.webContents ?? null
}
let sidebarView: WebContentsView | null = null
let searchOverlayView: WebContentsView | null = null
let sidebarVisible = true
let activeTab: Tab = 'wa'
let overlayVisible = false

// Cached context per tab so we can re-emit on tab switch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let waContext: any = { kind: 'none' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let liContext: any = { kind: 'none' }

// ─── Search overlay HTML ─────────────────────────────────────────────
// A centered command-palette style modal that lives in its own
// WebContentsView stacked on top of everything else. Cmd+K shows it;
// Esc or click outside the box hides it. Enter submits to LinkedIn's
// search results page in the LI tab.
const SEARCH_OVERLAY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    background: rgba(10, 10, 10, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-user-select: none;
    user-select: none;
  }
  .box {
    background: white;
    border-radius: 14px;
    padding: 16px 18px;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 520px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
  }
  .logo {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    background: #0A66C2;
    color: white;
    font-weight: 900;
    font-size: 19px;
    font-style: italic;
    font-family: Georgia, serif;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    letter-spacing: -0.5px;
  }
  .input-wrap {
    flex: 1;
    position: relative;
  }
  .input-wrap::before {
    content: '';
    position: absolute;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    background: no-repeat center/contain url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23536471' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='8'/><path d='m21 21-4.3-4.3'/></svg>");
  }
  input {
    width: 100%;
    border: 1px solid #d8d8d8;
    border-radius: 999px;
    padding: 11px 18px 11px 42px;
    font-size: 15px;
    color: #0a0a0a;
    background: white;
    outline: none;
    font-family: inherit;
    -webkit-user-select: text;
    user-select: text;
  }
  input:focus {
    border-color: #0A66C2;
    box-shadow: 0 0 0 3px rgba(10, 102, 194, 0.12);
  }
  .hint {
    position: absolute;
    bottom: -46px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.75);
    letter-spacing: 0.4px;
  }
  .hint kbd {
    display: inline-block;
    padding: 2px 5px;
    background: rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    font-family: -apple-system, sans-serif;
    font-size: 10px;
    color: white;
    margin: 0 2px;
  }
</style></head><body>
  <div class="box" id="box">
    <div class="logo">in</div>
    <div class="input-wrap">
      <input id="q" type="text" placeholder="I'm looking for…" autocomplete="off" spellcheck="false" />
      <div class="hint"><kbd>Enter</kbd> to search LinkedIn   &middot;   <kbd>Esc</kbd> to close</div>
    </div>
  </div>
  <script>
    const input = document.getElementById('q');
    const box = document.getElementById('box');

    function focusInput() {
      input.focus();
      input.select();
    }
    window.overlay.onShow(() => {
      input.value = '';
      focusInput();
    });
    // Focus immediately on load in case the first show event is missed.
    focusInput();
    window.addEventListener('focus', focusInput);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        window.overlay.hide();
      } else if (e.key === 'Enter') {
        const q = input.value.trim();
        if (q) window.overlay.submit(q);
      }
    });

    document.body.addEventListener('click', (e) => {
      if (!e.target.closest('#box')) {
        window.overlay.hide();
      }
    });
  </script>
</body></html>`

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
  // ── Search overlay view (topmost, hidden by default) ──
  searchOverlayView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      transparent: true,
    },
  })
  searchOverlayView.setBackgroundColor('#00000000')
  await searchOverlayView.webContents.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(SEARCH_OVERLAY_HTML),
  )
  searchOverlayView.setVisible(false)
  searchOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })

  // Z-order: first added = back. Tab bar + overlay are topmost.
  mainWindow.contentView.addChildView(whatsappView)
  mainWindow.contentView.addChildView(linkedinView)
  mainWindow.contentView.addChildView(sidebarView)
  mainWindow.contentView.addChildView(tabBarView)
  mainWindow.contentView.addChildView(searchOverlayView)

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
    searchOverlayView = null
  })
}

// ─── Search overlay show/hide ────────────────────────────────────────
function showSearchOverlay(): void {
  if (!mainWindow || !searchOverlayView) return
  const { width, height } = mainWindow.getContentBounds()
  searchOverlayView.setBounds({
    x: 0,
    y: 0,
    width,
    height,
  })
  searchOverlayView.setVisible(true)
  searchOverlayView.webContents.focus()
  searchOverlayView.webContents.send('overlay:shown')
  overlayVisible = true
}

function hideSearchOverlay(): void {
  if (!searchOverlayView) return
  searchOverlayView.setVisible(false)
  searchOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  overlayVisible = false
}

function toggleSearchOverlay(): void {
  if (overlayVisible) hideSearchOverlay()
  else showSearchOverlay()
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
  // Keep the overlay sized to the whole window when visible.
  if (overlayVisible && searchOverlayView) {
    const { width, height } = mainWindow.getContentBounds()
    searchOverlayView.setBounds({ x: 0, y: 0, width, height })
  }
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
          label: 'Search LinkedIn',
          accelerator: 'CmdOrCtrl+K',
          click: () => toggleSearchOverlay(),
        },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => toggleSidebar(),
        },
      ],
    },
    {
      label: 'Developer',
      submenu: [
        {
          label: 'WhatsApp DevTools',
          accelerator: 'CmdOrCtrl+Alt+W',
          click: () => whatsappView?.webContents.openDevTools({ mode: 'detach' }),
        },
        {
          label: 'LinkedIn DevTools',
          accelerator: 'CmdOrCtrl+Alt+L',
          click: () => linkedinView?.webContents.openDevTools({ mode: 'detach' }),
        },
        {
          label: 'Sidebar DevTools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => sidebarView?.webContents.openDevTools({ mode: 'detach' }),
        },
        { type: 'separator' },
        {
          label: 'Reload WhatsApp',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => whatsappView?.webContents.reload(),
        },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ─── IPC registration ────────────────────────────────────────────────
// ─── Auto-updater state & events ─────────────────────────────────────

type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

interface UpdaterStatus {
  currentVersion: string
  state: UpdaterState
  availableVersion?: string
  progressPercent?: number
  error?: string
  dev: boolean
}

let updaterStatus: UpdaterStatus = {
  currentVersion: app.getVersion(),
  state: 'idle',
  dev: !app.isPackaged,
}

function setUpdaterStatus(patch: Partial<UpdaterStatus>): void {
  updaterStatus = { ...updaterStatus, ...patch }
  sidebarView?.webContents.send('updater:status', updaterStatus)
}

/**
 * Custom installer for unsigned macOS builds.
 *
 * electron-updater's default install-on-quit flow invokes `codesign --verify`
 * on the newly-written bundle and rolls back when the app isn't signed. Our
 * app is intentionally unsigned (no Apple Developer account), so we sidestep
 * Squirrel entirely: spawn a detached shell script that waits for this
 * process to exit, ditto-extracts the already-downloaded ZIP to a temp dir,
 * rsyncs the new bundle over /Applications/Conversations.app, and relaunches.
 */
function runCustomInstaller(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')

  // electron-updater writes to ~/Library/Caches/conversations-updater/ on macOS.
  // Earlier versions of this function used the wrong base path (userData + ..
  // + Caches), which produced ~/Library/Application Support/Caches/... — a
  // path that never exists. Electron's app.getPath() has no 'cache' key; we
  // derive it from the home dir explicitly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os') as typeof import('os')
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'conversations-updater')
  const topLevelZip = path.join(cacheDir, 'update.zip')
  const pendingDir = path.join(cacheDir, 'pending')
  const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '')

  // Prefer the top-level update.zip (electron-updater writes it after a
  // successful download). Fall back to the first *.zip inside pending/ in
  // case the layout changes between updater versions.
  let usableZip: string | null = null
  if (fs.existsSync(topLevelZip)) {
    usableZip = topLevelZip
  } else if (fs.existsSync(pendingDir)) {
    const zipInPending = fs
      .readdirSync(pendingDir)
      .filter((f: string) => f.endsWith('.zip'))
      .map((f: string) => path.join(pendingDir, f))[0]
    if (zipInPending) usableZip = zipInPending
  }

  if (!usableZip) {
    setUpdaterStatus({ state: 'error', error: 'Downloaded update ZIP not found' })
    return
  }

  const tmpExtract = `/tmp/conversations-update-${Date.now()}`
  const pid = process.pid

  const script = `
set -e
# Wait for the running app process to actually exit
i=0
while ps -p ${pid} > /dev/null 2>&1; do
  i=$((i+1))
  if [ $i -gt 50 ]; then break; fi
  sleep 0.2
done

mkdir -p "${tmpExtract}"
/usr/bin/ditto -xk "${usableZip}" "${tmpExtract}"

# Find the new .app inside the extract dir (usually Conversations.app at root)
NEW_APP=$(find "${tmpExtract}" -maxdepth 2 -name "*.app" -type d | head -1)
if [ -z "$NEW_APP" ]; then exit 1; fi

# Atomic-ish replace: delete old, move new into place
/bin/rm -rf "${appPath}"
/bin/mv "$NEW_APP" "${appPath}"

# Drop the xattr that Gatekeeper sometimes adds to extracted content
/usr/bin/xattr -d com.apple.quarantine "${appPath}" 2>/dev/null || true

/bin/rm -rf "${tmpExtract}"

# Relaunch
/usr/bin/open "${appPath}"
`.trim()

  try {
    const child = cp.spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    // Give the shell a tick to actually start before we quit
    setTimeout(() => app.quit(), 200)
  } catch (err: unknown) {
    setUpdaterStatus({ state: 'error', error: String((err as Error)?.message ?? err) })
  }
}

// ─── Phase 5a: retroactive-import types, DOM scanner, window grouping ─

interface HistoricalEntry {
  timestamp: number
  direction: 'inbound' | 'outbound'
  dataId: string
  text: string | null // body of the message (null for stickers/media without caption)
}

interface BackfillImportInput {
  contactId: string
  phone: string
  entries: HistoricalEntry[]
  reachedStart?: boolean
}

interface BackfillImportResult {
  windowsFound: number
  windowsImported: number
  skipped: number
  error?: string
}

// Script injected into WhatsApp's webContents via executeJavaScript. Must be
// SELF-CONTAINED (no outer-scope references) because it runs in the page's
// main world, not in our preload's isolated context.
//
// Two flavors:
//   - BACKFILL_SCAN_SCRIPT: single-pass scan of whatever WA has preloaded.
//     Fast; returns immediately. Used when user wants to skip scrolling.
//   - BACKFILL_SCROLL_AND_SCAN_SCRIPT: scroll chat pane to top until WA stops
//     loading older messages, then scan. Can take 30+ seconds for chats with
//     many months of history; returns ALL visible messages after the scroll.
const BACKFILL_SCAN_SCRIPT = `
(function() {
  function parseTs(s) {
    var c = s.lastIndexOf(','); if (c === -1) return null;
    var t = s.slice(0, c).trim(), d = s.slice(c + 1).trim();
    var p = d.split('/'); if (p.length !== 3) return null;
    var p0 = parseInt(p[0]), p1 = parseInt(p[1]), y = parseInt(p[2]);
    if (isNaN(y) || p[2].length !== 4) return null;
    var mo, da;
    if (p0 > 12) { da = p0; mo = p1; } else { mo = p0; da = p1; }
    var tm = t.match(/(\\d+):(\\d+)/); if (!tm) return null;
    var h = parseInt(tm[1]), mi = parseInt(tm[2]);
    if (/p[.\\s]*m/i.test(t) && h !== 12) h += 12;
    else if (/a[.\\s]*m/i.test(t) && h === 12) h = 0;
    var dt = new Date(y, mo - 1, da, h, mi);
    return isNaN(dt.getTime()) ? null : dt.getTime();
  }
  try {
    var entries = [];
    var seen = new Set();
    var els = document.querySelectorAll('[data-pre-plain-text]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var pre = el.getAttribute('data-pre-plain-text') || '';
      var m = pre.match(/\\[([^\\]]+)\\]/);
      if (!m) continue;
      var ts = parseTs(m[1]);
      if (!ts) continue;
      var bubble = el.closest('[data-id]');
      var dataId = bubble ? (bubble.getAttribute('data-id') || '') : '';
      if (!dataId) continue;
      if (seen.has(dataId)) continue;
      seen.add(dataId);
      var isIn = !!(el.closest('.message-in') || (bubble && bubble.closest('.message-in')));
      // Extract message text for Gemini summarization (Phase 5b). Prefer
      // the canonical copyable-text span; fall back to bubble innerText
      // minus the trailing "HH:MM" timestamp.
      var text = null;
      if (bubble) {
        var cp = bubble.querySelector('span.selectable-text.copyable-text, span.copyable-text, span.selectable-text, div.copyable-text span');
        if (cp && cp.innerText) {
          var t = cp.innerText.trim();
          if (t) text = t;
        }
        if (!text) {
          var raw = (bubble.innerText || '').trim();
          if (raw) text = raw.replace(/\s*\d{1,2}:\d{2}\s*$/, '').trim() || null;
        }
      }
      entries.push({
        timestamp: ts,
        direction: isIn ? 'inbound' : 'outbound',
        dataId: dataId,
        text: text,
      });
    }
    return entries;
  } catch (e) { return []; }
})()
`.trim()

// Same scanner but wrapped in an auto-scroll loop. Returns a Promise to the
// host (executeJavaScript unwraps it). Scrolls the chat pane to top, waits
// for WA to load older messages, rescans, repeats until we hit either:
//   - stable scroll height for 2 consecutive iterations (nothing new loading)
//   - max iterations (safety cap, ~60s worth of scrolling)
//
// The DOM observation is tricky because WA virtualizes the message list —
// old messages get recycled out of the DOM as you scroll. We capture entries
// into our Set on every pass, so even if WA removes them from the DOM later,
// we still have them.
const BACKFILL_SCROLL_AND_SCAN_SCRIPT = `
(async function() {
  function parseTs(s) {
    var c = s.lastIndexOf(','); if (c === -1) return null;
    var t = s.slice(0, c).trim(), d = s.slice(c + 1).trim();
    var p = d.split('/'); if (p.length !== 3) return null;
    var p0 = parseInt(p[0]), p1 = parseInt(p[1]), y = parseInt(p[2]);
    if (isNaN(y) || p[2].length !== 4) return null;
    var mo, da;
    if (p0 > 12) { da = p0; mo = p1; } else { mo = p0; da = p1; }
    var tm = t.match(/(\\d+):(\\d+)/); if (!tm) return null;
    var h = parseInt(tm[1]), mi = parseInt(tm[2]);
    if (/p[.\\s]*m/i.test(t) && h !== 12) h += 12;
    else if (/a[.\\s]*m/i.test(t) && h === 12) h = 0;
    var dt = new Date(y, mo - 1, da, h, mi);
    return isNaN(dt.getTime()) ? null : dt.getTime();
  }
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function pickPane() {
    // Find the scrollable messages pane. Several candidate selectors across
    // WA versions; pick the first one that actually has a non-zero scrollHeight.
    var candidates = [
      'div.copyable-area [role="application"]',
      'div.copyable-area',
      '#main [role="application"]',
      '#main div[data-tab]',
    ];
    for (var i = 0; i < candidates.length; i++) {
      var el = document.querySelector(candidates[i]);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    // Fallback: find any div inside the right-hand area with a scrollbar.
    var divs = document.querySelectorAll('div');
    var best = null, bestArea = 0;
    for (var i = 0; i < divs.length; i++) {
      var d = divs[i];
      var r = d.getBoundingClientRect();
      if (r.left < 400) continue; // skip left sidebar
      if (d.scrollHeight <= d.clientHeight) continue;
      var a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = d; }
    }
    return best;
  }
  function scanInto(seen, entries) {
    var els = document.querySelectorAll('[data-pre-plain-text]');
    var added = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var pre = el.getAttribute('data-pre-plain-text') || '';
      var m = pre.match(/\\[([^\\]]+)\\]/);
      if (!m) continue;
      var ts = parseTs(m[1]);
      if (!ts) continue;
      var bubble = el.closest('[data-id]');
      var dataId = bubble ? (bubble.getAttribute('data-id') || '') : '';
      if (!dataId) continue;
      if (seen.has(dataId)) continue;
      seen.add(dataId);
      added++;
      var isIn = !!(el.closest('.message-in') || (bubble && bubble.closest('.message-in')));
      var text = null;
      if (bubble) {
        var cp = bubble.querySelector('span.selectable-text.copyable-text, span.copyable-text, span.selectable-text, div.copyable-text span');
        if (cp && cp.innerText) {
          var tx = cp.innerText.trim();
          if (tx) text = tx;
        }
        if (!text) {
          var raw = (bubble.innerText || '').trim();
          if (raw) text = raw.replace(/\\s*\\d{1,2}:\\d{2}\\s*$/, '').trim() || null;
        }
      }
      entries.push({ timestamp: ts, direction: isIn ? 'inbound' : 'outbound', dataId: dataId, text: text });
    }
    return added;
  }

  function clickOlderMessagesButton() {
    // WhatsApp Web shows "Click here to get older messages from your phone"
    // when scroll hits top AND there's more on the device not yet streamed.
    // The button is a clickable div with exactly that text (Spanish variants
    // exist too). We do a broad text match across buttons/divs/spans in main.
    var main = document.querySelector('#main') || document.body;
    var needles = [
      'get older messages from your phone',
      'obtener mensajes más antiguos',
      'cargar mensajes anteriores',
      'older messages',
    ];
    var candidates = main.querySelectorAll('button, [role="button"], div, span');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var t = (el.innerText || '').toLowerCase();
      if (t.length > 120) continue; // skip long elements
      for (var j = 0; j < needles.length; j++) {
        if (t.indexOf(needles[j]) !== -1) {
          try {
            // Click the most specific element (the leaf), which is usually a span.
            // We still dispatch on the outer clickable — walk up to nearest
            // button/[role=button] or use the matched el.
            var target = el;
            var parent = el;
            for (var k = 0; k < 5; k++) {
              if (!parent) break;
              if (parent.tagName === 'BUTTON' || parent.getAttribute('role') === 'button') {
                target = parent; break;
              }
              parent = parent.parentElement;
            }
            target.click();
            return true;
          } catch (_) { /* swallow */ }
        }
      }
    }
    return false;
  }

  try {
    var seen = new Set();
    var entries = [];
    scanInto(seen, entries); // initial pass

    var pane = pickPane();
    if (!pane) {
      return { entries: entries, scrolls: 0, clicks: 0, note: 'no-pane' };
    }

    // Tunables. The "Click here to get older messages from your phone" button
    // can appear MANY times in a long archive — each click pulls a new chunk
    // from the phone, then the button re-appears at the new top once you
    // scroll up again. Pattern: scroll → click → scroll → click ... until
    // no new entries arrive after N consecutive attempts.
    var MAX_ITER = 600;    // absolute safety cap (~6-7 min worst case)
    var WAIT_MS = 700;     // time for WA to render older chunk after scrollTop=0
    var CLICK_WAIT_MS = 1800; // WA needs longer to fetch from phone after click
    var MAX_CONSECUTIVE_STABLE = 2; // scroll-stable readings before first click attempt
    var MAX_CLICK_ATTEMPTS_NO_PROGRESS = 5; // user rule: try 5 times before giving up
    var stableCount = 0;
    var clickAttemptsNoProgress = 0;
    var lastHeight = pane.scrollHeight;
    var scrolls = 0;
    var clicks = 0;
    var reachedStart = false;

    for (var iter = 0; iter < MAX_ITER; iter++) {
      pane.scrollTop = 0;
      await sleep(WAIT_MS);
      scanInto(seen, entries);
      scrolls++;
      var h = pane.scrollHeight;
      if (h !== lastHeight) {
        // New chunk auto-streamed in — keep scrolling, don't click yet.
        stableCount = 0;
        clickAttemptsNoProgress = 0;
        lastHeight = h;
        continue;
      }

      stableCount++;
      if (stableCount < MAX_CONSECUTIVE_STABLE) continue;

      // Scroll-top is stable. Try the "older messages from your phone" button.
      var beforeAttempt = entries.length;
      var clicked = clickOlderMessagesButton();
      if (clicked) clicks++;

      // Whether the click succeeded or not, give WA a chance to fetch from
      // the phone and surface new content, then scroll + rescan twice to
      // consume it. Doing this even when the button wasn't found handles
      // the race where the button is still rendering in a child frame.
      await sleep(CLICK_WAIT_MS);
      pane.scrollTop = 0;
      await sleep(WAIT_MS);
      scanInto(seen, entries);
      pane.scrollTop = 0;
      await sleep(WAIT_MS);
      scanInto(seen, entries);

      var newEntries = entries.length - beforeAttempt;
      if (newEntries > 0) {
        // Progress! Reset counters — we might get more on the next cycle.
        clickAttemptsNoProgress = 0;
        stableCount = 0;
        lastHeight = pane.scrollHeight;
      } else {
        clickAttemptsNoProgress++;
        if (clickAttemptsNoProgress >= MAX_CLICK_ATTEMPTS_NO_PROGRESS) {
          // 5 cycles in a row with no new messages → we're genuinely done.
          reachedStart = true;
          break;
        }
        // Keep the stable counter elevated so the next iter will try
        // clicking again (rather than expecting another scroll-delta first).
        stableCount = MAX_CONSECUTIVE_STABLE;
      }
    }

    return { entries: entries, scrolls: scrolls, clicks: clicks, reachedStart: reachedStart };
  } catch (e) {
    return { entries: [], scrolls: 0, clicks: 0, reachedStart: false, error: String(e && e.message || e) };
  }
})()
`.trim()

/**
 * Given sorted entries from scanHistoricalMessages, group into FIXED 6h windows
 * (same semantics as the Chrome extension's groupInto6HourWindows — a window
 * starts at the first message and closes at start+6h; new windows begin on the
 * next message outside that range).
 *
 * Note: the live SessionManager uses SLIDING 6h windows, but for historical
 * backfill fixed windows are simpler and match how the extension wrote rows.
 */
interface BackfillWindow {
  timestamp: number
  direction: 'inbound' | 'outbound'
  messageCount: number
  windowEnd: number
  // Phase 5b: retain the actual message entries so we can hand their text
  // to Gemini for a real 2-line summary per window, instead of writing the
  // "[backfill] N mensajes" placeholder.
  entries: HistoricalEntry[]
}

function groupInto6HourWindows(entries: HistoricalEntry[]): BackfillWindow[] {
  if (entries.length === 0) return []
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)
  const SIX_HOURS = 6 * 60 * 60 * 1000
  const windows: BackfillWindow[] = []
  let group: HistoricalEntry[] = []
  let windowStart = sorted[0].timestamp

  const flush = () => {
    if (group.length === 0) return
    const outCount = group.filter((e) => e.direction === 'outbound').length
    const inCount = group.length - outCount
    windows.push({
      timestamp: windowStart,
      direction: outCount >= inCount ? 'outbound' : 'inbound',
      messageCount: group.length,
      windowEnd: windowStart + SIX_HOURS,
      entries: [...group],
    })
  }

  for (const entry of sorted) {
    if (entry.timestamp - windowStart > SIX_HOURS) {
      flush()
      windowStart = entry.timestamp
      group = [entry]
    } else {
      group.push(entry)
    }
  }
  flush()
  return windows
}

/**
 * Build a Gemini-friendly conversation string from a set of messages in a
 * single 6h window. Format:
 *   [HH:MM] Ellos: ...
 *   [HH:MM] Yo: ...
 *
 * Drops messages with no text (stickers, media-no-caption). Returns null
 * when the window has zero substantive text.
 */
function buildConversationText(win: BackfillWindow): string | null {
  const lines: string[] = []
  for (const e of win.entries) {
    if (!e.text) continue
    const d = new Date(e.timestamp)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const speaker = e.direction === 'outbound' ? 'Yo' : 'Ellos'
    lines.push(`[${hh}:${mm}] ${speaker}: ${e.text}`)
  }
  if (lines.length === 0) return null
  return lines.join('\n')
}

/**
 * Core of the backfill action. For each 6h window, check whether an
 * interaction already exists for that day/contact/whatsapp (to stay
 * idempotent) and if not, insert {interaction, extension_interaction_window}
 * rows directly to Supabase. We bypass the sync_queue here because the
 * backfill is user-initiated and synchronous — no offline retry semantics
 * needed for the first slice.
 */
async function importBackfillWindows(
  input: BackfillImportInput,
): Promise<BackfillImportResult> {
  const { getSupabase } = await import('./supabase/client')
  const { summarizeSession } = await import('./ai/gemini')
  const client = getSupabase()

  const {
    data: { user },
  } = await client.auth.getUser()
  if (!user) {
    return { windowsFound: 0, windowsImported: 0, skipped: 0, error: 'not-signed-in' }
  }

  const windows = groupInto6HourWindows(input.entries)
  let imported = 0
  let skipped = 0

  for (const win of windows) {
    const interactionDate = new Date(win.timestamp).toISOString().split('T')[0]

    // Idempotency + upgrade:
    //   - No row yet  → INSERT
    //   - Row exists with placeholder notes ([backfill] ...)  → UPDATE with
    //     Gemini summary (retroactive upgrade from phase 5a → 5b)
    //   - Row exists with real notes  → skip (never overwrite user content)
    const { data: existing } = await client
      .from('interactions')
      .select('id, notes')
      .eq('user_id', user.id)
      .eq('contact_id', input.contactId)
      .eq('interaction_date', interactionDate)
      .eq('type', 'whatsapp')
      .maybeSingle()

    // Phase 5b: build the real conversation text and ask Gemini for a
    // 2-line summary. Falls back to the placeholder if text is empty
    // (e.g. a window of only stickers) or Gemini call fails.
    const conversationText = buildConversationText(win)
    let notes = `[backfill] ${win.messageCount} mensajes`
    if (conversationText) {
      try {
        const summary = await summarizeSession(conversationText)
        if (summary && summary.trim()) {
          notes = summary.trim()
        }
      } catch (err) {
        console.warn('[backfill] gemini summary failed:', err)
      }
    }

    if (existing) {
      const existingNotes = (existing as { notes: string | null }).notes ?? ''
      const isPlaceholder = /^\[backfill\]/.test(existingNotes.trim())
      if (!isPlaceholder) {
        skipped++
        continue
      }
      // Only upgrade if we actually got a real summary from Gemini. If the
      // new notes are still a [backfill] placeholder (e.g. no text in this
      // window), leave the DB value as-is and just count it as skipped.
      if (/^\[backfill\]/.test(notes)) {
        skipped++
        continue
      }
      const { error: uErr } = await client
        .from('interactions')
        .update({ notes })
        .eq('id', (existing as { id: string }).id)
      if (uErr) {
        console.warn('[backfill] interaction update failed:', uErr)
        continue
      }
      imported++
      continue
    }

    const { data: interaction, error: iErr } = await client
      .from('interactions')
      .insert({
        user_id: user.id,
        contact_id: input.contactId,
        type: 'whatsapp',
        direction: win.direction,
        notes,
        interaction_date: interactionDate,
      })
      .select('id')
      .single()

    if (iErr || !interaction) {
      console.warn('[backfill] interaction insert failed:', iErr)
      continue
    }

    const windowStartIso = new Date(win.timestamp).toISOString()
    const windowEndIso = new Date(win.windowEnd).toISOString()

    const { error: wErr } = await client
      .from('extension_interaction_windows')
      .insert({
        user_id: user.id,
        contact_id: input.contactId,
        interaction_id: interaction.id,
        channel: 'whatsapp',
        window_start: windowStartIso,
        window_end: windowEndIso,
        direction: win.direction,
        message_count: win.messageCount,
      })

    if (wErr) console.warn('[backfill] window insert failed:', wErr)
    imported++
  }

  // Mark this contact's WhatsApp channel as scanned. Gates the "new/reactivated"
  // KPI in reThink — without this flag, a freshly-auto-detected contact can't
  // be safely classified as "new" (could just be an unscanned old chat).
  try {
    const { error: cErr } = await client
      .from('contact_channels')
      .update({
        backfilled_at: new Date().toISOString(),
        backfill_reached_start: input.reachedStart === true,
      })
      .eq('outreach_log_id', input.contactId)
      .eq('channel', 'whatsapp')
    if (cErr) console.warn('[backfill] contact_channels update failed:', cErr)
  } catch (e) {
    console.warn('[backfill] contact_channels update threw:', e)
  }

  return { windowsFound: windows.length, windowsImported: imported, skipped }
}

function wireUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    setUpdaterStatus({ state: 'checking', error: undefined })
  })
  autoUpdater.on('update-available', (info) => {
    setUpdaterStatus({ state: 'available', availableVersion: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    setUpdaterStatus({ state: 'not-available' })
  })
  autoUpdater.on('download-progress', (p) => {
    setUpdaterStatus({ state: 'downloading', progressPercent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    setUpdaterStatus({ state: 'downloaded', availableVersion: info.version })
  })
  autoUpdater.on('error', (err) => {
    setUpdaterStatus({ state: 'error', error: String(err?.message ?? err) })
  })
}

function registerIpc(): void {
  ipcMain.handle('sidebar:toggle', () => toggleSidebar())

  // Updater IPCs — explicit 3-step flow:
  //   check → (if available) download → (when downloaded) restart-install
  ipcMain.handle('updater:get-status', () => updaterStatus)
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      setUpdaterStatus({ state: 'error', error: 'Dev mode — updater unavailable' })
      return updaterStatus
    }
    try {
      setUpdaterStatus({ state: 'checking', error: undefined })
      await autoUpdater.checkForUpdates()
    } catch (err: unknown) {
      setUpdaterStatus({ state: 'error', error: String((err as Error)?.message ?? err) })
    }
    return updaterStatus
  })
  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) {
      return updaterStatus
    }
    if (updaterStatus.state !== 'available' && updaterStatus.state !== 'error') {
      return updaterStatus
    }
    try {
      await autoUpdater.downloadUpdate()
    } catch (err: unknown) {
      setUpdaterStatus({ state: 'error', error: String((err as Error)?.message ?? err) })
    }
    return updaterStatus
  })
  ipcMain.handle('updater:restart-install', () => {
    if (updaterStatus.state === 'downloaded') {
      runCustomInstaller()
    }
  })

  // ─── Phase 5a: retroactive backfill ─────────────────────────────
  // Scan the currently-open WhatsApp chat's visible message history and
  // return normalized entries {timestamp, direction}. Read-only — does not
  // touch the DOM or navigate. Limited to messages WhatsApp has preloaded
  // (no auto-scroll yet — that's Phase 5b).
  ipcMain.handle('backfill:scan-history', async () => {
    if (!whatsappView) return { entries: [] as HistoricalEntry[], error: 'wa-view-missing' }
    try {
      const entries = (await whatsappView.webContents.executeJavaScript(
        BACKFILL_SCAN_SCRIPT,
        true,
      )) as HistoricalEntry[]
      return { entries }
    } catch (err: unknown) {
      return { entries: [], error: String((err as Error)?.message ?? err) }
    }
  })
  ipcMain.handle('backfill:scan-with-scroll', async () => {
    if (!whatsappView) return { entries: [] as HistoricalEntry[], error: 'wa-view-missing' }
    try {
      const result = (await whatsappView.webContents.executeJavaScript(
        BACKFILL_SCROLL_AND_SCAN_SCRIPT,
        true,
      )) as {
        entries: HistoricalEntry[]
        scrolls: number
        clicks?: number
        reachedStart?: boolean
        error?: string
        note?: string
      }
      console.log(
        '[backfill] scroll-and-scan → entries=' + result.entries.length,
        'scrolls=' + result.scrolls,
        result.clicks ? 'clicks=' + result.clicks : '',
        result.reachedStart ? 'reached-start' : '',
        result.error ? 'err=' + result.error : '',
        result.note ? 'note=' + result.note : '',
      )
      return {
        entries: result.entries,
        scrolls: result.scrolls,
        clicks: result.clicks ?? 0,
        reachedStart: result.reachedStart ?? false,
        error: result.error,
      }
    } catch (err: unknown) {
      return { entries: [], scrolls: 0, clicks: 0, reachedStart: false, error: String((err as Error)?.message ?? err) }
    }
  })

  // Take raw entries + a known contact/user, group into 6h windows, and
  // enqueue one interaction per window to the sync_queue. Skips windows
  // that already have a matching (user_id, contact_id, date, type='whatsapp')
  // interaction in Supabase so the button is idempotent.
  ipcMain.handle(
    'backfill:import-windows',
    async (_event, input: BackfillImportInput) => {
      return importBackfillWindows(input)
    },
  )

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

  // WhatsApp preload → per-message capture + session management.
  ipcMain.on('wa:message', (_event, payload: MessageInput) => {
    void (async () => {
      try {
        if (!payload || !payload.wa_data_id) return
        if (payload.chat_kind === 'group') return

        const msgId = insertMessage(payload)
        if (msgId == null) return // dedupe

        console.log(
          '[main] wa:message id=%d chat=%s dir=%s text="%s"',
          msgId,
          payload.chat_phone,
          payload.direction,
          (payload.text ?? '').slice(0, 40),
        )

        // Resolve phone → contactId (cached after first lookup per phone).
        let contactId = phoneContactIdCache.get(payload.chat_phone)
        if (contactId === undefined) {
          // First message for this phone in this app session → resolve async.
          try {
            const { getSupabase } = await import('./supabase/client')
            const { phoneVariants } = await import('./utils/phone')
            const supabase = getSupabase()
            const variants = phoneVariants(payload.chat_phone)

            // Try contact_channels first (same logic as resolveContactIdByPhone)
            let resolved: string | null = null
            const { data: ch } = await supabase
              .from('contact_channels')
              .select('outreach_log_id')
              .eq('channel', 'whatsapp')
              .in('channel_identifier', variants)
              .limit(1)
              .maybeSingle()
            if (ch) resolved = ch.outreach_log_id as string

            if (!resolved) {
              const { data: mp } = await supabase
                .from('contact_phone_mappings')
                .select('contact_id')
                .in('phone_number', variants)
                .limit(1)
                .maybeSingle()
              if (mp) resolved = mp.contact_id as string
            }

            if (!resolved) {
              const { data: ol } = await supabase
                .from('outreach_logs')
                .select('id')
                .in('phone', variants)
                .limit(1)
                .maybeSingle()
              if (ol) resolved = ol.id as string
            }

            phoneContactIdCache.set(payload.chat_phone, resolved)
            contactId = resolved
            console.log(
              '[main] resolved contactId for %s → %s',
              payload.chat_phone,
              contactId ?? 'null (unmapped)',
            )
          } catch (err) {
            console.error('[main] contactId resolution failed:', err)
            phoneContactIdCache.set(payload.chat_phone, null)
            contactId = null
          }
        }

        const sessionId = handleMessage(payload, contactId ?? null)
        assignMessageToSession(msgId, sessionId)
      } catch (err) {
        console.error('[main] wa:message processing failed:', err)
      }
    })()
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

  // Invalidate the phone→contactId cache after a contact is created or
  // mapped from the sidebar. Without this, messages arriving after the
  // creation would still use the stale null cache entry and sessions would
  // remain unmapped.
  ipcMain.on('main:invalidatePhoneCache', (_event, phone: string) => {
    if (phone) {
      phoneContactIdCache.delete(phone)
      console.log('[main] invalidated phone cache for', phone)
    }
  })

  // Search overlay
  ipcMain.on('overlay:hide', () => hideSearchOverlay())
  ipcMain.on('overlay:submit', (_event, query: string) => {
    if (typeof query !== 'string' || !query.trim()) return
    const q = query.trim()
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`
    hideSearchOverlay()
    switchTab('li')
    linkedinView?.webContents.loadURL(url).catch(() => {})
  })
}

// ─── Lifecycle ───────────────────────────────────────────────────────
app.setName('Conversations')

app.whenReady().then(async () => {
  buildMenu()
  registerIpc()
  // Recover any sessions that were left open from a previous run
  // (e.g., app crashed while a 6h window was active).
  recoverOpenSessions()
  // Start the sync worker that drains sync_queue → Supabase every 10s.
  startSync()
  // Auto-update via GitHub Releases.
  // Explicit flow (no silent auto-download, no auto-install-on-quit):
  //   user clicks "Install" in Settings → we downloadUpdate()
  //   user clicks "Restart" in Settings → we run our own installer script
  //   (native autoInstallOnAppQuit fails silently on unsigned macOS builds).
  if (app.isPackaged) {
    autoUpdater.logger = {
      info: (msg: unknown) => console.log('[updater]', msg),
      warn: (msg: unknown) => console.warn('[updater]', msg),
      error: (msg: unknown) => console.error('[updater]', msg),
      debug: (msg: unknown) => console.log('[updater:debug]', msg),
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    wireUpdaterEvents()
    // Fire one initial check at boot so the "Available" state is seen
    // immediately in Settings. Download does NOT start automatically.
    autoUpdater.checkForUpdates().catch((err) => {
      setUpdaterStatus({ state: 'error', error: String(err?.message ?? err) })
    })
  }
  await createMainWindow()

  app.on('activate', async () => {
    if (!mainWindow) await createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopSync()
})
