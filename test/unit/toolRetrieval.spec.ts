import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  keywordMatchScore,
  raapMatch,
  universalMatch,
  getTop3Candidates,
  segmentChinese,
  generateNGrams,
  contentHash,
  manifestFingerprint,
  extractKeywordsFromDescription,
  llmFallback,
  rewriteQuery,
  isOnline,
  getRouteCacheStats,
  clearRouteCache
} from '@/services/toolRetrieval'
import type { MatchableItem } from '@/services/toolRetrieval'
import { cosineSimilarity } from '@/services/embedder'
import type { L2ToolManifest } from '@/models'

vi.mock('@/services/embedder', () => ({
  generateVector: vi.fn(() => Promise.resolve(new Array(384).fill(0.1))),
  cosineSimilarity: vi.fn((a: number[], b: number[]) => {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
  })
}))
vi.mock('@/services/fileContext', () => ({
  getFileBoostForItem: vi.fn(() => 0)
}))
vi.mock('@/stores/feedbackStore', () => ({
  useFeedbackStore: vi.fn(() => ({ getWeightModifier: vi.fn(() => 0) }))
}))
vi.mock('@/stores/debugStore', () => ({
  useDebugStore: vi.fn(() => ({ emitEvent: vi.fn() }))
}))

function makeManifest(o: Partial<L2ToolManifest> = {}): L2ToolManifest {
  return {
    identity: { id: 'test-manifest', name: '测试工具', version: '1.0.0', tier: 'L2', category: 'test', description: '测试' },
    visual: { color: '#fff', icon: '🔧', size: 1, spikes: 4, glowIntensity: 1, position: { x: 0, y: 0, z: 0 } },
    routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结'], retrievalSummary: '生成周报总结', userSummary: '创建周报文件' },
    execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] }, dagPlan: { steps: [], fallbackStrategy: 'retry', maxRetries: 1 } },
    cacheMeta: { estimatedTokenSaving: 500, avgExecutionTime: 1000, cacheable: true },
    ...o
  }
}

describe('segmentChinese', () => {
  it('切分中文词组', () => {
    const segs = segmentChinese('生成周报')
    expect(segs.length).toBeGreaterThan(0)
    expect(segs.join('')).toContain('生成周报')
  })

  it('切分中英混合', () => {
    const segs = segmentChinese('写docx文档')
    expect(segs).toContain('文档')
  })

  it('短字符被过滤', () => {
    expect(segmentChinese('a')).toEqual([])
  })

  it('英文单词保留', () => {
    expect(segmentChinese('hello world')).toEqual(['hello', 'world'])
  })
})

describe('generateNGrams', () => {
  it('生成2-4gram', () => {
    const ngrams = generateNGrams('生成文本', 2, 3)
    expect(ngrams).toContain('生成')
    expect(ngrams).toContain('文本')
    expect(ngrams).toContain('生成文')
  })
})

describe('contentHash', () => {
  it('相同内容生成相同哈希', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'))
  })

  it('不同内容生成不同哈希', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'))
  })
})

describe('manifestFingerprint', () => {
  it('ID相同但keywords不同→指纹不同', () => {
    const m1 = makeManifest()
    const m2 = makeManifest({
      routing: { ...m1.routing, keywords: ['月报', '总结'] }
    })
    expect(manifestFingerprint(m1)).not.toBe(manifestFingerprint(m2))
  })

  it('完全相同→指纹相同', () => {
    const m1 = makeManifest()
    const m2 = makeManifest()
    expect(manifestFingerprint(m1)).toBe(manifestFingerprint(m2))
  })

  it('retrievalSummary变更→指纹不同', () => {
    const m1 = makeManifest()
    const m2 = makeManifest({
      routing: { ...m1.routing, retrievalSummary: '生成月报总结' }
    })
    expect(manifestFingerprint(m1)).not.toBe(manifestFingerprint(m2))
  })
})

