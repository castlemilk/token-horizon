import { WindowFrame } from './shell'
import { TokenHorizonDashboard } from './components/token-horizon/dashboard'
import './styles/app.css'

export default function App() {
  return (
    <WindowFrame title="Token Horizon">
      <TokenHorizonDashboard />
    </WindowFrame>
  )
}
