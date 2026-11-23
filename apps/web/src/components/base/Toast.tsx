import { useAppStore } from '../../services/store.ts'

export const Toast = () => {
  const toast = useAppStore((s) => s.toast)
  const clearToast = useAppStore((s) => s.clearToast)
  if (!toast) return null

  const bg =
    toast.tone === 'error'
      ? 'var(--danger)'
      : toast.tone === 'success'
        ? 'var(--success)'
        : 'var(--text-primary)'

  return (
    <div
      role="status"
      onClick={clearToast}
      style={{
        position: 'fixed',
        top: 'calc(var(--sat) + 14px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 100,
        background: bg,
        color: '#ffffff',
        padding: '8px 16px',
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 500,
        boxShadow: 'var(--shadow-md)',
        maxWidth: 'min(90vw, 480px)',
        cursor: 'pointer',
      }}
    >
      {toast.text}
    </div>
  )
}