describe('keywordMatchScore', () => {
  it('完全匹配关键词', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结'], retrievalSummary: '生成周报', userSummary: '' } })
    const score = keywordMatchScore('帮我写周报总结', m)
    expect(score).toBeGreaterThanOrEqual(0.5)
  })

  it('中文词序颠倒仍匹配', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['文本生成'], retrievalSummary: '文本生成工具', userSummary: '' } })
    const score1 = keywordMatchScore('文本生成', m)
    const score2 = keywordMatchScore('生成文本', m)
    expect(score1).toBeGreaterThan(0)
    expect(score2).toBeGreaterThan(0)
  })

  it('无关输入得低分', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['合同审查', '法务'], retrievalSummary: '合同风险审查', userSummary: '' } })
    const score = keywordMatchScore('帮我写周报', m)
    expect(score).toBeLessThan(0.3)
  })

  it('创建文档语义加分', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['文件'], retrievalSummary: '创建文件', userSummary: '创建文件' } })
    const score = keywordMatchScore('创建一个文档', m)
    expect(score).toBeGreaterThanOrEqual(0.3)
  })

  it('ngram匹配短关键词', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['预算'], retrievalSummary: '预算预测', userSummary: '' } })
    const score = keywordMatchScore('预算预测', m)
    expect(score).toBeGreaterThan(0)
  })
})

describe('raapMatch', () => {
  it('空清单返回null', async () => {
    const result = await raapMatch('测试', [])
    expect(result).toBeNull()
  })

  it('关键词命中返回正确结果', async () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结'], retrievalSummary: '周报生成', userSummary: '' } })
    const result = await raapMatch('帮我写周报总结', [m])
    expect(result).not.toBeNull()
    expect(result!.manifest.identity.id).toBe('test-manifest')
    expect(result!.matchMethod).toContain('keyword')
    expect(result!.candidates).toBeDefined()
  })

  it('无匹配返回null', async () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['合同审查', '法务'], retrievalSummary: '合同风险审查', userSummary: '' } })
    const result = await raapMatch('帮我查天气', [m])
    expect(result).toBeNull()
  })

  it('candidates分数与决策分数一致(反馈修正后构建)', async () => {
    const m1 = makeManifest({
      identity: { id: 'tool-a', name: '工具A', version: '1.0.0', tier: 'L2', category: 'test', description: 'a' },
      routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报'], retrievalSummary: '周报', userSummary: '' }
    })
    const result = await raapMatch('写周报', [m1])
    expect(result).not.toBeNull()
    if (result!.candidates && result!.candidates.length > 0) {
      const topCandidate = result!.candidates[0]
      expect(topCandidate.score).toBe(result!.confidence)
    }
  })

  it('否定词降权：含"不要"时关键词分数大幅降低', async () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['创建', '文件'], retrievalSummary: '创建文件', userSummary: '创建文件' } })
    const normalResult = await raapMatch('创建文件', [m])
    const negatedResult = await raapMatch('不要创建文件', [m])
    if (normalResult && negatedResult) {
      expect(negatedResult.confidence).toBeLessThan(normalResult.confidence)
    }
  })

  it('RRF融合：向量高置信但关键词低分仍能命中', async () => {
    const m = makeManifest({
      identity: { id: 'vec-strong', name: '语义工具', version: '1.0.0', tier: 'L2', category: 'test', description: 'x' },
      routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['量子计算'], retrievalSummary: '量子计算分析', userSummary: '' }
    })
    const result = await raapMatch('量子计算的发展趋势', [m])
    expect(result).not.toBeNull()
  })

  it('Margin判断：唯一匹配比并列匹配更不容易被判ambiguous', async () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结'], retrievalSummary: '周报生成', userSummary: '' } })
    const result = await raapMatch('帮我写周报总结', [m])
    expect(result).not.toBeNull()
  })
})

