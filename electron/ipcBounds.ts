/**
 * 主进程有界性（快照 §十一 P1/P2 第 2 条：E-5 / E-6 / E-7）的**叶子实现**。
 *
 * 为什么单独成模块：这些逻辑原本内联在 `electron/ipc-handlers.ts`（该文件 import electron，
 * 整文件无法在 vitest 里加载）。抽到无 Electron 依赖的叶子层后，「体积上限」与「发送前判
 * 存活」这两条不变量可被单测钉住——与 `electron/llmAbortRegistry.ts` 同一做法。
 */

/** 单一响应体读取上限（原 `ipc-handlers.ts` 内常量，2026-09-27 迁来并保持取值不变） */
export const HTTP_MAX_RESPONSE_SIZE = 512000

/** LLM JSON 响应体上限（E-6）：远大于 maxTokens 上限所能产出的正文，只在异常时兜底 */
export const LLM_JSON_MAX_BYTES = 2 * 1024 * 1024

export interface CappedRead { text: string; truncated: boolean }

/**
 * A-15：响应体流式限量读取——`resp.text()` 会先把整个响应载入内存后才截断，
 * 恶意/超大响应可直接打爆主进程内存；读到上限即停止并释放剩余连接。
 * 同时把「是否被截断」显式回传（E-6 需要在截断时拒解析，而旧签名无法区分）。
 */
export async function readCapped(resp: Response, maxBytes: number): Promise<CappedRead> {
  if (!resp.body) {
    const whole = await resp.text()
    return whole.length > maxBytes
      ? { text: whole.substring(0, maxBytes), truncated: true }
      : { text: whole, truncated: false }
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (received + value.byteLength > maxBytes) {
      const room = maxBytes - received
      if (room > 0) out += decoder.decode(value.subarray(0, room))
      try { await reader.cancel() } catch { /* 已关闭/已消费 */ }
      return { text: out, truncated: true }
    }
    received += value.byteLength
    out += decoder.decode(value, { stream: true })
  }
  return { text: out, truncated: false }
}

/** 旧签名兼容：截断即返回部分内容（http:fetch 等展示型读取仍用它）。 */
export async function readBodyCapped(resp: Response, maxBytes: number = HTTP_MAX_RESPONSE_SIZE): Promise<string> {
  return (await readCapped(resp, maxBytes)).text
}

/**
 * E-6：JSON 响应体先加体积上限再解析。
 * 与 `readBodyCapped` 不同，超上限**抛错**而非静默截断——截断的 JSON 喂给 `JSON.parse`
 * 只会得到含混的语法错误，明确报"超过上限"才利于定位，也才是 fail-closed。
 */
export async function readJsonCapped<T>(resp: Response, maxBytes: number = HTTP_MAX_RESPONSE_SIZE): Promise<T> {
  const { text, truncated } = await readCapped(resp, maxBytes)
  if (truncated) throw new Error(`响应体超过上限 ${maxBytes} 字节，已拒绝解析`)
  return JSON.parse(text) as T
}

/** WebContents 的最小形状——便于用假对象单测，不引入 Electron 类型依赖 */
export interface SenderLike {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/**
 * E-7：向渲染进程投递前先判存活。
 *
 * 窗口销毁后 `WebContents.send` 会抛（"Object has been destroyed"）。流式 handler 的
 * catch 里就有一处 `event.sender.send(errorChannel, ...)`——它一抛，紧随其后的
 * `activeStreamControllers.delete(streamId)` 便**不可达**，控制器与上游连接会泄漏到 tier
 * 超时。这里统一吞错并回传是否投递成功，调用方即可放心在其后做清理。
 */
export function safeSendTo(sender: SenderLike, channel: string, payload: unknown): boolean {
  try {
    if (sender.isDestroyed()) return false
    sender.send(channel, payload)
    return true
  } catch {
    return false
  }
}
