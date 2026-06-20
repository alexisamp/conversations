// Preload for the tiny tab bar WebContentsView (inline HTML).
// Exposes a minimal API the inline HTML can call to switch tabs and
// receive active-tab updates from the main process.

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  switchTab: (name: 'wa' | 'li' | 'ai'): void => {
    ipcRenderer.send('tab:switch', name)
  },
  back: (): void => {
    ipcRenderer.send('tab:back')
  },
  forward: (): void => {
    ipcRenderer.send('tab:forward')
  },
  reload: (): void => {
    ipcRenderer.send('tab:reload')
  },
  home: (): void => {
    ipcRenderer.send('tab:home')
  },
  search: (): void => {
    ipcRenderer.send('tab:search')
  },
  onActiveChanged: (cb: (name: 'wa' | 'li' | 'ai') => void): void => {
    ipcRenderer.on('tab:active-changed', (_event, name: 'wa' | 'li' | 'ai') => cb(name))
  },
}

contextBridge.exposeInMainWorld('convTab', api)

export type ConvTabApi = typeof api
