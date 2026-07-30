import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// 注意：不使用 <React.StrictMode>。StrictMode 会在 dev 下双触发 effect，
// 导致 xterm 被 mount→dispose→mount 且 pty 重复 spawn，违背 SPEC §5.1「只挂载一次」。
createRoot(document.getElementById('root')!).render(<App />)
