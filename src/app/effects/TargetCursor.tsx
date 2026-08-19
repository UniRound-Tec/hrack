import { gsap } from 'gsap'
import { useEffect, useMemo, useRef } from 'react'
import './TargetCursor.css'

export interface TargetCursorProps {
  targetSelector?: string
  hoverDuration?: number
  parallaxOn?: boolean
  cursorColor?: string
  cursorColorOnTarget?: string
  showCursor?: boolean
  hideDefaultCursor?: boolean
  spinDuration?: number
}

type CornerMode = 'snap' | 'lock' | 'parallax'

export default function TargetCursor({
  targetSelector = '.cursor-target',
  hoverDuration = 0.2,
  parallaxOn = true,
  cursorColor = '#ffffff',
  cursorColorOnTarget,
  showCursor = true,
  hideDefaultCursor = true,
  spinDuration = 2
}: TargetCursorProps) {
  const cursorRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLDivElement>(null)
  const spinTimelineRef = useRef<gsap.core.Timeline | null>(null)
  const activeTargetRef = useRef<Element | null>(null)
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animationFrameRef = useRef(0)
  const lastMouseRef = useRef({ x: 0, y: 0 })
  const isMobile = useMemo(() => {
    const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    const isSmallScreen = window.innerWidth <= 768
    const isMobileUserAgent =
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
        navigator.userAgent.toLowerCase()
      )
    return (hasTouchScreen && isSmallScreen) || isMobileUserAgent
  }, [])
  const constants = useMemo(() => ({ borderWidth: 3, cornerSize: 12 }), [])

  useEffect(() => {
    const cursor = cursorRef.current
    if (isMobile || !cursor) return
    const corners = Array.from(
      cursor.querySelectorAll<HTMLElement>('.target-cursor-corner')
    )
    const originalCursor = document.body.style.cursor
    if (hideDefaultCursor && showCursor) document.body.style.cursor = 'none'

    if (!showCursor) {
      gsap.set(corners, { opacity: 0, x: 0, y: 0 })
      if (dotRef.current) gsap.set(dotRef.current, { opacity: 0 })
    } else {
      gsap.set(corners, { opacity: 1 })
      spinTimelineRef.current = gsap
        .timeline({ repeat: -1 })
        .to(cursor, { rotation: '+=360', duration: spinDuration, ease: 'none' })
    }
    gsap.set(cursor, {
      xPercent: -50,
      yPercent: -50,
      x: window.innerWidth / 2,
      y: window.innerHeight / 2
    })

    const resolveTarget = (node: EventTarget | null): Element | null => {
      const element =
        node instanceof Element
          ? node
          : node instanceof Node
            ? node.parentElement
            : null
      return element?.closest(targetSelector) ?? null
    }
    const targetFromPoint = (x: number, y: number): Element | null =>
      resolveTarget(document.elementFromPoint(x, y))
    const clearLeaveTimer = (): void => {
      if (!leaveTimerRef.current) return
      clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
    const stopFollow = (): void => {
      if (!animationFrameRef.current) return
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = 0
    }
    const placeCornersOnTarget = (
      target: Element,
      mode: CornerMode = 'snap'
    ): void => {
      const rect = target.getBoundingClientRect()
      const cursorX = Number(gsap.getProperty(cursor, 'x')) || 0
      const cursorY = Number(gsap.getProperty(cursor, 'y')) || 0
      const { borderWidth, cornerSize } = constants
      const positions = [
        {
          x: rect.left - borderWidth - cursorX,
          y: rect.top - borderWidth - cursorY
        },
        {
          x: rect.right + borderWidth - cornerSize - cursorX,
          y: rect.top - borderWidth - cursorY
        },
        {
          x: rect.right + borderWidth - cornerSize - cursorX,
          y: rect.bottom + borderWidth - cornerSize - cursorY
        },
        {
          x: rect.left - borderWidth - cursorX,
          y: rect.bottom + borderWidth - cornerSize - cursorY
        }
      ]
      corners.forEach((corner, index) => {
        if (mode === 'snap') {
          gsap.set(corner, positions[index])
        } else {
          gsap.to(corner, {
            ...positions[index],
            duration: mode === 'lock' ? hoverDuration : 0.22,
            ease: mode === 'lock' ? 'power2.out' : 'power1.out',
            overwrite: 'auto'
          })
        }
      })
    }
    const followLoop = (): void => {
      const target = activeTargetRef.current
      if (!target) {
        animationFrameRef.current = 0
        return
      }
      if (!target.isConnected) {
        activeTargetRef.current = null
        stopFollow()
        if (!showCursor) gsap.set(corners, { opacity: 0 })
        return
      }
      placeCornersOnTarget(target, parallaxOn ? 'parallax' : 'snap')
      animationFrameRef.current = requestAnimationFrame(followLoop)
    }
    const showOnTarget = (target: Element): void => {
      clearLeaveTimer()
      activeTargetRef.current = target
      gsap.killTweensOf(cursor, 'rotation')
      spinTimelineRef.current?.pause()
      gsap.set(cursor, { rotation: 0 })
      gsap.set(corners, {
        opacity: 1,
        borderColor: cursorColorOnTarget ?? cursorColor
      })
      placeCornersOnTarget(target, 'lock')
      if (!animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(followLoop)
      }
    }
    const hideCorners = (): void => {
      activeTargetRef.current = null
      stopFollow()
      if (!showCursor) {
        gsap.to(corners, {
          opacity: 0,
          duration: 0.18,
          ease: 'power2.out',
          overwrite: 'auto'
        })
        return
      }
      const { cornerSize } = constants
      const idle = [
        { x: -cornerSize * 1.5, y: -cornerSize * 1.5 },
        { x: cornerSize * 0.5, y: -cornerSize * 1.5 },
        { x: cornerSize * 0.5, y: cornerSize * 0.5 },
        { x: -cornerSize * 1.5, y: cornerSize * 0.5 }
      ]
      corners.forEach((corner, index) => {
        gsap.to(corner, {
          ...idle[index],
          borderColor: cursorColor,
          duration: 0.25,
          ease: 'power3.out',
          overwrite: 'auto'
        })
      })
      spinTimelineRef.current?.restart()
    }
    const moveHandler = (event: MouseEvent): void => {
      lastMouseRef.current = { x: event.clientX, y: event.clientY }
      gsap.to(cursor, {
        x: event.clientX,
        y: event.clientY,
        duration: 0.1,
        ease: 'power3.out',
        overwrite: 'auto'
      })
      const target = targetFromPoint(event.clientX, event.clientY)
      if (target && activeTargetRef.current !== target) showOnTarget(target)
      else if (target && !animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(followLoop)
      }
    }
    const overHandler = (event: MouseEvent): void => {
      const target = resolveTarget(event.target)
      if (!target) return
      if (activeTargetRef.current === target) clearLeaveTimer()
      else showOnTarget(target)
    }
    const outHandler = (event: MouseEvent): void => {
      const leaving = resolveTarget(event.target)
      if (!leaving || leaving !== activeTargetRef.current) return
      const nextTarget = resolveTarget(event.relatedTarget)
      if (nextTarget) {
        if (nextTarget !== leaving) showOnTarget(nextTarget)
        else clearLeaveTimer()
        return
      }
      clearLeaveTimer()
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        const { x, y } = lastMouseRef.current
        const target = targetFromPoint(x, y)
        if (target) showOnTarget(target)
        else if (activeTargetRef.current === leaving) hideCorners()
      }, 100)
    }

    window.addEventListener('mousemove', moveHandler, { passive: true })
    window.addEventListener('mouseover', overHandler, { passive: true })
    window.addEventListener('mouseout', outHandler, { passive: true })
    return () => {
      window.removeEventListener('mousemove', moveHandler)
      window.removeEventListener('mouseover', overHandler)
      window.removeEventListener('mouseout', outHandler)
      clearLeaveTimer()
      stopFollow()
      spinTimelineRef.current?.kill()
      gsap.killTweensOf([cursor, ...corners])
      document.body.style.cursor = originalCursor
    }
  }, [
    constants,
    cursorColor,
    cursorColorOnTarget,
    hideDefaultCursor,
    hoverDuration,
    isMobile,
    parallaxOn,
    showCursor,
    spinDuration,
    targetSelector
  ])

  if (isMobile) return null
  return (
    <div
      ref={cursorRef}
      data-testid="target-cursor"
      className="target-cursor-wrapper"
      style={showCursor ? undefined : { mixBlendMode: 'normal' }}
    >
      <div
        ref={dotRef}
        className="target-cursor-dot"
        style={{ backgroundColor: cursorColor, opacity: showCursor ? 1 : 0 }}
      />
      {(['tl', 'tr', 'br', 'bl'] as const).map((corner) => (
        <div
          key={corner}
          className={`target-cursor-corner corner-${corner}`}
          style={{ borderColor: cursorColorOnTarget ?? cursorColor }}
        />
      ))}
    </div>
  )
}
