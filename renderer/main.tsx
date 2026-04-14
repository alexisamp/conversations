import { createRoot } from 'react-dom/client'
import { App } from './App'

// Note: `./conv-api` is an ambient .d.ts file consumed by TypeScript only —
// it has no runtime module, so we don't import it here.

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

createRoot(container).render(<App />)
