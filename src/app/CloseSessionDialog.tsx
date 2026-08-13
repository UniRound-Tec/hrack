import { useEffect } from 'react'
import { motion } from 'motion/react'
import type { SessionEntry } from '../state/sessionsStore'
import { useStrings } from './i18n'

interface CloseSessionDialogProps {
  session: SessionEntry
  onCancel: () => void
  onConfirm: () => void
}

export default function CloseSessionDialog({
  session,
  onCancel,
  onConfirm
}: CloseSessionDialogProps) {
  const strings = useStrings()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

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
        onClick={onCancel}
      />
      <motion.div
        className="pointer-events-none absolute inset-0 z-[90] flex items-center justify-center p-5"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
      >
        <motion.div
          data-testid="close-session-confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-session-confirm-title"
          className="pointer-events-auto w-full max-w-[380px] rounded-2xl border border-border-default bg-surface p-4 shadow-2xl"
          initial={{ opacity: 0, scale: 0.95, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ type: 'spring', stiffness: 480, damping: 34, mass: 0.8 }}
        >
          <h2
            id="close-session-confirm-title"
            className="font-pingfang text-[14px] font-semibold text-text-primary"
          >
            {strings.navigation.closeSession}
          </h2>
          <p className="mt-2 font-pingfang text-[12px] leading-5 text-text-muted">
            {session.kind === 'dsh'
              ? strings.navigation.closeDshSessionPrompt(session.name)
              : strings.navigation.closeSessionPrompt(session.name)}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              autoFocus
              type="button"
              data-testid="close-session-confirm-cancel"
              className="rounded-lg px-3 py-1.5 font-pingfang text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-strong hover:text-text-secondary"
              onClick={onCancel}
            >
              {strings.common.cancel}
            </button>
            <button
              type="button"
              data-testid="close-session-confirm-submit"
              className="rounded-lg bg-status-error px-3 py-1.5 font-pingfang text-[12px] font-medium text-white transition-opacity hover:opacity-90"
              onClick={onConfirm}
            >
              {strings.navigation.closeSession}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </>
  )
}
