// Preload for the tiny tab bar WebContentsView (inline HTML).
// Exposes a minimal API the inline HTML can call to switch tabs and
// receive active-tab updates from the main process.

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  switchTab: (name: 'wa' | 'li'): void => {
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
  onActiveChanged: (cb: (name: 'wa' | 'li') => void): void => {
    ipcRenderer.on('tab:active-changed', (_event, name: 'wa' | 'li') => cb(name))
  },
}

contextBridge.exposeInMainWorld('convTab', api)

export type ConvTabApi = typeof api
