import { Fragment, type ReactNode } from 'react'

function highlightPlainText(text: string, query?: string): ReactNode {
  const q = query?.trim()
  if (!q) return text
  const lowerText = text.toLowerCase()
  const lowerQ = q.toLowerCase()
  if (!lowerText.includes(lowerQ)) return text

  const parts: ReactNode[] = []
  let cursor = 0
  let hit = lowerText.indexOf(lowerQ, cursor)
  let k = 0
  while (hit !== -1) {
    if (hit > cursor) {
      parts.push(text.slice(cursor, hit))
    }
    parts.push(
      <mark
        key={`hl_${k++}`}
        style={{
          background: 'rgba(250, 204, 21, 0.42)',
          color: 'inherit',
          padding: '0 2px',
          borderRadius: 3,
        }}
      >
        {text.slice(hit, hit + q.length)}
      </mark>
    )
    cursor = hit + q.length
    hit = lowerText.indexOf(lowerQ, cursor)
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return parts
}

/**
 * 极轻量、安全无 XSS 的叙事向 Markdown 渲染器：
 * - 支持 *动作斜体*、**强调粗体**、> 引用、`行内代码`、```代码块```、标题、段落与搜索关键词高亮。
 */
function renderInline(text: string, highlightQuery?: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(
        <Fragment key={`t_${lastIdx}`}>
          {highlightPlainText(text.slice(lastIdx, match.index), highlightQuery)}
        </Fragment>
      )
    }
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={match.index}>
          {highlightPlainText(token.slice(2, -2), highlightQuery)}
        </strong>
      )
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(
        <em key={match.index} style={{ color: 'var(--text-secondary)' }}>
          {highlightPlainText(token.slice(1, -1), highlightQuery)}
        </em>
      )
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code
          key={match.index}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9em',
            padding: '1px 5px',
            borderRadius: 5,
            background: 'var(--bg-hover)',
          }}
        >
          {highlightPlainText(token.slice(1, -1), highlightQuery)}
        </code>
      )
    }
    lastIdx = match.index + token.length
  }

  if (lastIdx < text.length) {
    nodes.push(
      <Fragment key={`e_${lastIdx}`}>
        {highlightPlainText(text.slice(lastIdx), highlightQuery)}
      </Fragment>
    )
  }
  return nodes
}

export const MarkdownText = ({
  content,
  highlightQuery,
}: {
  content: string
  highlightQuery?: string
}) => {
  if (!content) return null
  const segments = content.split(/(```[\s\S]*?```)/g)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {segments.map((seg, idx) => {
        if (!seg) return null
        if (seg.startsWith('```') && seg.endsWith('```')) {
          const inner = seg.slice(3, -3)
          const nl = inner.indexOf('\n')
          const lang = nl >= 0 ? inner.slice(0, nl).trim() : ''
          const code = nl >= 0 ? inner.slice(nl + 1) : inner
          return (
            <pre
              key={idx}
              style={{
                margin: 0,
                padding: '12px 14px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
                overflowX: 'auto',
                fontFamily: 'var(--font-mono)',
                fontSize: 12.5,
                lineHeight: 1.55,
              }}
            >
              {lang ? (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    marginBottom: 6,
                    textTransform: 'uppercase',
                  }}
                >
                  {lang}
                </div>
              ) : null}
              <code>{highlightPlainText(code, highlightQuery)}</code>
            </pre>
          )
        }

        const paragraphs = seg.split(/\n{2,}/)
        return (
          <Fragment key={idx}>
            {paragraphs.map((para, pIdx) => {
              const trimmed = para.trim()
              if (!trimmed) return null
              if (trimmed === '---' || trimmed === '***') {
                return (
                  <hr
                    key={pIdx}
                    style={{
                      border: 'none',
                      borderTop: '1px solid var(--border-subtle)',
                      margin: '4px 0',
                    }}
                  />
                )
              }
              if (trimmed.startsWith('> ')) {
                return (
                  <blockquote
                    key={pIdx}
                    style={{
                      margin: 0,
                      padding: '6px 12px',
                      borderLeft: '3px solid var(--border-strong)',
                      background: 'var(--bg-subtle)',
                      borderRadius: '0 8px 8px 0',
                      color: 'var(--text-secondary)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {renderInline(trimmed.replace(/^>\s?/gm, ''), highlightQuery)}
                  </blockquote>
                )
              }
              const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
              if (heading) {
                const level = heading[1]!.length
                return (
                  <div
                    key={pIdx}
                    style={{
                      fontWeight: 650,
                      fontSize: level === 1 ? 17 : level === 2 ? 15.5 : 14.5,
                      marginTop: 4,
                    }}
                  >
                    {renderInline(heading[2]!, highlightQuery)}
                  </div>
                )
              }
              return (
                <p key={pIdx} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {renderInline(trimmed, highlightQuery)}
                </p>
              )
            })}
          </Fragment>
        )
      })}
    </div>
  )
}

export const HighlightText = ({
  text,
  query,
}: {
  text: string
  query?: string
}) => <>{highlightPlainText(text, query)}</>
