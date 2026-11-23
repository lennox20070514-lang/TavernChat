/**
 * 零依赖轻量 Token 估算器（全端通用，无需 WASM tiktoken）
 *
 * 经验权重：
 * - 中文 / 日文 / 韩文 CJK 字符：约 0.65 token / 字（现代大模型 tokenizer 如 DeepSeek/GPT-4o/Claude 普遍在 0.55~0.8）
 * - ASCII 英文单词与数字：约 0.28 token / 字符（~3.6 字符 / token）
 * - 标点与空白：约 0.25 token / 字符
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0
  }
  let cjkCount = 0
  let otherCount = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount++
    } else {
      otherCount++
    }
  }
  return Math.max(1, Math.ceil(cjkCount * 0.68 + otherCount * 0.28))
}

export function estimateMessageTokens(content: string): number {
  return estimateTokens(content) + 4
}
