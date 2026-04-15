// Preload for the centered LinkedIn search overlay (inline HTML).
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  hide: (): void => {
    ipcRenderer.send('overlay:hide')
  },
  submit: (query: string): void => {
    ipcRenderer.send('overlay:submit', query)
  },
  onShow: (cb: () => void): void => {
    ipcRenderer.on('overlay:shown', () => cb())
  },
}

contextBridge.exposeInMainWorld('overlay', api)

export type OverlayApi = typeof api
