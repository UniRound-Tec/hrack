import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useTransform
} from 'motion/react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

export interface ShinyTextProps {
  text: string
  disabled?: boolean
  speed?: number
  className?: string
  color?: string
  shineColor?: string
  spread?: number
  yoyo?: boolean
  pauseOnHover?: boolean
  direction?: 'left' | 'right'
  delay?: number
}

export default function ShinyText({
  text,
  disabled = false,
  speed = 2,
  className = '',
  color = '#b5b5b5',
  shineColor = '#ffffff',
  spread = 120,
  yoyo = false,
  pauseOnHover = false,
  direction = 'left',
  delay = 0
}: ShinyTextProps) {
  const [isPaused, setIsPaused] = useState(false)
  const progress = useMotionValue(0)
  const elapsedRef = useRef(0)
  const lastTimeRef = useRef<number | null>(null)
  const directionRef = useRef(direction === 'left' ? 1 : -1)
  const animationDuration = speed * 1000
  const delayDuration = delay * 1000

  useAnimationFrame((time) => {
    if (disabled || isPaused) {
      lastTimeRef.current = null
      return
    }
    if (lastTimeRef.current === null) {
      lastTimeRef.current = time
      return
    }

    elapsedRef.current += time - lastTimeRef.current
    lastTimeRef.current = time
    if (yoyo) {
      const cycleDuration = animationDuration + delayDuration
      const cycleTime = elapsedRef.current % (cycleDuration * 2)
      if (cycleTime < animationDuration) {
        const value = (cycleTime / animationDuration) * 100
        progress.set(directionRef.current === 1 ? value : 100 - value)
      } else if (cycleTime < cycleDuration) {
        progress.set(directionRef.current === 1 ? 100 : 0)
      } else if (cycleTime < cycleDuration + animationDuration) {
        const value =
          100 - ((cycleTime - cycleDuration) / animationDuration) * 100
        progress.set(directionRef.current === 1 ? value : 100 - value)
      } else {
        progress.set(directionRef.current === 1 ? 0 : 100)
      }
      return
    }

    const cycleDuration = animationDuration + delayDuration
    const cycleTime = elapsedRef.current % cycleDuration
    if (cycleTime < animationDuration) {
      const value = (cycleTime / animationDuration) * 100
      progress.set(directionRef.current === 1 ? value : 100 - value)
    } else {
      progress.set(directionRef.current === 1 ? 100 : 0)
    }
  })

  useEffect(() => {
    directionRef.current = direction === 'left' ? 1 : -1
    elapsedRef.current = 0
    progress.set(0)
  }, [direction, progress])

  const backgroundPosition = useTransform(
    progress,
    (value) => `${150 - value * 2}% center`
  )
  const handleMouseEnter = useCallback(() => {
    if (pauseOnHover) setIsPaused(true)
  }, [pauseOnHover])
  const handleMouseLeave = useCallback(() => {
    if (pauseOnHover) setIsPaused(false)
  }, [pauseOnHover])
  const gradientStyle: CSSProperties = {
    backgroundImage: `linear-gradient(${spread}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`,
    backgroundSize: '200% auto',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    // Italic display fonts can paint outside their advance box. The gradient
    // only exists inside this element, so reserve bleed for those pixels and
    // cancel it with negative margins to keep surrounding layout unchanged.
    padding: '0.22em',
    margin: '-0.22em'
  }

  return (
    <motion.span
      className={`inline-block ${className}`}
      style={{ ...gradientStyle, backgroundPosition }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {text}
    </motion.span>
  )
}
