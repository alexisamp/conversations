import type { BaseWindow, WebContentsView } from 'electron'

export const SIDEBAR_WIDTH = 400

/**
 * Lays out the WhatsApp view on the left and the sidebar on the right.
 * When the sidebar is hidden, WhatsApp takes the full content area.
 */
export function applyLayout(
  win: BaseWindow,
  whatsappView: WebContentsView,
  sidebarView: WebContentsView,
  sidebarVisible: boolean,
): void {
  const { width, height } = win.getContentBounds()
  const sidebarW = sidebarVisible ? SIDEBAR_WIDTH : 0
  const whatsappW = Math.max(0, width - sidebarW)

  whatsappView.setBounds({ x: 0, y: 0, width: whatsappW, height })
  sidebarView.setBounds({ x: whatsappW, y: 0, width: sidebarW, height })
  sidebarView.setVisible(sidebarVisible)
}
