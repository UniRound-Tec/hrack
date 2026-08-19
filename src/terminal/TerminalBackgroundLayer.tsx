import type { CSSProperties } from 'react'
import {
  terminalBackgroundLayerCss,
  terminalBackgroundUrl,
  type TerminalBackgroundFit
} from '../../shared/terminal-background'

interface TerminalBackgroundLayerProps {
  revision: number
  fit: TerminalBackgroundFit
  opacity: number
  className?: string
  testId?: string
  style?: CSSProperties
}

export default function TerminalBackgroundLayer({
  revision,
  fit,
  opacity,
  className,
  testId,
  style
}: TerminalBackgroundLayerProps) {
  return (
    <div
      data-testid={testId}
      className={`pointer-events-none absolute inset-0 ${className ?? ''}`}
      style={{
        opacity,
        backgroundImage: `url("${terminalBackgroundUrl(revision)}")`,
        ...terminalBackgroundLayerCss(fit),
        ...style
      }}
    />
  )
}
