import { gsap } from 'gsap'
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type HTMLAttributes,
  type ReactNode
} from 'react'

export interface TextTypeProps extends HTMLAttributes<HTMLElement> {
  text: string | string[]
  as?: ElementType
  typingSpeed?: number
  initialDelay?: number
  pauseDuration?: number
  deletingSpeed?: number
  loop?: boolean
  showCursor?: boolean
  hideCursorWhileTyping?: boolean
  cursorCharacter?: string
  cursorClassName?: string
  cursorBlinkDuration?: number
  textColors?: string[]
  variableSpeed?: { min: number; max: number }
  onSentenceComplete?: (sentence: string, index: number) => void
  startOnVisible?: boolean
  reverseMode?: boolean
  keywords?: string[]
  keywordColor?: string
}

export default function TextType({
  text,
  as: Component = 'div',
  typingSpeed = 50,
  initialDelay = 0,
  pauseDuration = 2000,
  deletingSpeed = 30,
  loop = true,
  className = '',
  showCursor = true,
  hideCursorWhileTyping = false,
  cursorCharacter = '|',
  cursorClassName = '',
  cursorBlinkDuration = 0.5,
  textColors = [],
  variableSpeed,
  onSentenceComplete,
  startOnVisible = false,
  reverseMode = false,
  keywords = [],
  keywordColor = '#ff4500',
  ...props
}: TextTypeProps) {
  const [displayedText, setDisplayedText] = useState('')
  const [currentCharIndex, setCurrentCharIndex] = useState(0)
  const [isDeleting, setIsDeleting] = useState(false)
  const [currentTextIndex, setCurrentTextIndex] = useState(0)
  const [isVisible, setIsVisible] = useState(!startOnVisible)
  const cursorRef = useRef<HTMLSpanElement>(null)
  const containerRef = useRef<HTMLElement>(null)
  const textArray = useMemo(() => (Array.isArray(text) ? text : [text]), [text])
  const currentText = textArray[currentTextIndex] ?? ''

  const getRandomSpeed = useCallback(() => {
    if (!variableSpeed) return typingSpeed
    return Math.random() * (variableSpeed.max - variableSpeed.min) + variableSpeed.min
  }, [typingSpeed, variableSpeed])

  useEffect(() => {
    if (!startOnVisible || !containerRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setIsVisible(true)
      },
      { threshold: 0.1 }
    )
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [startOnVisible])

  useEffect(() => {
    if (!showCursor || !cursorRef.current) return
    gsap.set(cursorRef.current, { opacity: 1 })
    const tween = gsap.to(cursorRef.current, {
      opacity: 0,
      duration: cursorBlinkDuration,
      repeat: -1,
      yoyo: true,
      ease: 'power2.inOut'
    })
    return () => {
      tween.kill()
    }
  }, [cursorBlinkDuration, showCursor])

  useEffect(() => {
    if (!isVisible || textArray.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const processedText = reverseMode
      ? [...currentText].reverse().join('')
      : currentText

    const execute = (): void => {
      if (isDeleting) {
        if (displayedText === '') {
          setIsDeleting(false)
          if (currentTextIndex === textArray.length - 1 && !loop) return
          onSentenceComplete?.(currentText, currentTextIndex)
          setCurrentTextIndex((value) => (value + 1) % textArray.length)
          setCurrentCharIndex(0)
          timer = setTimeout(() => {}, pauseDuration)
        } else {
          timer = setTimeout(
            () => setDisplayedText((value) => value.slice(0, -1)),
            deletingSpeed
          )
        }
      } else if (currentCharIndex < processedText.length) {
        timer = setTimeout(
          () => {
            setDisplayedText((value) => value + processedText[currentCharIndex])
            setCurrentCharIndex((value) => value + 1)
          },
          variableSpeed ? getRandomSpeed() : typingSpeed
        )
      } else {
        if (!loop && currentTextIndex === textArray.length - 1) return
        timer = setTimeout(() => setIsDeleting(true), pauseDuration)
      }
    }

    if (currentCharIndex === 0 && !isDeleting && displayedText === '') {
      timer = setTimeout(execute, initialDelay)
    } else {
      execute()
    }
    return () => clearTimeout(timer)
  }, [
    currentCharIndex,
    currentText,
    currentTextIndex,
    deletingSpeed,
    displayedText,
    getRandomSpeed,
    initialDelay,
    isDeleting,
    isVisible,
    loop,
    onSentenceComplete,
    pauseDuration,
    reverseMode,
    textArray.length,
    typingSpeed,
    variableSpeed
  ])

  const shouldHideCursor =
    hideCursorWhileTyping &&
    (currentCharIndex < currentText.length || isDeleting)
  const highlightedText = useMemo<ReactNode>(() => {
    if (keywords.length === 0 || displayedText.length === 0) return displayedText
    const escaped = keywords
      .filter(Boolean)
      .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (escaped.length === 0) return displayedText
    const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
    return displayedText.split(pattern).map((part, index) =>
      keywords.some((keyword) => keyword.toLowerCase() === part.toLowerCase()) ? (
        <span key={`${part}-${index}`} style={{ color: keywordColor }}>
          {part}
        </span>
      ) : (
        <span key={`${part}-${index}`}>{part}</span>
      )
    )
  }, [displayedText, keywordColor, keywords])

  return createElement(
    Component,
    {
      ref: containerRef,
      className: `inline-block whitespace-pre-wrap tracking-tight ${className}`,
      ...props
    },
    <span
      className="inline"
      style={{ color: textColors[currentTextIndex % textColors.length] ?? 'inherit' }}
    >
      {highlightedText}
    </span>,
    showCursor && (
      <span
        ref={cursorRef}
        className={`ml-1 inline-block opacity-100 ${
          shouldHideCursor ? 'hidden' : ''
        } ${cursorClassName}`}
      >
        {cursorCharacter}
      </span>
    )
  )
}
