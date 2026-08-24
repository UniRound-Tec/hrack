import { useEffect } from 'react'
import { motion } from 'motion/react'
import { useStrings } from './i18n'
import MarkdownBody from '../markdown/MarkdownBody'

interface UpdateAvailableModalProps {
  version: string
  releaseNotes: string | null
  onUpdate: () => void
  onIgnore: () => void
  onNever: () => void
  onLater: () => void
}

export default function UpdateAvailableModal({
  version,
  releaseNotes,
  onUpdate,
  onIgnore,
  onNever,
  onLater
}: UpdateAvailableModalProps) {
  const strings = useStrings()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onLater()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onLater])

  return (
    <>
      <motion.button
        type="button"
        aria-label={strings.common.cancel}
        className="absolute inset-0 z-[80] bg-backdrop-strong backdrop-blur-[3px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onLater}
      />
      <motion.div
        className="pointer-events-none absolute inset-0 z-[90] flex items-center justify-center p-5"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
      >
        <motion.div
          data-testid="update-available-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-available-modal-title"
          className="pointer-events-auto flex max-h-[82vh] w-full max-w-[480px] flex-col rounded-2xl border border-border-default bg-surface p-4 shadow-2xl"
          initial={{ opacity: 0, scale: 0.95, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ type: 'spring', stiffness: 480, damping: 34, mass: 0.8 }}
        >
          <h2
            id="update-available-modal-title"
            className="font-pingfang text-[14px] font-semibold text-text-primary"
          >
            {strings.updateModal.title(version)}
          </h2>
          <div className="mt-3 flex min-h-0 flex-1 flex-col">
            <p className="font-pingfang text-[11px] font-medium tracking-wide text-text-faint">
              {strings.updateModal.releaseNotes}
            </p>
            <div className="sidebar-scroll mt-1.5 max-h-[40vh] min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-faint bg-surface-strong/40 p-3">
              {releaseNotes ? (
                <div
                  data-testid="update-release-notes"
                  className="select-text font-pingfang text-[12px] leading-5 text-text-secondary"
                >
                  <MarkdownBody text={releaseNotes} dense />
                </div>
              ) : (
                <p className="font-pingfang text-[12px] text-text-faint">
                  {strings.updateModal.noReleaseNotes}
                </p>
              )}
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid="update-available-later"
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary"
              onClick={onLater}
            >
              {strings.updateModal.later}
            </button>
            <button
              type="button"
              data-testid="update-available-ignore"
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary"
              onClick={onIgnore}
            >
              {strings.updateModal.ignore}
            </button>
            <button
              type="button"
              data-testid="update-available-never"
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary"
              onClick={onNever}
            >
              {strings.updateModal.never}
            </button>
            <button
              autoFocus
              type="button"
              data-testid="update-available-submit"
              className="rounded-lg bg-button-primary px-3 py-1.5 font-pingfang text-[12px] font-medium text-button-primary-fg transition-colors hover:bg-button-primary-hover"
              onClick={onUpdate}
            >
              {strings.updateModal.update}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </>
  )
}
