import type { ReactNode } from 'react'
import { useStrings } from './i18n'

/**
 * DSH 设置页的应用内对话框。
 *
 * 之所以不用 window.confirm：Electron 的原生同步对话框不做窗口内居中，
 * 弹出位置相对应用窗口错位，且无法套用 Vibing 主题 token。这里与
 * preset 删除等既有弹窗保持同一形态：fixed 全屏遮罩 + 内容水平垂直居中。
 */
export function DshDialog({
  title,
  onClose,
  actions,
  testId,
  children
}: {
  title: string
  onClose: () => void
  actions: ReactNode
  testId?: string
  children: ReactNode
}) {
  const strings = useStrings()
  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
    >
      <button
        type="button"
        aria-label={strings.common.close}
        className="absolute inset-0 bg-backdrop"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-2xl bg-surface p-5 shadow-window">
        <h3 className="mb-3 font-pingfang text-[16px] font-medium text-text-primary">
          {title}
        </h3>
        {children}
        <div className="mt-4 flex justify-end gap-2">{actions}</div>
      </div>
    </div>
  )
}

/** 带确认/取消的警告对话框（Full access、home 切换、删除 provider 等）。 */
export function DshConfirmDialog({
  title,
  message,
  testId,
  busy = false,
  danger = false,
  onConfirm,
  onCancel
}: {
  title: string
  message: string
  testId?: string
  busy?: boolean
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const strings = useStrings()
  return (
    <DshDialog
      title={title}
      testId={testId}
      onClose={onCancel}
      actions={
        <>
          <button
            type="button"
            data-testid={testId ? `${testId}-cancel` : undefined}
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 font-pingfang text-[12px]"
          >
            {strings.common.cancel}
          </button>
          <button
            type="button"
            data-testid={testId ? `${testId}-confirm` : undefined}
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-lg px-3 py-1.5 font-pingfang text-[12px] text-text-inverse disabled:opacity-40 ${
              danger ? 'bg-status-error' : 'bg-button-primary text-button-primary-fg'
            }`}
          >
            {strings.common.confirm}
          </button>
        </>
      }
    >
      <p className="font-pingfang text-[13px] text-text-muted">{message}</p>
    </DshDialog>
  )
}
