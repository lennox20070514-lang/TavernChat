/**
 * 兼容旧版 Android System WebView (Chrome < 103)、Safari (< 16.4) 及局域网 HTTP 非安全上下文的工具集。
 */

export type TimeoutSignalHandle = {
  signal: AbortSignal
  cancel: () => void
}

/**
 * 替代 `AbortSignal.timeout(ms)`，避免旧版 Android WebView / Safari 抛出 TypeError。
 */
export function createTimeoutSignal(ms: number): TimeoutSignalHandle {
  const controller = new AbortController()
  const timer = window.setTimeout(() => {
    controller.abort(new Error('请求超时'))
  }, ms)
  return {
    signal: controller.signal,
    cancel: () => window.clearTimeout(timer),
  }
}

/**
 * 兼容 ES2021 及更早环境的自有属性检查（替代 `Object.hasOwn`）。
 */
export function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}
