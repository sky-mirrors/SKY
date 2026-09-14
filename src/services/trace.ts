// §5.2 统一 traceId：请求入口生成，渲染层内经模块级运行态传播
// （bus payload 均携带；跨窗口/主进程传播留待后续批次）

let _currentTraceId = ''

export function newTraceId(): string {
  _currentTraceId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return _currentTraceId
}

export function getCurrentTraceId(): string {
  return _currentTraceId
}
