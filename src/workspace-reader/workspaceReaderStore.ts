import { create } from 'zustand'
import type { WorkspaceEntry } from '../../shared/workspace-reader'

function sameEntries(
  left: WorkspaceEntry[] | undefined,
  right: WorkspaceEntry[]
): boolean {
  if (!left || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const current = left[index]
    const next = right[index]
    if (
      current.path !== next.path ||
      current.name !== next.name ||
      current.kind !== next.kind
    ) {
      return false
    }
  }
  return true
}

interface ReaderSessionState {
  open: boolean
  selectedPath: string | null
  expandedPaths: string[]
  directories: Record<string, WorkspaceEntry[]>
}

interface WorkspaceReaderState {
  sessions: Record<string, ReaderSessionState>
  ensure(terminalId: string): void
  setOpen(terminalId: string, open: boolean): void
  select(terminalId: string, path: string): void
  setExpanded(terminalId: string, path: string, expanded: boolean): void
  setDirectory(
    terminalId: string,
    path: string,
    entries: WorkspaceEntry[]
  ): void
  clearCache(terminalId: string): void
}

const initialSession = (): ReaderSessionState => ({
  open: false,
  selectedPath: null,
  expandedPaths: [],
  directories: {}
})

export const useWorkspaceReaderStore = create<WorkspaceReaderState>((set) => ({
  sessions: {},
  ensure: (terminalId) =>
    set((state) =>
      state.sessions[terminalId]
        ? state
        : { sessions: { ...state.sessions, [terminalId]: initialSession() } }
    ),
  setOpen: (terminalId, open) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [terminalId]: {
          ...(state.sessions[terminalId] ?? initialSession()),
          open
        }
      }
    })),
  select: (terminalId, selectedPath) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [terminalId]: {
          ...(state.sessions[terminalId] ?? initialSession()),
          selectedPath
        }
      }
    })),
  setExpanded: (terminalId, path, expanded) =>
    set((state) => {
      const session = state.sessions[terminalId] ?? initialSession()
      const expandedPaths = expanded
        ? Array.from(new Set([...session.expandedPaths, path]))
        : session.expandedPaths.filter((item) => item !== path)
      return {
        sessions: {
          ...state.sessions,
          [terminalId]: { ...session, expandedPaths }
        }
      }
    }),
  setDirectory: (terminalId, path, entries) =>
    set((state) => {
      const session = state.sessions[terminalId] ?? initialSession()
      if (sameEntries(session.directories[path], entries)) return state
      return {
        sessions: {
          ...state.sessions,
          [terminalId]: {
            ...session,
            directories: { ...session.directories, [path]: entries }
          }
        }
      }
    }),
  clearCache: (terminalId) =>
    set((state) => {
      const session = state.sessions[terminalId] ?? initialSession()
      return {
        sessions: {
          ...state.sessions,
          [terminalId]: { ...session, directories: {} }
        }
      }
    })
}))
