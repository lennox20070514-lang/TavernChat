import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons.tsx'
import styles from './Modal.module.css'

type ModalProps = {
  open: boolean
  title: string
  size?: 'sm' | 'md' | 'lg'
  onClose: () => void
  headerExtra?: ReactNode
  children: ReactNode
}

export const Modal = ({
  open,
  title,
  size = 'md',
  onClose,
  headerExtra,
  children,
}: ModalProps) => {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={clsx(styles.dialog, styles[size])} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {headerExtra}
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
              <IconClose />
            </button>
          </div>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>,
    document.body
  )
}
