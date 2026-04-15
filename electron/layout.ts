import type { BaseWindow, WebContentsView } from 'electron'

export const SIDEBAR_WIDTH = 340
export const TAB_BAR_HEIGHT = 38

export type LayoutInput = {
  win: BaseWindow
  tabBarView: WebContentsView
  activeContentView: WebContentsView
  inactiveContentViews: WebContentsView[]
  sidebarView: WebContentsView
  sidebarVisible: boolean
}

/**
 * Lays out the 3 zones:
 *   1. Tab bar — full width, fixed height at the top
 *   2. Active content (WhatsApp OR LinkedIn) — left of the sidebar, below the tab bar
 *   3. Sidebar — right column, below the tab bar
 *
 * Inactive content views are zeroed out + hidden so they stay cheap but their
 * web state (session, scroll, etc) persists.
 */
export function applyLayout(input: LayoutInput): void {
  const { win, tabBarView, activeContentView, inactiveContentViews, sidebarView, sidebarVisible } =
    input
  const { width, height } = win.getContentBounds()

  // Tab bar — full width, top
  tabBarView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT })
  tabBarView.setVisible(true)

  const belowTabs = Math.max(0, height - TAB_BAR_HEIGHT)
  const sidebarW = sidebarVisible ? SIDEBAR_WIDTH : 0
  const contentW = Math.max(0, width - sidebarW)

  activeContentView.setBounds({
    x: 0,
    y: TAB_BAR_HEIGHT,
    width: contentW,
    height: belowTabs,
  })
  activeContentView.setVisible(true)

  // Zero the inactive content views so they don't occupy any area
  for (const v of inactiveContentViews) {
    v.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    v.setVisible(false)
  }

  sidebarView.setBounds({
    x: contentW,
    y: TAB_BAR_HEIGHT,
    width: sidebarW,
    height: belowTabs,
  })
  sidebarView.setVisible(sidebarVisible)
}
