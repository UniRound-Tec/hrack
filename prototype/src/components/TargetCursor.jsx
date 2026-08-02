import { useEffect, useRef, useMemo } from 'react'
import { gsap } from 'gsap'
import './TargetCursor.css'

const TargetCursor = ({
  targetSelector = '.cursor-target',
  hoverDuration = 0.2,
  parallaxOn = true,
  cursorColor = '#ffffff',
  cursorColorOnTarget,
  showCursor = true,
  hideDefaultCursor = true,
  spinDuration = 2,
}) => {
  const cursorRef = useRef(null)
  const cornersRef = useRef(null)
  const dotRef = useRef(null)
  const spinTl = useRef(null)
  const activeTargetRef = useRef(null)
  const leaveTimerRef = useRef(null)
  const rafRef = useRef(0)
  const lastMouseRef = useRef({ x: 0, y: 0 })

  const isMobile = useMemo(() => {
    if (typeof window === 'undefined') return false
    const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    const isSmallScreen = window.innerWidth <= 768
    const userAgent = navigator.userAgent || navigator.vendor || window.opera || ''
    const isMobileUserAgent =
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
        userAgent.toLowerCase()
      )
    return (hasTouchScreen && isSmallScreen) || isMobileUserAgent
  }, [])

  const constants = useMemo(
    () => ({
      borderWidth: 3,
      cornerSize: 12,
    }),
    []
  )

  useEffect(() => {
    if (isMobile || !cursorRef.current) return

    const cursor = cursorRef.current
    const corners = Array.from(cursor.querySelectorAll('.target-cursor-corner'))
    cornersRef.current = corners

    const originalCursor = document.body.style.cursor
    if (hideDefaultCursor && showCursor) {
      document.body.style.cursor = 'none'
    }

    if (!showCursor) {
      gsap.set(corners, { opacity: 0, x: 0, y: 0 })
      if (dotRef.current) gsap.set(dotRef.current, { opacity: 0 })
    } else {
      gsap.set(corners, { opacity: 1 })
      spinTl.current = gsap
        .timeline({ repeat: -1 })
        .to(cursor, { rotation: '+=360', duration: spinDuration, ease: 'none' })
    }

    gsap.set(cursor, {
      xPercent: -50,
      yPercent: -50,
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })

    const resolveTarget = (node) => {
      if (!node) return null
      const el = node instanceof Element ? node : node.parentElement
      if (!el || typeof el.closest !== 'function') return null
      return el.closest(targetSelector)
    }

    const targetFromPoint = (x, y) => {
      const el = document.elementFromPoint(x, y)
      return resolveTarget(el)
    }

    const clearLeaveTimer = () => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current)
        leaveTimerRef.current = null
      }
    }

    const stopFollow = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }

    const placeCornersOnTarget = (target, mode = 'snap') => {
      const rect = target.getBoundingClientRect()
      const { borderWidth, cornerSize } = constants
      const cursorX = Number(gsap.getProperty(cursor, 'x')) || 0
      const cursorY = Number(gsap.getProperty(cursor, 'y')) || 0

      const positions = [
        {
          x: rect.left - borderWidth - cursorX,
          y: rect.top - borderWidth - cursorY,
        },
        {
          x: rect.right + borderWidth - cornerSize - cursorX,
          y: rect.top - borderWidth - cursorY,
        },
        {
          x: rect.right + borderWidth - cornerSize - cursorX,
          y: rect.bottom + borderWidth - cornerSize - cursorY,
        },
        {
          x: rect.left - borderWidth - cursorX,
          y: rect.bottom + borderWidth - cornerSize - cursorY,
        },
      ]

      corners.forEach((corner, i) => {
        if (mode === 'lock') {
          gsap.to(corner, {
            x: positions[i].x,
            y: positions[i].y,
            duration: hoverDuration,
            ease: 'power2.out',
            overwrite: 'auto',
          })
        } else if (mode === 'parallax') {
          gsap.to(corner, {
            x: positions[i].x,
            y: positions[i].y,
            duration: 0.22,
            ease: 'power1.out',
            overwrite: 'auto',
          })
        } else {
          gsap.set(corner, {
            x: positions[i].x,
            y: positions[i].y,
          })
        }
      })
    }

    const followLoop = () => {
      const target = activeTargetRef.current
      if (!target) {
        rafRef.current = 0
        return
      }
      // 目标已从 DOM 移除时自动清理
      if (!target.isConnected) {
        activeTargetRef.current = null
        stopFollow()
        if (!showCursor) gsap.set(corners, { opacity: 0 })
        rafRef.current = 0
        return
      }
      placeCornersOnTarget(target, parallaxOn ? 'parallax' : 'snap')
      rafRef.current = requestAnimationFrame(followLoop)
    }

    const showOnTarget = (target) => {
      clearLeaveTimer()
      activeTargetRef.current = target

      gsap.killTweensOf(cursor, 'rotation')
      spinTl.current?.pause()
      gsap.set(cursor, { rotation: 0 })

      const color = cursorColorOnTarget || cursorColor
      gsap.set(corners, { opacity: 1, borderColor: color })

      placeCornersOnTarget(target, 'lock')

      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(followLoop)
      }
    }

    const hideCorners = () => {
      activeTargetRef.current = null
      stopFollow()

      if (!showCursor) {
        gsap.to(corners, {
          opacity: 0,
          duration: 0.18,
          ease: 'power2.out',
          overwrite: 'auto',
        })
      } else {
        const { cornerSize } = constants
        const idle = [
          { x: -cornerSize * 1.5, y: -cornerSize * 1.5 },
          { x: cornerSize * 0.5, y: -cornerSize * 1.5 },
          { x: cornerSize * 0.5, y: cornerSize * 0.5 },
          { x: -cornerSize * 1.5, y: cornerSize * 0.5 },
        ]
        corners.forEach((corner, i) => {
          gsap.to(corner, {
            x: idle[i].x,
            y: idle[i].y,
            borderColor: cursorColor,
            duration: 0.25,
            ease: 'power3.out',
            overwrite: 'auto',
          })
        })
        spinTl.current?.restart()
      }
    }

    const moveHandler = (e) => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY }

      gsap.to(cursor, {
        x: e.clientX,
        y: e.clientY,
        duration: 0.1,
        ease: 'power3.out',
        overwrite: 'auto',
      })

      // 恢复：误判离开后鼠标仍在卡片上时，重新点亮
      const under = targetFromPoint(e.clientX, e.clientY)
      if (under) {
        if (activeTargetRef.current !== under) {
          showOnTarget(under)
        } else if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(followLoop)
        }
      }
    }

    const overHandler = (e) => {
      const target = resolveTarget(e.target)
      if (!target) return
      if (activeTargetRef.current === target) {
        clearLeaveTimer()
        return
      }
      showOnTarget(target)
    }

    const outHandler = (e) => {
      const leaving = resolveTarget(e.target)
      if (!leaving || leaving !== activeTargetRef.current) return

      const nextTarget = resolveTarget(e.relatedTarget)
      if (nextTarget) {
        // 还在某张卡片上（同卡子元素 / 切到另一张）
        if (nextTarget !== leaving) {
          showOnTarget(nextTarget)
        } else {
          clearLeaveTimer()
        }
        return
      }

      clearLeaveTimer()
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null
        const { x, y } = lastMouseRef.current
        const still = targetFromPoint(x, y)
        if (still) {
          showOnTarget(still)
          return
        }
        if (activeTargetRef.current === leaving) {
          hideCorners()
        }
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
      spinTl.current?.kill()
      document.body.style.cursor = originalCursor
    }
  }, [
    isMobile,
    targetSelector,
    hoverDuration,
    parallaxOn,
    cursorColor,
    cursorColorOnTarget,
    showCursor,
    hideDefaultCursor,
    spinDuration,
    constants,
  ])

  if (isMobile) return null

  return (
    <div
      ref={cursorRef}
      className="target-cursor-wrapper"
      style={showCursor ? undefined : { mixBlendMode: 'normal' }}
    >
      <div
        ref={dotRef}
        className="target-cursor-dot"
        style={{ backgroundColor: cursorColor, opacity: showCursor ? 1 : 0 }}
      />
      <div
        className="target-cursor-corner corner-tl"
        style={{ borderColor: cursorColorOnTarget || cursorColor }}
      />
      <div
        className="target-cursor-corner corner-tr"
        style={{ borderColor: cursorColorOnTarget || cursorColor }}
      />
      <div
        className="target-cursor-corner corner-br"
        style={{ borderColor: cursorColorOnTarget || cursorColor }}
      />
      <div
        className="target-cursor-corner corner-bl"
        style={{ borderColor: cursorColorOnTarget || cursorColor }}
      />
    </div>
  )
}

export default TargetCursor
