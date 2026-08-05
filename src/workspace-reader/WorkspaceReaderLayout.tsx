import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import type {
  WorkspaceDescription,
  WorkspaceTextFile
} from '../../shared/workspace-reader'
import { useSettingsStore } from '../state/settingsStore'
import ReadOnlyCodeView from './ReadOnlyCodeView'
import SplitHandle from './SplitHandle'
import WorkspaceTree from './WorkspaceTree'
import { useWorkspaceReaderStore } from './workspaceReaderStore'
import { useStrings } from '../app/i18n'

const TERMINAL_MIN = 420
const READER_MIN = 460
const TREE_MIN = 160
const TREE_MAX = 360
const CODE_MIN = 280
const SPLITTER_WIDTH = 6
const NARROW_BREAKPOINT = TERMINAL_MIN + READER_MIN + SPLITTER_WIDTH

interface WorkspaceReaderLayoutProps {
  terminalId: string
  active: boolean
  children: ReactNode
}

export default function WorkspaceReaderLayout({
  terminalId,
  active,
  children
}: WorkspaceReaderLayoutProps) {
  const strings = useStrings()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [description, setDescription] = useState<WorkspaceDescription | null>(
    null
  )
  const [file, setFile] = useState<WorkspaceTextFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const ensure = useWorkspaceReaderStore((state) => state.ensure)
  const session = useWorkspaceReaderStore((state) => state.sessions[terminalId])
  const setOpen = useWorkspaceReaderStore((state) => state.setOpen)
  const select = useWorkspaceReaderStore((state) => state.select)
  const clearCache = useWorkspaceReaderStore((state) => state.clearCache)
  const readerRatio = useSettingsStore((state) => state.readerWidthRatio)
  const treeWidth = useSettingsStore((state) => state.workspaceTreeWidth)
  const setReaderRatio = useSettingsStore((state) => state.setReaderWidthRatio)
  const setTreeWidth = useSettingsStore((state) => state.setWorkspaceTreeWidth)

  useEffect(() => ensure(terminalId), [ensure, terminalId])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) =>
      setContainerWidth(entry.contentRect.width)
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const probe = async (): Promise<void> => {
      const next = await window.workspaceReader
        .describe(terminalId)
        .catch(() => null)
      if (cancelled) return
      if (next) setDescription(next)
      else if (++attempts < 40) timer = setTimeout(() => void probe(), 250)
    }
    void probe()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [active, terminalId])

  const open = session?.open ?? false
  const narrow = containerWidth > 0 && containerWidth < NARROW_BREAKPOINT
  const maxReaderWidth = Math.max(
    READER_MIN,
    containerWidth - TERMINAL_MIN - SPLITTER_WIDTH
  )
  const readerWidth = Math.max(
    READER_MIN,
    Math.min(maxReaderWidth, containerWidth * readerRatio)
  )
  const maxTreeWidth = Math.max(
    TREE_MIN,
    Math.min(TREE_MAX, readerWidth - CODE_MIN - SPLITTER_WIDTH)
  )
  const actualTreeWidth = Math.min(treeWidth, maxTreeWidth)

  const selectFile = async (path: string): Promise<void> => {
    select(terminalId, path)
    setFileError(null)
    try {
      setFile(await window.workspaceReader.read({ terminalId, path }))
    } catch (error) {
      setFile(null)
      setFileError(String(error))
    }
  }

  const refresh = (): void => {
    clearCache(terminalId)
    setRefreshKey((value) => value + 1)
    if (session?.selectedPath) void selectFile(session.selectedPath)
  }

  const reader = description && (
    <section
      data-testid="workspace-reader"
      className="workspace-reader-scrollbars flex h-full min-w-0 flex-col overflow-hidden bg-surface"
      style={narrow ? { width: '100%' } : { width: readerWidth }}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-2.5">
        {narrow && (
          <button
            data-testid="workspace-reader-back"
            type="button"
            title={strings.workspaceReader.back}
            onClick={() => setOpen(terminalId, false)}
            className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
          >
            <ArrowLeft className="size-3.5" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-pingfang text-[11px] font-semibold text-text-secondary">
          {description.name}
        </span>
        <button
          data-testid="workspace-reader-refresh"
          type="button"
          title={strings.workspaceReader.refresh}
          onClick={refresh}
          className="flex size-7 items-center justify-center rounded-md text-text-faint hover:bg-surface-hover hover:text-text-primary"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.7} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          data-testid="workspace-reader-tree"
          className="h-full shrink-0 overflow-hidden"
          style={{ width: actualTreeWidth }}
        >
          <WorkspaceTree
            terminalId={terminalId}
            refreshKey={refreshKey}
            onSelect={(path) => void selectFile(path)}
          />
        </aside>
        <SplitHandle
          testId="workspace-reader-inner-separator"
          label={strings.workspaceReader.resizeTree}
          value={actualTreeWidth}
          min={TREE_MIN}
          max={maxTreeWidth}
          defaultValue={220}
          onChange={setTreeWidth}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-8 shrink-0 items-center border-b border-border-subtle px-3 font-maple text-[10px] text-text-faint">
            <span className="truncate">
              {file ? file.path : strings.workspaceReader.selectFileShort}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {file ? (
              <ReadOnlyCodeView path={file.path} text={file.text} />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center font-pingfang text-[11px] text-text-faint">
                {fileError
                  ? strings.workspaceReader.unreadable
                  : strings.workspaceReader.selectFile}
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  )

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full overflow-hidden"
    >
      <div
        className={`relative h-full min-w-0 flex-1 ${narrow && open && description ? 'invisible absolute inset-0 pointer-events-none' : ''}`}
      >
        {children}
      </div>
      {description && open && !narrow && (
        <SplitHandle
          testId="workspace-reader-outer-separator"
          label={strings.workspaceReader.resizeReader}
          value={readerWidth}
          min={READER_MIN}
          max={maxReaderWidth}
          defaultValue={containerWidth * 0.52}
          dragDirection={-1}
          onChange={(width) =>
            setReaderRatio(width / Math.max(1, containerWidth))
          }
        />
      )}
      {description && open && reader}
    </div>
  )
}
