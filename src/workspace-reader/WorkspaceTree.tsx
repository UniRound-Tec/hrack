import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  FileCode2,
  FileQuestion,
  Folder,
  FolderOpen
} from 'lucide-react'
import type { WorkspaceEntry } from '../../shared/workspace-reader'
import { useWorkspaceReaderStore } from './workspaceReaderStore'
import { useStrings } from '../app/i18n'

interface VisibleEntry extends WorkspaceEntry {
  depth: number
}

interface WorkspaceTreeProps {
  terminalId: string
  refreshKey: number
  onSelect(path: string): void
}

function flatten(
  directory: string,
  depth: number,
  directories: Record<string, WorkspaceEntry[]>,
  expanded: Set<string>,
  output: VisibleEntry[]
): void {
  for (const entry of directories[directory] ?? []) {
    output.push({ ...entry, depth })
    if (entry.kind === 'directory' && expanded.has(entry.path)) {
      flatten(entry.path, depth + 1, directories, expanded, output)
    }
  }
}

export default function WorkspaceTree({ terminalId, refreshKey, onSelect }: WorkspaceTreeProps) {
  const strings = useStrings()
  const session = useWorkspaceReaderStore((state) => state.sessions[terminalId])
  const setDirectory = useWorkspaceReaderStore((state) => state.setDirectory)
  const setExpanded = useWorkspaceReaderStore((state) => state.setExpanded)
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })

  const load = async (path: string, force = false): Promise<void> => {
    if (!force && session?.directories[path]) return
    setLoading((current) => new Set(current).add(path))
    setErrors((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
    try {
      setDirectory(terminalId, path, await window.workspaceReader.list({ terminalId, path }))
    } catch (error) {
      setErrors((current) => ({ ...current, [path]: String(error) }))
    } finally {
      setLoading((current) => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
    }
  }

  useEffect(() => {
    const paths = ['', ...(session?.expandedPaths ?? [])]
    void Promise.all(paths.map((path) => load(path, true)))
    // refreshKey is the explicit cache invalidation signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, refreshKey])

  const expanded = useMemo(
    () => new Set(session?.expandedPaths ?? []),
    [session?.expandedPaths]
  )
  const visible = useMemo(() => {
    const output: VisibleEntry[] = []
    flatten('', 0, session?.directories ?? {}, expanded, output)
    return output
  }, [expanded, session?.directories])
  const virtualized = visible.length > 300
  const rowHeight = 28
  const start = virtualized
    ? Math.max(0, Math.floor(viewport.top / rowHeight) - 12)
    : 0
  const end = virtualized
    ? Math.min(
        visible.length,
        Math.ceil((viewport.top + viewport.height) / rowHeight) + 12
      )
    : visible.length
  const rendered = visible.slice(start, end)

  if (loading.has('') && visible.length === 0) {
    return <p className="px-3 py-2 text-[11px] text-text-faint">{strings.workspaceReader.loading}</p>
  }
  if (errors[''] && visible.length === 0) {
    return <p className="px-3 py-2 text-[11px] text-status-error">{strings.workspaceReader.directoryError}</p>
  }

  return (
    <div
      ref={scrollerRef}
      className="h-full overflow-auto py-1 font-pingfang"
      onScroll={(event) =>
        setViewport({
          top: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight
        })
      }
    >
      {virtualized && <div style={{ height: start * rowHeight }} />}
      {rendered.map((entry) => {
        const isDirectory = entry.kind === 'directory'
        const isExpanded = expanded.has(entry.path)
        const Icon = isDirectory
          ? isExpanded
            ? FolderOpen
            : Folder
          : entry.kind === 'symlink'
            ? FileQuestion
            : FileCode2
        return (
          <div key={entry.path}>
            <button
              type="button"
              data-testid="workspace-tree-entry"
              data-path={entry.path}
              title={entry.path}
              className={`flex h-7 w-full min-w-0 items-center gap-1.5 pr-2 text-left text-[11px] transition-colors hover:bg-surface-hover ${session?.selectedPath === entry.path ? 'bg-control-active text-text-primary' : 'text-text-secondary'}`}
              style={{ paddingLeft: 6 + entry.depth * 14 }}
              onClick={() => {
                if (isDirectory) {
                  const next = !isExpanded
                  setExpanded(terminalId, entry.path, next)
                  if (next) void load(entry.path)
                } else if (entry.kind === 'file') {
                  onSelect(entry.path)
                }
              }}
            >
              <ChevronRight
                className={`size-3 shrink-0 transition-transform ${!isDirectory ? 'invisible' : isExpanded ? 'rotate-90' : ''}`}
                strokeWidth={1.75}
              />
              <Icon className="size-3.5 shrink-0 text-text-faint" strokeWidth={1.6} />
              <span className="truncate">{entry.name}</span>
            </button>
            {!virtualized && isDirectory && isExpanded && loading.has(entry.path) && (
              <p className="h-6 pl-8 text-[10px] leading-6 text-text-faint">{strings.workspaceReader.loading}</p>
            )}
            {!virtualized && isDirectory && isExpanded && errors[entry.path] && (
              <p className="h-6 truncate pl-8 text-[10px] leading-6 text-status-error">{strings.workspaceReader.openError}</p>
            )}
          </div>
        )
      })}
      {virtualized && <div style={{ height: (visible.length - end) * rowHeight }} />}
      {!loading.has('') && visible.length === 0 && (
        <p className="px-3 py-2 text-[11px] text-text-faint">{strings.workspaceReader.empty}</p>
      )}
    </div>
  )
}
