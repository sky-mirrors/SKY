import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  computeDynamicThreshold,
  recordScore,
  __resetScoreHistoryForTest,
  keywordMatchScore,
  raapMatch,
  universalMatch,
  getTop3Candidates,
  segmentChinese,
  generateNGrams,
  manifestFingerprint,
  extractKeywordsFromDescription,
  llmFallback,
  isOnline,
  getRouteCacheStats,
  clearRouteCache
} from '@/services/toolRetrieval'
import { contentHash } from '@/services/hash'
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

describe('computeDynamicThreshold · 分数池（2026-09-30 幸存者偏差修复）', () => {
  beforeEach(() => { __resetScoreHistoryForTest() })

  it('池样本 < 10 → 回落 fallback（冷启动/每次重启后的实际状态：池是内存态、无持久化）', () => {
    for (let i = 0; i < 9; i++) recordScore(0.9, 'keyword')
    expect(computeDynamicThreshold(0.6, 0.6, 'keyword')).toBe(0.6)
  })

  it('池只含高分（旧实现的幸存者偏差）会把动态阈值抬高；含真实分布的低分时更低', () => {
    // 旧实现只在"命中分支"记录 → 池里全是通过的分数
    for (let i = 0; i < 60; i++) recordScore(0.80 + (i % 20) / 100, 'keyword') // 0.80-0.99
    const biased = computeDynamicThreshold(0.6, 0.6, 'keyword')

    __resetScoreHistoryForTest()
    // 修复后：决策前就记录 → 池含被拒的低分，代表真实分布
    for (let i = 0; i < 60; i++) recordScore(0.20 + (i % 60) / 100, 'keyword') // 0.20-0.79
    const realistic = computeDynamicThreshold(0.6, 0.6, 'keyword')

    expect(biased).toBeGreaterThan(realistic)
  })
  it('接线：recordScore 在决策**之前**调用、且不在 hit 分支内（幸存者偏差修复的直接断言）', () => {
    // 上面两条测的是 computeDynamicThreshold 本身的行为，**证伪不了"调用位置错"**；
    // 这条直接读源码钉住位置——回滚到"只在 hit 分支记录"会立刻红。
    const src = readFileSync(join(process.cwd(), 'src/services/toolRetrieval.ts'), 'utf-8')
    // 按行精确比对（行尾可能是 CRLF，不用 \n 字面量）；缩进 2 空格 = 函数体顶层（决策前），
    // 旧实现是 4 空格（hit/moderate 分支内）——回滚会立刻红。
    const lines = src.split(/\r?\n/)
    const kwIdx = lines.findIndex(l => l.trim() === "recordScore(top1KwScore, 'keyword')")
    expect(kwIdx).toBeGreaterThan(-1)
    expect(lines[kwIdx]).toBe("  recordScore(top1KwScore, 'keyword')")
    expect(lines[kwIdx + 1]).toBe("  recordScore(top1VecScore, 'vector')")
    expect(lines.some(l => l === "    recordScore(top1KwScore, 'keyword')")).toBe(false)
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

  it('2026-09-30：表长不再惩罚覆盖广度——长表单命中不再跌破中信号线', () => {
    // 原式 hits/表长：8 词表命中 1 个 = 0.125，**低于门控的「中信号」线 0.3**（见 universalMatch
    // 的 hasModerateSignal），于是关键词侧完全不产生信号、L2 实际只靠向量（实测日志：
    // `关键词Top3: 文档转 PDF=0.1667` 而正确答案被 `中等置信且margin小` 拒绝指派）。
    // 分母改为 min(表长, 3) 后单命中即 1/3 ≈ 0.333。
    const long = makeManifest({
      routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结', '汇报', '报告', '统计', '汇总', '简报', '纪要'], retrievalSummary: '', userSummary: '' }
    })
    const short = makeManifest({
      routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结', '汇报'], retrievalSummary: '', userSummary: '' }
    })
    const sLong = keywordMatchScore('帮我写周报', long)
    const sShort = keywordMatchScore('帮我写周报', short)
    // 单命中时，长表与短表同分，且都过中信号线（3 词及以下的表行为不变）
    expect(sLong).toBeCloseTo(sShort, 5)
    expect(sLong).toBeGreaterThanOrEqual(0.3)
  })

  it('门控尺度自洽（2026-09-30 分母归一化后）：单命中过中信号线 0.3、双命中过强信号线 0.6', () => {
    // universalMatch 的门控用绝对阈值：hasModerateSignal = kw >= 0.3、hasStrongSignal = kw >= 0.6。
    // 这两条线只有在「分数尺度固定」时才有意义——分母归一化前长表单命中 0.125 永远够不到 0.3，
    // 门控形同虚设。归一化后尺度固定：命中 1 个 = 1/3 ≈ 0.333、2 个 = 2/3 ≈ 0.667。
    const m = makeManifest({
      routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['周报', '总结', '汇报', '报告', '统计', '汇总'], retrievalSummary: '', userSummary: '' }
    })
    const one = keywordMatchScore('帮我写周报', m)
    const two = keywordMatchScore('帮我写周报总结', m)
    expect(one).toBeGreaterThanOrEqual(0.3)  // 中信号 → 进入消歧流程
    expect(one).toBeLessThan(0.6)
    expect(two).toBeGreaterThanOrEqual(0.6)  // 强信号 → 可直接取候选
  })

  it('P1-D5：禁词命中直接归零——列查类输入不得路由到文件创建器', () => {
    const m = makeManifest({
      routing: {
        targetRoles: [], triggerKeywords: [], confidence: 0.9,
        keywords: ['创建', '新建', '写文件', '生成文件', 'docx'],
        forbiddenKeywords: ['列出', '清单', '有哪些', '看一下', '查看', '转成'],
        retrievalSummary: '根据用户描述创建文件并保存到桌面',
        userSummary: '描述内容→创建文件→保存到桌面'
      }
    })
    // 命中"创建+文件"加权条件，但含禁词"清单" → 必须归零
    expect(keywordMatchScore('帮我生成一份文件清单', m)).toBe(0)
    expect(keywordMatchScore('查看一下桌面有哪些文件', m)).toBe(0)
    expect(keywordMatchScore('把报告.docx转成pdf', m)).toBe(0)
    // 不含禁词的正常创建输入不受影响
    expect(keywordMatchScore('帮我创建一个docx文件', m)).toBeGreaterThan(0)
  })

  it('P1-D5：无forbiddenKeywords的清单行为不变', () => {
    const m = makeManifest({ routing: { targetRoles: [], triggerKeywords: [], confidence: 0.9, keywords: ['创建', '文件'], retrievalSummary: '创建文件', userSummary: '创建文件' } })
    expect(keywordMatchScore('帮我生成一份文件清单', m)).toBeGreaterThan(0)
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

describe('llmFallback P0-A：输入门控预过滤', () => {
  function makeItem(id: string, name: string, desc: string, source: 'l2' | 'mcp', manifest?: L2ToolManifest): MatchableItem {
    return { id, name, description: desc, keywords: [], userSummary: desc, source, manifest }
  }

  function makeFileManifest(id: string, inputType: 'file' | 'text' | 'file_or_text'): L2ToolManifest {
    return {
      identity: { id, name: id, version: '1', author: 'official', createdAt: 0, updatedAt: 0, templateId: '' },
      visual: { baseColor: '', ringStyle: 'solid', badges: [], hoverLabel: '', anchorGlow: '', upgradeGlow: '' },
      routing: { keywords: [], targetRoles: [], requiredL1: [], inputType, retrievalSummary: '', userSummary: '', confidenceThreshold: 0.5 },
      execution: { mode: 'macro', paramMapping: { slots: [], bindings: [] } },
      cacheMeta: { estimatedTokenSaving: 0, avgExecutionTime: 0, cacheable: false }
    }
  }

  it('file 候选无文件输入 → 确定性过滤后无候选，不调 LLM 直接 null', async () => {
    const candidates = [
      { item: makeItem('l2a', '文件解读', '解读文件', 'l2', makeFileManifest('l2a', 'file')), score: 0.5, method: 'keyword' },
      { item: makeItem('l2b', '财报解读', '解读财报', 'l2', makeFileManifest('l2b', 'file')), score: 0.4, method: 'keyword' }
    ]
    const mockChat = vi.fn()
    const result = await llmFallback('帮我看看这段文字说了什么大概意思呢', candidates, mockChat)
    expect(result).toBeNull()
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('混合候选：file 候选被过滤、剩单个 text 候选 → 直接返回幸存者，不调 LLM', async () => {
    const textItem = makeItem('l2t', '周报生成', '生成周报', 'l2', makeFileManifest('l2t', 'text'))
    const candidates = [
      { item: makeItem('l2a', '文件解读', '解读文件', 'l2', makeFileManifest('l2a', 'file')), score: 0.5, method: 'keyword' },
      { item: textItem, score: 0.4, method: 'keyword' }
    ]
    const mockChat = vi.fn()
    const result = await llmFallback('帮我看看这段文字说了什么大概意思呢', candidates, mockChat)
    expect(result).toBe(textItem)
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('有文件路径时 file 候选不被过滤', async () => {
    const fileItem = makeItem('l2a', '文件解读', '解读文件', 'l2', makeFileManifest('l2a', 'file'))
    const textItem = makeItem('l2t', '周报生成', '生成周报', 'l2', makeFileManifest('l2t', 'text'))
    const candidates = [
      { item: fileItem, score: 0.5, method: 'keyword' },
      { item: textItem, score: 0.4, method: 'keyword' }
    ]
    const mockChat = vi.fn(() => Promise.resolve({ content: '1' }))
    const result = await llmFallback('帮我解读 C:\\temp\\报告.docx 的内容', candidates, mockChat)
    expect(result).toBe(fileItem)
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('LLM 返回 0（无匹配）→ null', async () => {
    const candidates = [
      { item: makeItem('tool1', '工具1', '描述1', 'mcp'), score: 0.5, method: 'vector' },
      { item: makeItem('tool2', '工具2', '描述2', 'mcp'), score: 0.4, method: 'vector' }
    ]
    const mockChat = vi.fn(() => Promise.resolve({ content: '0' }))
    const result = await llmFallback('测试', candidates, mockChat)
    expect(result).toBeNull()
  })

  it('提示词披露输入形态与候选 inputType，且含 0 选项', async () => {
    const candidates = [
      { item: makeItem('l2a', '文件解读', '解读文件', 'l2', makeFileManifest('l2a', 'file')), score: 0.5, method: 'keyword' },
      { item: makeItem('tool2', '工具2', '描述2', 'mcp'), score: 0.4, method: 'keyword' }
    ]
    const mockChat = vi.fn(() => Promise.resolve({ content: '1' }))
    await llmFallback('帮我解读 C:\\temp\\报告.docx 的内容看看', candidates, mockChat)
    expect(mockChat).toHaveBeenCalledTimes(1)
    const messages = mockChat.mock.calls[0][0] as { role: string; content: string }[]
    const prompt = String(messages[1].content)
    expect(prompt).toContain('用户输入形态')
    expect(prompt).toContain('需要文件输入')
    expect(prompt).toContain('0-2')
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
