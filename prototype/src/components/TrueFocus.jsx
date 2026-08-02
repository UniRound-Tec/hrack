import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'

const TrueFocus = ({
  sentence = 'True Focus',
  separator = ' ',
  manualMode = false,
  blurAmount = 5,
  borderColor = 'green',
  glowColor = 'rgba(0, 255, 0, 0.6)',
  animationDuration = 0.5,
  pauseBetweenAnimations = 1,
  className = '',
  wordClassName = 'relative text-[3rem] font-black cursor-pointer',
}) => {
  const words = sentence.split(separator)
  const [autoIndex, setAutoIndex] = useState(0)
  const [hoverIndex, setHoverIndex] = useState(null)
  const containerRef = useRef(null)
  const wordRefs = useRef([])
  const [focusRect, setFocusRect] = useState({ x: 0, y: 0, width: 0, height: 0 })

  // 自动轮播：hover 时暂停
  useEffect(() => {
    if (manualMode) return
    if (hoverIndex !== null) return
    if (words.length <= 1) return

    const interval = setInterval(
      () => {
        setAutoIndex((prev) => (prev + 1) % words.length)
      },
      (animationDuration + pauseBetweenAnimations) * 1000
    )

    return () => clearInterval(interval)
  }, [
    manualMode,
    hoverIndex,
    animationDuration,
    pauseBetweenAnimations,
    words.length,
  ])

  const currentIndex = manualMode
    ? (hoverIndex ?? autoIndex)
    : (hoverIndex ?? autoIndex)

  useEffect(() => {
    if (currentIndex === null || currentIndex === -1) return
    if (!wordRefs.current[currentIndex] || !containerRef.current) return

    const parentRect = containerRef.current.getBoundingClientRect()
    const activeRect = wordRefs.current[currentIndex].getBoundingClientRect()

    setFocusRect({
      x: activeRect.left - parentRect.left,
      y: activeRect.top - parentRect.top,
      width: activeRect.width,
      height: activeRect.height,
    })
  }, [currentIndex, words.length, sentence, wordClassName])

  const handleMouseEnter = (index) => {
    setHoverIndex(index)
  }

  const handleMouseLeave = () => {
    setHoverIndex(null)
  }

  return (
    <div
      className={`relative flex flex-wrap items-center justify-center gap-3 ${className}`}
      ref={containerRef}
      style={{ outline: 'none', userSelect: 'none' }}
    >
      {words.map((word, index) => {
        const isActive = index === currentIndex
        return (
          <span
            key={`${word}-${index}`}
            ref={(el) => {
              wordRefs.current[index] = el
            }}
            className={wordClassName}
            style={{
              filter: isActive ? 'blur(0px)' : `blur(${blurAmount}px)`,
              '--border-color': borderColor,
              '--glow-color': glowColor,
              transition: `filter ${animationDuration}s ease`,
              outline: 'none',
              userSelect: 'none',
            }}
            onMouseEnter={() => handleMouseEnter(index)}
            onMouseLeave={handleMouseLeave}
          >
            {word}
          </span>
        )
      })}

      <motion.div
        className="pointer-events-none absolute top-0 left-0 box-border border-0"
        animate={{
          x: focusRect.x,
          y: focusRect.y,
          width: focusRect.width,
          height: focusRect.height,
          opacity: currentIndex >= 0 ? 1 : 0,
        }}
        transition={{
          duration: animationDuration,
        }}
        style={{
          '--border-color': borderColor,
          '--glow-color': glowColor,
        }}
      >
        <span
          className="absolute top-[-8px] left-[-8px] h-3 w-3 rounded-[2px] border-2 border-r-0 border-b-0"
          style={{
            borderColor: 'var(--border-color)',
            filter: 'drop-shadow(0 0 4px var(--glow-color))',
          }}
        />
        <span
          className="absolute top-[-8px] right-[-8px] h-3 w-3 rounded-[2px] border-2 border-b-0 border-l-0"
          style={{
            borderColor: 'var(--border-color)',
            filter: 'drop-shadow(0 0 4px var(--glow-color))',
          }}
        />
        <span
          className="absolute bottom-[-8px] left-[-8px] h-3 w-3 rounded-[2px] border-2 border-t-0 border-r-0"
          style={{
            borderColor: 'var(--border-color)',
            filter: 'drop-shadow(0 0 4px var(--glow-color))',
          }}
        />
        <span
          className="absolute right-[-8px] bottom-[-8px] h-3 w-3 rounded-[2px] border-2 border-t-0 border-l-0"
          style={{
            borderColor: 'var(--border-color)',
            filter: 'drop-shadow(0 0 4px var(--glow-color))',
          }}
        />
      </motion.div>
    </div>
  )
}

export default TrueFocus
