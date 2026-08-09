import AppShell from './app/AppShell'
import FirstRunOnboarding from './app/FirstRunOnboarding'
import { useSettingsStore } from './state/settingsStore'

export default function App() {
  const onboardingCompleted = useSettingsStore(
    (state) => state.onboardingCompleted
  )
  const completeOnboarding = useSettingsStore(
    (state) => state.completeOnboarding
  )

  return onboardingCompleted ? (
    <AppShell />
  ) : (
    <FirstRunOnboarding onComplete={completeOnboarding} />
  )
}
