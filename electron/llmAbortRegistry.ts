/**
 * 非流式 LLM IPC 请求的取消注册表 —— `llm:abort` 通道的服务端。
 *
 * 为什么需要它：`electron/ipc-handlers.ts` 的 `llm:chatCompletion` 用 `ipcMain.handle`
 * 承载，请求-响应模型**无法携带 AbortSignal**。渲染侧（`apiStore` 的 B-07）此前只能用
 * `Promise.race` 让调用方不再等待——`ipcRenderer.invoke` 早已发出，主进程 fetch 照跑到底、
 * Token 照计。要让「终止执行」真的省下 Token，就得给每个请求一个 requestId，让主进程能按 id
 * 中止在途 fetch；本表即 requestId → AbortController 的登记处。
 *
 * 与流式路径（`activeStreamControllers`）同构，但独立成模块以便无 electron 依赖地单测。
 * 本模块是纯 Map 逻辑，不 import electron —— 放在叶子层，避免测试被迫 mock 重型模块。
 */

const controllers = new Map<string, AbortController>()

/**
 * 为一次非流式请求登记可取消控制器。
 * 同一 id 重复登记会先中止旧控制器再替换——防止重试/复用 id 时遗留悬挂的 in-flight 请求。
 */
export function registerLlmRequest(requestId: string): AbortController {
  const prev = controllers.get(requestId)
  if (prev && !prev.signal.aborted) prev.abort()
  const ctrl = new AbortController()
  controllers.set(requestId, ctrl)
  return ctrl
}

/**
 * 按 requestId 中止在途请求，返回是否命中。
 * 幂等：重复中止同一 id（或对已收敛的 id）返回 false，不抛错。
 */
export function abortLlmRequest(requestId: string): boolean {
  const ctrl = controllers.get(requestId)
  if (!ctrl) return false
  ctrl.abort()
  return true
}

/**
 * 请求收敛（成功 / 失败 / 已中止）后摘除登记，避免 Map 无限增长。
 * 调用方须在 finally 中调用，保证任何出口都不漏。
 */
export function releaseLlmRequest(requestId: string): void {
  controllers.delete(requestId)
}

/** 当前在途的非流式请求数（诊断 / 测试用）。 */
export function activeLlmRequestCount(): number {
  return controllers.size
}
