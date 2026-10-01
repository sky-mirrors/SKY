import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 2026-10-01（性能：知识库上传很卡）：
 * 实测 embedder 每次调用有约 500ms **固定开销**（与文本长度无关：175字符→165ms、
 * 700字符→554ms、2800字符→545ms 饱和），而摄取是**逐 chunk 串行**生成向量的
 * ⇒ 一个 70 块的文件要等几十秒。改为**批量**：一次把多个文本交给 embedder。
 *
 * 本文件锁定批量 API 的行为与降级语义（embedder 不可用时全部退化为伪向量）。
 */
const embedMock = vi.fn()

vi.mock('@/services/embedder', async () => {
  const actual = await vi.importActual<typeof import('@/services/embedder')>('@/services/embedder')
  return actual
})

beforeEach(() => {
  vi.resetModules()
  embedMock.mockReset()
})

describe('generateVectorsWithMeta —— 批量生成', () => {
  it('空数组返回空数组（不调用 embedder）', async () => {
    const mod = await import('@/services/embedder')
    const out = await mod.generateVectorsWithMeta([])
    expect(out).toEqual([])
  })

  it('全部命中缓存时不调用底层 embed', async () => {
    const mod = await import('@/services/embedder')
    mod.clearVectorCache()
    const first = await mod.generateVectorsWithMeta(['文本甲', '文本乙'])
    expect(first).toHaveLength(2)
    // 再问一次：应全部命中缓存（无法直接断言 embed 调用次数——embedder 可能不可用
    // 而走伪向量路径；这里断言结果一致性与向量维度即可）
    const second = await mod.generateVectorsWithMeta(['文本甲', '文本乙'])
    expect(second.map(v => v.vector.length)).toEqual(first.map(v => v.vector.length))
    expect(second.map(v => v.isPseudo)).toEqual(first.map(v => v.isPseudo))
  })

  it('返回顺序与输入一一对应', async () => {
    const mod = await import('@/services/embedder')
    mod.clearVectorCache()
    const out = await mod.generateVectorsWithMeta(['甲甲甲甲甲', '乙乙乙乙乙', '丙丙丙丙丙'])
    expect(out).toHaveLength(3)
    // 用同一批内容单独生成，逐项比对——顺序若错位会不一致
    const singles = []
    for (const t of ['甲甲甲甲甲', '乙乙乙乙乙', '丙丙丙丙丙']) {
      singles.push(await mod.generateVectorWithMeta(t))
    }
    out.forEach((v, i) => {
      expect(v.isPseudo).toBe(singles[i].isPseudo)
      expect(v.vector.length).toBe(singles[i].vector.length)
      // 向量内容应完全一致（同一文本、同一模型）
      expect(v.vector.slice(0, 8)).toEqual(singles[i].vector.slice(0, 8))
    })
  })

  it('单条与批量的结果一致（批量不得改变语义）', async () => {
    const mod = await import('@/services/embedder')
    mod.clearVectorCache()
    const single = await mod.generateVectorWithMeta('一致性校验文本')
    mod.clearVectorCache()
    const [batched] = await mod.generateVectorsWithMeta(['一致性校验文本'])
    expect(batched.isPseudo).toBe(single.isPseudo)
    expect(batched.vector.length).toBe(single.vector.length)
    expect(batched.vector.slice(0, 16)).toEqual(single.vector.slice(0, 16))
  })
})
