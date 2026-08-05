import { create } from 'zustand'
import type { WorkspaceEntry } from '../../shared/workspace-reader'

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
