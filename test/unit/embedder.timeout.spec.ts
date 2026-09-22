// A：embedder 有界加载。
//
// 根因（有证据、待本测试坐实）：src/services/embedder.ts 的 getEmbedder() 用
// pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2') 从网络拉模型，**无内置超时**；
// 网络阻塞时该 promise 永不 settle，且它被缓存（embedderPromise）——于是所有走嵌入的
// RAG 路由永久挂起、isProcessing 卡 true（考试 Q1/Q2 卡死 + 普通对话发 Q14 亦卡死的同型现象）。
//
// 本测试钉：模型加载挂起时 getEmbedder 必须有界返回 null（降级伪向量），并进入冷却窗不重复挂起。
import { describe, it, expect, vi } from 'vitest'

vi.mock('@xenova/transformers', () => ({
  // 永不 settle：模拟网络挂起（TLS 卡住 / CDN 无响应）
  pipeline: vi.fn(() => new Promise(() => {}))
}))

import { getEmbedder, generateVector, isEmbedderReady } from '@/services/embedder'

describe('embedder 有界加载（路由卡死修复）', () => {
  it('模型加载挂起时 getEmbedder 有界返回 null（不永久阻塞）', async () => {
    const t0 = Date.now()
    const e = await getEmbedder(60)
    expect(e).toBeNull()
    expect(isEmbedderReady()).toBe(false)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('失败后进入冷却窗：后续调用立即返回 null（不重复挂起）', async () => {
    const t0 = Date.now()
    const e = await getEmbedder(60)
    expect(e).toBeNull()
    expect(Date.now() - t0).toBeLessThan(150)
  })

  it('embedder 不可用时 generateVector 降级为 384 维伪向量', async () => {
    const v = await generateVector('测试文本内容')
    expect(v.length).toBe(384)
  })
})