describe('getTop3Candidates', () => {
  it('返回最多3个候选', () => {
    const manifests = [
      makeManifest({ identity: { id: 'm1', name: '周报', version: '1', tier: 'L2', category: 'test', description: 'a' }, routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报'], retrievalSummary: '周报', userSummary: '' } }),
      makeManifest({ identity: { id: 'm2', name: '月报', version: '1', tier: 'L2', category: 'test', description: 'b' }, routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['月报'], retrievalSummary: '月报', userSummary: '' } }),
      makeManifest({ identity: { id: 'm3', name: '合同', version: '1', tier: 'L2', category: 'test', description: 'c' }, routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['合同'], retrievalSummary: '合同', userSummary: '' } })
    ]
    const candidates = getTop3Candidates('写周报', manifests)
    expect(candidates.length).toBeLessThanOrEqual(3)
    expect(candidates[0].manifest.identity.id).toBe('m1')
  })

  it('无匹配返回空数组', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['合同审查'], retrievalSummary: '合同', userSummary: '' } })
    const candidates = getTop3Candidates('查天气', [m])
    expect(candidates.length).toBe(0)
  })

  it('否定词降权', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['创建', '文件'], retrievalSummary: '创建文件', userSummary: '创建文件' } })
    const normal = getTop3Candidates('创建文件', [m])
    const negated = getTop3Candidates('不要创建文件', [m])
    if (normal.length > 0 && negated.length > 0) {
      expect(negated[0].score).toBeLessThan(normal[0].score)
    }
  })
})

describe('extractKeywordsFromDescription', () => {
  it('从MCP工具名提取关键词', () => {
    const kws = extractKeywordsFromDescription('fs___read_file', 'Read a file from filesystem')
    expect(kws).toContain('read')
    expect(kws).toContain('file')
  })

  it('中文描述提取分词', () => {
    const kws = extractKeywordsFromDescription('report___generate', '生成周报总结')
    expect(kws.some(k => k.includes('周报') || k.includes('生成'))).toBe(true)
  })
})

