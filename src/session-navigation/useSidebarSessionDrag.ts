import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useSettingsStore } from '../state/settingsStore'
import { useSessionNavigationStore } from './sessionNavigationStore'
import {
  passedSessionDragThreshold,
  rootDropBeforeId
} from './dragController'

export interface SessionDragSource {
  terminalId: string
}

interface DragVisual {
  sourceMarkup: string
  x: number
  y: number
  width: number
  height: number
  grabX: number
  grabY: number
}

function snapshotDragSource(element: HTMLElement | null): string {
  if (!element) return ''
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('svg title').forEach((title) => title.remove())
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    node.removeAttribute('id')
    node.removeAttribute('style')
    node.removeAttribute('data-testid')
    node.removeAttribute('data-navigation-terminal-id')
    node.removeAttribute('data-navigation-root-id')
    node.removeAttribute('data-session-dragging')
    node.removeAttribute('data-session-drop-before')
    node.removeAttribute('data-session-drop-end')
    node.setAttribute('tabindex', '-1')
  }
  clone.setAttribute('aria-hidden', 'true')
  return clone.outerHTML
}

export function useSidebarSessionDrag() {
  const [visual, setVisual] = useState<DragVisual | null>(null)
  const sourceRef = useRef<SessionDragSource | null>(null)
  const startRef = useRef({ x: 0, y: 0 })
  const activeRef = useRef(false)
  const beforeIdRef = useRef<string | null>(null)
  const sourceElementRef = useRef<HTMLElement | null>(null)
  const dropElementRef = useRef<HTMLElement | null>(null)
  const suppressNextClickRef = useRef(false)

  const clearDropIndicator = useCallback(() => {
    dropElementRef.current?.removeAttribute('data-session-drop-before')
    dropElementRef.current?.removeAttribute('data-session-drop-end')
    dropElementRef.current = null
  }, [])

  const showDropIndicator = useCallback(
    (element: HTMLElement | null, placement: 'before' | 'end') => {
      clearDropIndicator()
      dropElementRef.current = element
      element?.setAttribute(
        placement === 'before'
          ? 'data-session-drop-before'
          : 'data-session-drop-end',
        'true'
      )
    },
    [clearDropIndicator]
  )

  const finish = useCallback(
    (commit: boolean) => {
      const source = sourceRef.current
      if (commit && source && activeRef.current) {
        useSessionNavigationStore.getState().dispatch(
          {
            kind: 'reorder-root',
            sourceId: source.terminalId,
            beforeId: beforeIdRef.current
          },
          useSettingsStore.getState().attentionPriorityEnabled
        )
      }

      if (activeRef.current) {
        suppressNextClickRef.current = true
        setTimeout(() => {
          suppressNextClickRef.current = false
        }, 0)
        useSessionNavigationStore
          .getState()
          .endInteraction(useSettingsStore.getState().attentionPriorityEnabled)
      }
      sourceElementRef.current?.removeAttribute('data-session-dragging')
      sourceElementRef.current = null
      clearDropIndicator()
      sourceRef.current = null
      activeRef.current = false
      beforeIdRef.current = null
      setVisual(null)
    },
    [clearDropIndicator]
  )

  useEffect(() => {
    if (!sourceRef.current) return
    const onPointerMove = (event: PointerEvent): void => {
      const source = sourceRef.current
      if (!source) return
      if (
        !activeRef.current &&
        passedSessionDragThreshold(
          startRef.current.x,
          startRef.current.y,
          event.clientX,
          event.clientY
        )
      ) {
        activeRef.current = true
        useSessionNavigationStore.getState().beginInteraction()
      }
      if (!activeRef.current) return
      event.preventDefault()
      sourceElementRef.current?.setAttribute('data-session-dragging', 'true')
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="sidebar"] .sidebar-scroll'
      )
      if (scroller) {
        const rect = scroller.getBoundingClientRect()
        if (event.clientY < rect.top + 28) scroller.scrollBy({ top: -8 })
        else if (event.clientY > rect.bottom - 28) scroller.scrollBy({ top: 8 })
      }
      setVisual((current) =>
        current
          ? { ...current, x: event.clientX, y: event.clientY }
          : current
      )

      beforeIdRef.current = rootDropBeforeId(
        event.clientY,
        source.terminalId
      )
      const beforeId = beforeIdRef.current
      showDropIndicator(
        beforeId
          ? document.querySelector<HTMLElement>(
              `[data-navigation-root-id="${CSS.escape(beforeId)}"]`
            )
          : document.querySelector<HTMLElement>(
              '[data-testid="sidebar-session-list"]'
            ),
        beforeId ? 'before' : 'end'
      )
    }
    const onPointerUp = (): void => finish(true)
    const onPointerCancel = (): void => finish(false)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(false)
    }
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onPointerCancel)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onPointerCancel)
    }
  }, [finish, showDropIndicator, visual === null])

  const begin = useCallback(
    (source: SessionDragSource, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      sourceRef.current = source
      sourceElementRef.current = event.currentTarget.closest<HTMLElement>(
        '[data-navigation-terminal-id]'
      )
      const sourceRect = sourceElementRef.current?.getBoundingClientRect()
      startRef.current = { x: event.clientX, y: event.clientY }
      setVisual({
        sourceMarkup: snapshotDragSource(sourceElementRef.current),
        x: event.clientX,
        y: event.clientY,
        width: sourceRect?.width ?? 220,
        height: sourceRect?.height ?? 48,
        grabX: sourceRect ? event.clientX - sourceRect.left : 110,
        grabY: sourceRect ? event.clientY - sourceRect.top : 24
      })
    },
    []
  )

  const suppressClick = useCallback((event: React.MouseEvent) => {
    if (!suppressNextClickRef.current) return
    suppressNextClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return { begin, visual: activeRef.current ? visual : null, suppressClick }
}
