import { useAppStore } from '../../services/store.ts'
import { Modal } from '../base/Modal.tsx'

export const PromptPreviewModal = () => {
  const open = useAppStore((s) => s.promptPreviewOpen)
  const setOpen = useAppStore((s) => s.setPromptPreviewOpen)
  const previewCurrentPrompt = useAppStore((s) => s.previewCurrentPrompt)

  if (!open) return null
  const assembled = previewCurrentPrompt()

  return (
    <Modal open={open} title="上下文透视（本次发送给模型的完整内容）" size="md" onClose={() => setOpen(false)}>
      {!assembled ? (
        <div style={{ padding: 24, color: 'var(--text-tertiary)' }}>暂无活动对话</div>
      ) : (
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-subtle)',
              fontSize: 13,
            }}
          >
            <span>
              估算总计：<strong>{assembled.totalTokens}</strong> / {assembled.maxContextTokens} tokens
            </span>
            <span>
              触发世界书：<strong>{assembled.triggeredWorld.length}</strong> 条
            </span>
            {assembled.droppedHistoryCount > 0 ? (
              <span style={{ color: 'var(--danger)' }}>
                超出预算截断旧消息：{assembled.droppedHistoryCount} 条
              </span>
            ) : null}
          </div>

          {assembled.triggeredWorld.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
                本次激活的世界书条目
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {assembled.triggeredWorld.map((item) => (
                  <span
                    key={`${item.worldId}-${item.entryId}`}
                    style={{
                      fontSize: 12,
                      padding: '3px 10px',
                      borderRadius: 999,
                      background: 'var(--kind-world-bg)',
                      border: '1px solid var(--kind-world-border)',
                      color: 'var(--kind-world)',
                    }}
                  >
                    {item.worldName} · {item.entryName}（
                    {item.reason === 'constant'
                      ? '常驻'
                      : item.reason === 'recursion'
                        ? `递归: ${item.matchedKeys.join(', ')}`
                        : `命中: ${item.matchedKeys.join(', ')}`}
                    ）
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {assembled.messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '6px 12px',
                    background: 'var(--bg-subtle)',
                    borderBottom: '1px solid var(--border-subtle)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>
                    <strong>[{m.role}]</strong> {m.sourceLabel || ''}
                  </span>
                  <span style={{ color: 'var(--text-tertiary)' }}>~{m.tokens ?? 0} tok</span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '10px 12px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.55,
                  }}
                >
                  {m.content}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}
