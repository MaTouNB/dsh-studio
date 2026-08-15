/** A minimal accessible confirmation dialog (bilingual labels come from the caller). */

import type { ReactNode } from 'react'
import css from './plugin-center.module.css'

/** Confirm-dialog props. */
export interface ConfirmDialogProps {
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

/** Render a modal confirm dialog over the tab. */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel, busy }: ConfirmDialogProps) {
  return (
    <div className={css.dialog} role="presentation">
      <div
        className={css.dialogBox}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className={css.dialogTitle}>{title}</div>
        <div className={css.dialogBody}>{body}</div>
        <div className={css.dialogActions}>
          <button className={css.button} type="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