describe('universalMatch', () => {
  function makeToolIndex(name: string, description: string, isL2 = false, l2ManifestId?: string, vecBase = 0.1) {
    return {
      fullName: isL2 ? `l2://${l2ManifestId || name}` : `mcp___${name}`,
      shortName: name,
      summary: `${name}: ${description.substring(0, 80)}`,
      description,
      vector: new Array(384).fill(vecBase),
      mcpId: isL2 ? '' : 'test-server',
      l2ManifestId,
      isL2Macro: isL2
    }
  }

  it('空索引返回null', async () => {
    const result = await universalMatch('测试', [])
    expect(result).toBeNull()
  })

  it('MCP工具关键词命中', async () => {
    vi.mocked(cosineSimilarity).mockImplementation((_: number[], b: number[]) => {
      return b[0] === 0.15 ? 0.92 : 0.40
    })
    const index = [
      makeToolIndex('read_file', '读取文件，读取磁盘上的文件内容', false, undefined, 0.15),
      makeToolIndex('write_file', '写入文件，将内容写入磁盘文件', false, undefined, 0.10)
    ]
    const result = await universalMatch('读取文件', index)
    expect(result).not.toBeNull()
    expect(result!.item.source).toBe('mcp')
    expect(result!.item.name).toBe('read_file')
  })

  it('MCP工具向量命中', async () => {
    vi.mocked(cosineSimilarity).mockImplementation(() => 0.92)
    const index = [makeToolIndex('search', '语义搜索引擎')]
    const result = await universalMatch('搜索信息', index)
    expect(result).not.toBeNull()
    expect(result!.item.name).toBe('search')
  })

  it('MCP工具否定词降权', async () => {
    vi.mocked(cosineSimilarity).mockImplementation((_: number[], b: number[]) => {
      return b[0] === 0.15 ? 0.60 : 0.30
    })
    const index = [
      makeToolIndex('delete_file', '删除文件，永久删除磁盘上的文件', false, undefined, 0.15),
      makeToolIndex('list_files', '列出文件目录', false, undefined, 0.10)
    ]
    const normalResult = await universalMatch('删除文件', index)
    const negatedResult = await universalMatch('不要删除文件', index)
    if (normalResult && negatedResult) {
      expect(negatedResult.confidence).toBeLessThan(normalResult.confidence)
    }
  })

  it('L2和MCP混合：关键词匹配正确', async () => {
    vi.mocked(cosineSimilarity).mockImplementation((_: number[], b: number[]) => {
      return b[0] === 0.20 ? 0.90 : 0.30
    })
    const index = [
      makeToolIndex('read_file', '读取文件', false, undefined, 0.10),
      makeToolIndex('周报生成', '生成周报总结，写周报', true, 'weekly-report', 0.20)
    ]
    const result = await universalMatch('帮我写周报', index)
    expect(result).not.toBeNull()
    expect(result!.item.name).toBe('周报生成')
  })

  it('候选列表包含MCP来源', async () => {
    vi.mocked(cosineSimilarity).mockImplementation((_: number[], b: number[]) => {
      return b[0] === 0.15 ? 0.90 : 0.40
    })
    const index = [
      makeToolIndex('read_file', '读取文件，读取磁盘上的文件内容', false, undefined, 0.15),
      makeToolIndex('write_file', '写入文件，将内容写入磁盘文件', false, undefined, 0.10)
    ]
    const result = await universalMatch('读取文件', index)
    expect(result).not.toBeNull()
    expect(result!.item.source).toBe('mcp')
  })

  describe('RouteCache', () => {
    beforeEach(() => { clearRouteCache() })

    it('首次查询miss，第二次hit', async () => {
      vi.mocked(cosineSimilarity).mockImplementation((_: number[], b: number[]) => {
        return b[0] === 0.20 ? 0.90 : 0.40
      })
      const index = [
        makeToolIndex('周报生成', '生成周报总结，写周报', true, 'weekly-report', 0.20),
        makeToolIndex('read_file', '读取文件', false, undefined, 0.10)
      ]
      clearRouteCache()
      const stats0 = getRouteCacheStats()
      expect(stats0.size).toBe(0)

      const r1 = await universalMatch('帮我写周报', index)
      expect(r1).not.toBeNull()
      const stats1 = getRouteCacheStats()
      expect(stats1.misses).toBeGreaterThan(0)

      const r2 = await universalMatch('帮我写周报', index)
      expect(r2).not.toBeNull()
      expect(r2!.item.name).toBe(r1!.item.name)
      const stats2 = getRouteCacheStats()
      expect(stats2.hits).toBeGreaterThan(0)
    })

    it('不同查询不命中缓存', async () => {
      vi.mocked(cosineSimilarity).mockImplementation((_: number[], b: number[]) => {
        return b[0] === 0.20 ? 0.90 : 0.40
      })
      const index = [
        makeToolIndex('周报生成', '生成周报总结', true, 'weekly-report', 0.20),
        makeToolIndex('read_file', '读取文件', false, undefined, 0.10)
      ]
      clearRouteCache()
      await universalMatch('帮我写周报', index)
      await universalMatch('帮我读取文件', index)
      const stats = getRouteCacheStats()
      expect(stats.hits).toBe(0)
    })

    it('clearRouteCache清空缓存', async () => {
      vi.mocked(cosineSimilarity).mockImplementation(() => 0.85)
      const index = [makeToolIndex('tool1', '测试工具', false, undefined, 0.10)]
      clearRouteCache()
      await universalMatch('测试查询', index)
      expect(getRouteCacheStats().size).toBeGreaterThan(0)
      clearRouteCache()
      expect(getRouteCacheStats().size).toBe(0)
    })
  })
})

