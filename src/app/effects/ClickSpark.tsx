import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type ReactNode
} from 'react'

interface Spark {
  x: number
  y: number
  angle: number
  startTime: number
}

export interface ClickSparkProps {
  sparkColor?: string
  sparkSize?: number
  sparkRadius?: number
  sparkCount?: number
  duration?: number
  easing?: 'linear' | 'ease-in' | 'ease-in-out' | 'ease-out'
  extraScale?: number
  children: ReactNode
}

export default function ClickSpark({
  sparkColor = '#ffffff',
  sparkSize = 10,
  sparkRadius = 15,
  sparkCount = 8,
  duration = 400,
  easing = 'ease-out',
  extraScale = 1,
  children
}: ClickSparkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sparksRef = useRef<Spark[]>([])

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resizeCanvas = (): void => {
      const { width, height } = parent.getBoundingClientRect()
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resizeCanvas, 100)
    })
    observer.observe(parent)
    resizeCanvas()
    return () => {
      observer.disconnect()
      clearTimeout(resizeTimer)
    }
  }, [])

  const ease = useCallback(
    (value: number) => {
      switch (easing) {
        case 'linear':
          return value
        case 'ease-in':
          return value * value
        case 'ease-in-out':
          return value < 0.5
            ? 2 * value * value
            : -1 + (4 - 2 * value) * value
        default:
          return value * (2 - value)
      }
    },
    [easing]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let animationId = 0
    const draw = (timestamp: number): void => {
      context.clearRect(0, 0, canvas.width, canvas.height)
      sparksRef.current = sparksRef.current.filter((spark) => {
        const elapsed = timestamp - spark.startTime
        if (elapsed >= duration) return false
        const eased = ease(elapsed / duration)
        const distance = eased * sparkRadius * extraScale
        const lineLength = sparkSize * (1 - eased)
        const x1 = spark.x + distance * Math.cos(spark.angle)
        const y1 = spark.y + distance * Math.sin(spark.angle)
        const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle)
        const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle)
        context.strokeStyle = sparkColor
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
        context.stroke()
        return true
      })
      animationId = requestAnimationFrame(draw)
    }
    animationId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animationId)
  }, [duration, ease, extraScale, sparkColor, sparkRadius, sparkSize])

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const now = performance.now()
    sparksRef.current.push(
      ...Array.from({ length: sparkCount }, (_, index) => ({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        angle: (2 * Math.PI * index) / sparkCount,
        startTime: now
      }))
    )
  }

  return (
    <div className="relative h-full w-full" onClick={handleClick}>
      {children}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-[200] block h-full w-full select-none"
      />
    </div>
  )
}
