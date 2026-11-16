import { createRoot } from 'react-dom/client'
import '@dsh-bridge/web-kit/styles.css'
import '@dsh-bridge/web-kit/im-theme.css'
import './app.css'
import { App, type AppConfig } from './App.tsx'

const cfg = JSON.parse(document.getElementById('agent-settings-config')?.textContent ?? '{}') as AppConfig
createRoot(document.getElementById('root')!).render(<App cfg={cfg} />)
