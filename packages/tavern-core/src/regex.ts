import type { RegexPlacement, RegexScript } from './types.ts'

/**
 * 解析 SillyTavern 风格的正则字符串（支持 `/pattern/flags` 与纯文本模式）
 */
export function compileRegex(pattern: string): RegExp | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null
  try {
    const slashMatch = trimmed.match(/^\/([\s\S]+)\/([gimsuy]*)$/)
    if (slashMatch) {
      return new RegExp(slashMatch[1]!, slashMatch[2] || 'g')
    }
    return new RegExp(trimmed, 'g')
  } catch {
    return null
  }
}

export function applyRegexScripts(
  text: string,
  scripts: RegexScript[],
  placement: RegexPlacement,
  depth = 0
): string {
  if (!text || scripts.length === 0) {
    return text
  }
  let current = text
  for (const script of scripts) {
    if (script.disabled) continue
    if (!script.placements.includes(placement)) continue
    if (typeof script.minDepth === 'number' && depth < script.minDepth) continue
    if (typeof script.maxDepth === 'number' && depth > script.maxDepth) continue

    const regex = compileRegex(script.findRegex)
    if (!regex) continue

    current = current.replace(regex, (...args) => {
      let replacement = script.replaceString
      // 支持酒馆 {{match}} 占位符
      const fullMatch = String(args[0] ?? '')
      replacement = replacement.replace(/\{\{match\}\}/g, fullMatch)
      // 支持 $1..$9 分组
      for (let i = 1; i < args.length - 2; i++) {
        const groupVal = args[i] === undefined ? '' : String(args[i])
        replacement = replacement.replace(new RegExp(`\\$${i}`, 'g'), groupVal)
      }
      if (script.trimStrings && script.trimStrings.length > 0) {
        for (const trimStr of script.trimStrings) {
          if (trimStr) {
            replacement = replacement.split(trimStr).join('')
          }
        }
      }
      return replacement
    })
  }
  return current
}
