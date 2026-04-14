import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// The renderer lives in `renderer/`. Vite builds it to `dist/renderer/`.
// In dev, Electron loads the sidebar from http://localhost:5173; in prod it loads from the built file.

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'renderer'),
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
})
