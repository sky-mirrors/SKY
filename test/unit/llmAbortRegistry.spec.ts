import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerLlmRequest,
  abortLlmRequest,
  releaseLlmRequest,
  activeLlmRequestCount
} from '@electron/llmAbortRegistry'

/**
 * 非流式 LLM IPC 请求的取消注册表（`llm:abort` 通道的服务端）。
 *
 * 背景：`apiStore` 的 B-07 `Promise.race` 只让**调用方**不再等待，
 * `ipcRenderer.invoke('llm:chatCompletion')` 早已发出、主进程 fetch 照跑，
 * Token 照计。补齐的方向是给请求一个 requestId，让主进程能按 id 真正 abort。
 * 本表就是 requestId → AbortController 的登记处；下面钉住它的生命周期语义。
 */

// 每个用例前把可能残留的 id 清干净，避免用例间串扰
const IDS = ['r1', 'r2', 'r3', 'dup', 'unknown']

describe('llmAbortRegistry（非流式 LLM 请求取消注册表）', () => {
  beforeEach(() => {
    for (const id of IDS) releaseLlmRequest(id)
  })

  it('register 返回未中止的控制器，activeLlmRequestCount 反映在途数', () => {
    expect(activeLlmRequestCount()).toBe(0)
    const ctrl = registerLlmRequest('r1')
    expect(ctrl.signal.aborted).toBe(false)
    expect(activeLlmRequestCount()).toBe(1)
    releaseLlmRequest('r1')
    expect(activeLlmRequestCount()).toBe(0)
  })

  it('abortLlmRequest 命中在途请求并置 signal.aborted=true；未知 id 返回 false', () => {
    const ctrl = registerLlmRequest('r2')
    expect(abortLlmRequest('r2')).toBe(true)
    expect(ctrl.signal.aborted).toBe(true)
    expect(abortLlmRequest('unknown')).toBe(false)
  })

  it('release 后 abort 不再命中（请求收敛即摘除，幂等调用安全）', () => {
    registerLlmRequest('r3')
    releaseLlmRequest('r3')
    expect(abortLlmRequest('r3')).toBe(false)
    expect(activeLlmRequestCount()).toBe(0)
  })

  it('同 id 重复 register 会中止旧控制器并替换，不遗留悬挂的 in-flight', () => {
    const first = registerLlmRequest('dup')
    const second = registerLlmRequest('dup')
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(activeLlmRequestCount()).toBe(1)
    releaseLlmRequest('dup')
    expect(activeLlmRequestCount()).toBe(0)
  })
})