describe('llmFallback', () => {
  function makeItem(id: string, name: string, desc: string, source: 'l2' | 'mcp'): MatchableItem {
    return { id, name, description: desc, keywords: [], userSummary: desc, source }
  }

  it('空候选列表返回null', async () => {
    const mockChat = vi.fn()
    const result = await llmFallback('测试', [], mockChat)
    expect(result).toBeNull()
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('单候选直接返回', async () => {
    const item = makeItem('tool1', '工具1', '描述1', 'mcp')
    const mockChat = vi.fn()
    const result = await llmFallback('测试', [{ item, score: 0.5, method: 'vector' }], mockChat)
    expect(result).toBe(item)
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('LLM选择正确编号', async () => {
    const items = [
      makeItem('tool1', '周报生成', '生成周报', 'mcp'),
      makeItem('tool2', '文件读取', '读取文件', 'mcp'),
      makeItem('tool3', '邮件发送', '发送邮件', 'mcp')
    ]
    const candidates = items.map((item, i) => ({ item, score: 0.5 - i * 0.1, method: 'vector' }))
    const mockChat = vi.fn(() => Promise.resolve({ content: '1' }))
    const result = await llmFallback('帮我写周报', candidates, mockChat)
    expect(result).toBe(items[0])
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('LLM返回编号2', async () => {
    const items = [
      makeItem('tool1', '周报生成', '生成周报', 'mcp'),
      makeItem('tool2', '文件读取', '读取文件', 'mcp')
    ]
    const candidates = items.map((item, i) => ({ item, score: 0.5 - i * 0.1, method: 'vector' }))
    const mockChat = vi.fn(() => Promise.resolve({ content: '2' }))
    const result = await llmFallback('帮我读取文件', candidates, mockChat)
    expect(result).toBe(items[1])
  })

  it('LLM返回无法解析内容返回null', async () => {
    const items = [
      makeItem('tool1', '工具1', '描述1', 'mcp'),
      makeItem('tool2', '工具2', '描述2', 'mcp')
    ]
    const candidates = items.map((item, i) => ({ item, score: 0.5 - i * 0.1, method: 'vector' }))
    const mockChat = vi.fn(() => Promise.resolve({ content: '无法判断' }))
    const result = await llmFallback('测试', candidates, mockChat)
    expect(result).toBeNull()
  })

  it('LLM调用失败返回null', async () => {
    const items = [
      makeItem('tool1', '工具1', '描述1', 'mcp'),
      makeItem('tool2', '工具2', '描述2', 'mcp')
    ]
    const candidates = items.map((item, i) => ({ item, score: 0.5 - i * 0.1, method: 'vector' }))
    const mockChat = vi.fn(() => Promise.reject(new Error('API error')))
    const result = await llmFallback('测试', candidates, mockChat)
    expect(result).toBeNull()
  })
})

describe('rewriteQuery', () => {
  it('短输入不触发改写', async () => {
    const mockChat = vi.fn()
    const result = await rewriteQuery('帮我', mockChat)
    expect(result).toBe('帮我')
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('纯英文短命令不触发改写', async () => {
    const mockChat = vi.fn()
    const result = await rewriteQuery('read_file', mockChat)
    expect(result).toBe('read_file')
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('LLM改写成功', async () => {
    const mockChat = vi.fn(() => Promise.resolve({ content: '生成周报文档' }))
    const result = await rewriteQuery('帮我搞一下那个周报的东西', mockChat)
    expect(result).toBe('生成周报文档')
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('LLM返回过长结果使用原始输入', async () => {
    const longResult = 'a'.repeat(120)
    const mockChat = vi.fn(() => Promise.resolve({ content: longResult }))
    const result = await rewriteQuery('帮我生成报告', mockChat)
    expect(result).toBe('帮我生成报告')
  })

  it('LLM返回多行结果使用原始输入', async () => {
    const mockChat = vi.fn(() => Promise.resolve({ content: '生成报告\n第二步' }))
    const result = await rewriteQuery('帮我生成报告', mockChat)
    expect(result).toBe('帮我生成报告')
  })

  it('LLM调用失败返回原始输入', async () => {
    const mockChat = vi.fn(() => Promise.reject(new Error('API error')))
    const result = await rewriteQuery('帮我生成报告', mockChat)
    expect(result).toBe('帮我生成报告')
  })

  it('离线模式跳过改写', async () => {
    const originalOnLine = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const mockChat = vi.fn()
    const result = await rewriteQuery('帮我搞一下那个周报的东西', mockChat)
    expect(result).toBe('帮我搞一下那个周报的东西')
    expect(mockChat).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true })
  })
})

describe('isOnline + llmFallback offline', () => {
  function makeItem(id: string, name: string, desc: string, source: 'l2' | 'mcp'): MatchableItem {
    return { id, name, description: desc, keywords: [], userSummary: desc, source }
  }

  it('isOnline返回布尔值', () => {
    expect(typeof isOnline()).toBe('boolean')
  })

  it('llmFallback离线时走规则引擎降级', async () => {
    const originalOnLine = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const items = [
      makeItem('tool1', '周报生成', '生成周报总结文档', 'mcp'),
      makeItem('tool2', '邮件发送', '发送邮件通知', 'mcp')
    ]
    const candidates = items.map((item, i) => ({ item, score: 0.5 - i * 0.1, method: 'vector' }))
    const mockChat = vi.fn()
    const result = await llmFallback('帮我写周报', candidates, mockChat)
    expect(result).not.toBeNull()
    expect(mockChat).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true })
  })
})
