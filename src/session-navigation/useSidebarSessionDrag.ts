import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useSettingsStore } from '../state/settingsStore'
import type { SessionEntry } from '../state/sessionsStore'
import { useSessionNavigationStore } from './sessionNavigationStore'
import {
  memberDropBeforeId,
  passedSessionDragThreshold,
  rootDropBeforeId,
  SESSION_GROUP_DWELL_MS
} from './dragController'

export type SessionDragSource =
  | {
      kind: 'session'
      terminalId: string
      name: string
      groupId: string | null
    }
  | { kind: 'group'; groupId: string; name: string }

type DropIntent =
  | { kind: 'root'; beforeId: string | null }
  | { kind: 'member'; groupId: string; beforeTerminalId: string | null }
  | null

type ArmedTarget =
  | { kind: 'session'; terminalId: string; groupId: string | null; name: string }
  | { kind: 'group'; groupId: string }
  | null

interface DragVisual {
  source: SessionDragSource
  x: number
  y: number
  armed: boolean
}

export function useSidebarSessionDrag(sessions: readonly SessionEntry[]) {
  const [visual, setVisual] = useState<DragVisual | null>(null)
  const sourceRef = useRef<SessionDragSource | null>(null)
  const startRef = useRef({ x: 0, y: 0 })
  const activeRef = useRef(false)
  const dropRef = useRef<DropIntent>(null)
  const armedRef = useRef<ArmedTarget>(null)
  const dwellKeyRef = useRef<string | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armedElementRef = useRef<HTMLElement | null>(null)
  const sourceElementRef = useRef<HTMLElement | null>(null)
  const dropElementRef = useRef<HTMLElement | null>(null)
  const suppressNextClickRef = useRef(false)

  const clearDwell = useCallback(() => {
    if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = null
    dwellKeyRef.current = null
    armedRef.current = null
    armedElementRef.current?.removeAttribute('data-session-group-armed')
    armedElementRef.current = null
    setVisual((current) =>
      current?.armed ? { ...current, armed: false } : current
    )
  }, [])

  const armAfterDwell = useCallback(
    (key: string, target: Exclude<ArmedTarget, null>) => {
      if (dwellKeyRef.current === key) return
      clearDwell()
      dwellKeyRef.current = key
      dwellTimerRef.current = setTimeout(() => {
        armedRef.current = target
        const selector =
          target.kind === 'session'
            ? `[data-navigation-terminal-id="${CSS.escape(target.terminalId)}"]`
            : `[data-navigation-group-id="${CSS.escape(target.groupId)}"]`
        armedElementRef.current = document.querySelector<HTMLElement>(selector)
        armedElementRef.current?.setAttribute('data-session-group-armed', 'true')
        setVisual((current) =>
          current ? { ...current, armed: true } : current
        )
      }, SESSION_GROUP_DWELL_MS)
    },
    [clearDwell]
  )

  const finish = useCallback(
    (commit: boolean) => {
      const source = sourceRef.current
      const armed = armedRef.current
      const drop = dropRef.current
      if (commit && source && activeRef.current) {
        const navigation = useSessionNavigationStore.getState()
        const attention = useSettingsStore.getState().attentionPriorityEnabled
        if (source.kind === 'session' && armed?.kind === 'session') {
          if (armed.groupId) {
            navigation.dispatch(
              {
                kind: 'move-into-group',
                terminalId: source.terminalId,
                groupId: armed.groupId,
                beforeTerminalId: null
              },
              attention
            )
          } else {
            navigation.dispatch(
              {
                kind: 'group-pair',
                groupId: crypto.randomUUID(),
                sourceTerminalId: source.terminalId,
                targetTerminalId: armed.terminalId,
                defaultName: `${armed.name} + ${source.name}`
              },
              attention
            )
          }
        } else if (source.kind === 'session' && armed?.kind === 'group') {
          navigation.dispatch(
            {
              kind: 'move-into-group',
              terminalId: source.terminalId,
              groupId: armed.groupId,
              beforeTerminalId: null
            },
            attention
          )
        } else if (drop?.kind === 'member' && source.kind === 'session') {
          navigation.dispatch(
            {
              kind: 'reorder-member',
              terminalId: source.terminalId,
              groupId: drop.groupId,
              beforeTerminalId: drop.beforeTerminalId
            },
            attention
          )
        } else if (drop?.kind === 'root') {
          if (source.kind === 'group') {
            navigation.dispatch(
              {
                kind: 'reorder-root',
                sourceId: source.groupId,
                beforeId: drop.beforeId
              },
              attention
            )
          } else if (source.groupId) {
            navigation.dispatch(
              {
                kind: 'move-out-of-group',
                terminalId: source.terminalId,
                beforeId: drop.beforeId
              },
              attention
            )
          } else {
            navigation.dispatch(
              {
                kind: 'reorder-root',
                sourceId: source.terminalId,
                beforeId: drop.beforeId
              },
              attention
            )
          }
        }
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
      clearDwell()
      sourceElementRef.current?.removeAttribute('data-session-dragging')
      sourceElementRef.current = null
      dropElementRef.current?.removeAttribute('data-session-drop-before')
      dropElementRef.current = null
      sourceRef.current = null
      activeRef.current = false
      dropRef.current = null
      setVisual(null)
    },
    [clearDwell]
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
      setVisual((current) => ({
        source,
        x: event.clientX,
        y: event.clientY,
        armed: current?.armed ?? false
      }))

      const element = document.elementFromPoint(event.clientX, event.clientY)
      const targetSession = element?.closest<HTMLElement>(
        '[data-navigation-terminal-id]'
      )
      const targetTerminalId = targetSession?.dataset.navigationTerminalId
      const targetGroupId = targetSession?.dataset.navigationGroupId ?? null
      if (targetTerminalId && targetTerminalId !== (source.kind === 'session' ? source.terminalId : null)) {
        if (
          source.kind === 'session' &&
          source.groupId &&
          targetGroupId === source.groupId
        ) {
          clearDwell()
          dropRef.current = {
            kind: 'member',
            groupId: source.groupId,
            beforeTerminalId: memberDropBeforeId(
              event.clientY,
              source.groupId,
              source.terminalId
            )
          }
          dropElementRef.current?.removeAttribute('data-session-drop-before')
          dropElementRef.current = dropRef.current.beforeTerminalId
            ? document.querySelector<HTMLElement>(
                `[data-navigation-terminal-id="${CSS.escape(dropRef.current.beforeTerminalId)}"]`
              )
            : null
          dropElementRef.current?.setAttribute('data-session-drop-before', 'true')
          return
        }
        const target = sessions.find(
          (session) => session.terminalId === targetTerminalId
        )
        if (source.kind === 'session' && target) {
          armAfterDwell(`session:${targetTerminalId}`, {
            kind: 'session',
            terminalId: targetTerminalId,
            groupId: targetGroupId,
            name: target.name
          })
        }
      } else {
        const targetGroup = element?.closest<HTMLElement>(
          '[data-navigation-group-id]'
        )?.dataset.navigationGroupId
        if (
          source.kind === 'session' &&
          targetGroup &&
          targetGroup !== source.groupId
        ) {
          armAfterDwell(`group:${targetGroup}`, {
            kind: 'group',
            groupId: targetGroup
          })
        } else {
          clearDwell()
        }
      }

      const sourceId =
        source.kind === 'group' ? source.groupId : source.groupId ?? source.terminalId
      dropRef.current = {
        kind: 'root',
        beforeId: rootDropBeforeId(event.clientY, sourceId)
      }
      dropElementRef.current?.removeAttribute('data-session-drop-before')
      dropElementRef.current = dropRef.current.beforeId
        ? document.querySelector<HTMLElement>(
            `[data-navigation-root-id="${CSS.escape(dropRef.current.beforeId)}"]`
          )
        : null
      dropElementRef.current?.setAttribute('data-session-drop-before', 'true')
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
  }, [armAfterDwell, clearDwell, finish, sessions, visual === null])

  const begin = useCallback(
    (source: SessionDragSource, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      sourceRef.current = source
      sourceElementRef.current = event.currentTarget.closest<HTMLElement>(
        '[data-navigation-terminal-id], [data-navigation-group-id]'
      )
      startRef.current = { x: event.clientX, y: event.clientY }
      setVisual({
        source,
        x: event.clientX,
        y: event.clientY,
        armed: false
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
