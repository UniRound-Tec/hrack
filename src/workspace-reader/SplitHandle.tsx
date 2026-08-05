import { useRef } from 'react'

interface SplitHandleProps {
  testId: string
  label: string
  value: number
  min: number
  max: number
  defaultValue: number
  dragDirection?: 1 | -1
  onChange(value: number): void
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

export default function SplitHandle({
  testId,
  label,
  value,
  min,
  max,
  defaultValue,
  dragDirection = 1,
  onChange
}: SplitHandleProps) {
  const drag = useRef<{ startX: number; startValue: number } | null>(null)

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className="group relative z-20 w-1.5 shrink-0 cursor-col-resize touch-none outline-none"
      onDoubleClick={() => onChange(clamp(defaultValue, min, max))}
      onPointerDown={(event) => {
        drag.current = { startX: event.clientX, startValue: value }
        event.currentTarget.setPointerCapture(event.pointerId)
        document.documentElement.classList.add('workspace-splitting')
      }}
      onPointerMove={(event) => {
        if (
          !drag.current ||
          !event.currentTarget.hasPointerCapture(event.pointerId)
        )
          return
        onChange(
          clamp(
            drag.current.startValue +
              (event.clientX - drag.current.startX) * dragDirection,
            min,
            max
          )
        )
      }}
      onPointerUp={(event) => {
        drag.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        document.documentElement.classList.remove('workspace-splitting')
      }}
      onLostPointerCapture={() => {
        drag.current = null
        document.documentElement.classList.remove('workspace-splitting')
      }}
      onKeyDown={(event) => {
        let next = value
        if (event.key === 'ArrowLeft') next -= 16
        else if (event.key === 'ArrowRight') next += 16
        else if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        else return
        event.preventDefault()
        onChange(clamp(next, min, max))
      }}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-subtle transition-colors group-hover:bg-text-faint group-focus:bg-text-muted" />
    </div>
  )
}
