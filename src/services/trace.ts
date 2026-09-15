// §5.2 统一 traceId：请求入口生成，经参数显式传播
// #2 收尾：原模块级可变全局 _currentTraceId 在并发请求下互相覆盖
// （A 请求生成后 B 请求改写，A 的 record-cost/probe 归因到 B）——
// 改为纯函数生成 + 调用链参数传递，不再有跨请求共享状态

export function newTraceId(): string {
  return (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
