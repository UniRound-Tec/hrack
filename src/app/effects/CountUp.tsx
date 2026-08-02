import { useInView, useMotionValue, useSpring } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'

export interface CountUpProps {
  to: number
  from?: number
  direction?: 'up' | 'down'
  delay?: number
  duration?: number
  className?: string
  startWhen?: boolean
  separator?: string
  onStart?: () => void
  onEnd?: () => void
}

function decimalPlaces(value: number): number {
  const [, decimals = ''] = value.toString().split('.')
  return Number.parseInt(decimals, 10) === 0 ? 0 : decimals.length
}

export default function CountUp({
  to,
  from = 0,
  direction = 'up',
  delay = 0,
  duration = 2,
  className = '',
  startWhen = true,
  separator = '',
  onStart,
  onEnd
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const motionValue = useMotionValue(direction === 'down' ? to : from)
  const springValue = useSpring(motionValue, {
    damping: 20 + 40 * (1 / duration),
    stiffness: 100 * (1 / duration)
  })
  const isInView = useInView(ref, { once: true, margin: '0px' })
  const maxDecimals = useMemo(
    () => Math.max(decimalPlaces(from), decimalPlaces(to)),
    [from, to]
  )
  const formatValue = useCallback(
    (latest: number) => {
      const formatted = Intl.NumberFormat('en-US', {
        useGrouping: Boolean(separator),
        minimumFractionDigits: maxDecimals,
        maximumFractionDigits: maxDecimals
      }).format(latest)
      return separator ? formatted.replaceAll(',', separator) : formatted
    },
    [maxDecimals, separator]
  )

  useEffect(() => {
    if (ref.current) {
      ref.current.textContent = formatValue(direction === 'down' ? to : from)
    }
  }, [direction, formatValue, from, to])

  useEffect(() => {
    if (!isInView || !startWhen) return
    onStart?.()
    const startTimer = setTimeout(() => {
      motionValue.set(direction === 'down' ? from : to)
    }, delay * 1000)
    const endTimer = setTimeout(() => onEnd?.(), (delay + duration) * 1000)
    return () => {
      clearTimeout(startTimer)
      clearTimeout(endTimer)
    }
  }, [
    delay,
    direction,
    duration,
    from,
    isInView,
    motionValue,
    onEnd,
    onStart,
    startWhen,
    to
  ])

  useEffect(
    () =>
      springValue.on('change', (latest) => {
        if (ref.current) ref.current.textContent = formatValue(latest)
      }),
    [formatValue, springValue]
  )

  return <span className={className} ref={ref} />
}
