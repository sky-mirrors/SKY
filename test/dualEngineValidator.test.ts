import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/stores/debugStore', () => ({
  useDebugStore: () => ({ emitEvent: vi.fn() })
}))

vi.mock('@/stores/apiStore', () => ({
  useApiStore: vi.fn().mockReturnValue({
    chatCompletion: vi.fn()
  })
}))

import { shouldValidate, buildActionManifest, dualEngineValidate } from '@/services/dualEngineValidator'
import { getValidationCacheKey, lookupValidationCache, saveValidationCache } from '@/services/scheduleOptimizer'

describe('dualEngineValidator', () => {
  describe('shouldValidate', () => {
    it('shell_exec + 写操作 → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'node -e "require(\'fs\').writeFileSync(\'a.txt\',\'x\')"' } })).toBe(true)
    })

    it('shell_exec + mkdir → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'mkdir newdir' } })).toBe(true)
    })

    it('shell_exec + 读操作 → 不需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'cat file.txt' } })).toBe(false)
    })

    it('shell_exec + ls → 不需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'ls -la' } })).toBe(false)
    })

    it('非 shell_exec 工具 → 不需要验证', () => {
      expect(shouldValidate({ tool: 'llm_generate', params: { prompt: '写一段代码' } })).toBe(false)
    })

    it('shell_exec 无参数 → 不需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec' })).toBe(false)
    })
  })

  describe('buildActionManifest', () => {
    it('writeFileSync 命令 → operation=文件写入', () => {
      const m = buildActionManifest('l2-file-creator-v1', {
        tool: 'shell_exec',
        params: { command: 'node -e "require(\'fs\').writeFileSync(\'test.txt\',\'hello\')"' }
      }, '创建一个测试文件')
      expect(m.skill_id).toBe('l2-file-creator-v1')
      expect(m.operation).toBe('文件写入')
      expect(m.intent).toBe('创建一个测试文件')
    })

    it('rm 命令标记为高风险', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: 'rm -rf /tmp/old' }
      }, '删除旧文件')
      expect(m.operation).toBe('高风险删除/覆盖')
    })

    it('无目标文件时返回 (未知)', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: 'echo hello' }
      }, '测试')
      expect(m.target_file).toBe('(未知)')
    })

    it('node -e 嵌套引号命令 → extractTargetFile 提取writeFileSync路径', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: 'node -e "require(\'fs\').writeFileSync(\'C:/Users/test/doc.txt\',\'x\')"' }
      }, '写文件')
      expect(m.target_file).toBe('C:/Users/test/doc.txt')
    })

    it('writeFile嵌套引号 → 提取路径', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: 'node -e "require(\'fs\').writeFile(\'output.txt\',\'data\',()=>{})"' }
      }, '写文件')
      expect(m.target_file).toBe('output.txt')
    })

    it('node -e 转义双引号命令 → extractTargetFile 提取writeFileSync路径', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: 'node -e "require(\\"fs\\").writeFileSync(\\"C:\\\\Users\\\\test\\\\doc.txt\\",\\"x\\")"' }
      }, '写文件')
      expect(m.target_file).toBe('C:\\\\Users\\\\test\\\\doc.txt')
    })

    it('mkdir 简单命令 → 目标(未知)', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: 'mkdir newdir' }
      }, '建目录')
      expect(m.operation).toBe('文件写入')
    })
  })

  describe('dualEngineValidate - 高风险命令短路', () => {
    it('operation含rm → 直接返回 risk_level=high', async () => {
      const result = await dualEngineValidate({
        skill_id: 'test',
        target_file: '/tmp/old',
        operation: 'rm -rf /tmp/old',
        expected_output: '删除目录',
        intent: '删除临时目录',
        isHighRisk: true
      }, '删除临时目录')
      expect(result.risk_level).toBe('high')
      expect(result.intent_match).toBe(true)
      expect(result.reason).toContain('删除')
    })

    it('operation含unlinkSync → 直接返回high', async () => {
      const result = await dualEngineValidate({
        skill_id: 'test',
        target_file: '/tmp/file',
        operation: 'unlinkSync /tmp/file',
        expected_output: '删除文件',
        intent: '删除文件',
        isHighRisk: true
      }, '删除文件')
      expect(result.risk_level).toBe('high')
    })

    it('高风险结果会缓存', async () => {
      const key = getValidationCacheKey('test', '/tmp/old', 'rm -rf /tmp/old')
      await dualEngineValidate({
        skill_id: 'test',
        target_file: '/tmp/old',
        operation: 'rm -rf /tmp/old',
        expected_output: '删除',
        intent: '删除',
        isHighRisk: true
      }, '删除')
      const cached = lookupValidationCache(key)
      expect(cached).not.toBeNull()
      expect(cached!.risk_level).toBe('high')
    })
  })

  describe('dualEngineValidate - 缓存命中', () => {
    it('已缓存结果直接返回', async () => {
      const cached: any = { intent_match: true, parameter_sane: true, risk_level: 'low' }
      const key = getValidationCacheKey('test-skill', 'test.txt', '文件写入')
      saveValidationCache(key, cached)
      const result = await dualEngineValidate({
        skill_id: 'test-skill',
        target_file: 'test.txt',
        operation: '文件写入',
        expected_output: '写入文件',
        intent: '创建测试文件'
      }, '创建测试文件')
      expect(result.risk_level).toBe('low')
      expect(result.from_cache).toBe(true)
    })
  })

  describe('dualEngineValidate - LLM审核', () => {
    it('LLM返回全通过 → risk_level=low', async () => {
      const { useApiStore } = await import('@/stores/apiStore')
      const store = useApiStore()
      ;(store.chatCompletion as any).mockResolvedValueOnce({
        content: '{"intent_match":true,"parameter_sane":true,"risk_level":"low"}'
      })
      const result = await dualEngineValidate({
        skill_id: 'fresh-skill',
        target_file: 'fresh.txt',
        operation: '文件写入',
        expected_output: '写文件',
        intent: '创建新文件'
      }, '创建新文件')
      expect(result.intent_match).toBe(true)
      expect(result.parameter_sane).toBe(true)
      expect(result.risk_level).toBe('low')
    })

    it('LLM返回 intent_match=false → 阻断', async () => {
      const { useApiStore } = await import('@/stores/apiStore')
      const store = useApiStore()
      ;(store.chatCompletion as any).mockResolvedValueOnce({
        content: '{"intent_match":false,"parameter_sane":true,"risk_level":"medium","reason":"意图不匹配"}'
      })
      const result = await dualEngineValidate({
        skill_id: 'intent-mismatch-skill',
        target_file: 'mismatch.txt',
        operation: '文件写入',
        expected_output: '写入',
        intent: '用户想删除但工具要写入'
      }, '删除这个文件')
      expect(result.intent_match).toBe(false)
      expect(result.reason).toContain('意图不匹配')
    })

    it('LLM返回 risk_level=high → 阻断', async () => {
      const { useApiStore } = await import('@/stores/apiStore')
      const store = useApiStore()
      ;(store.chatCompletion as any).mockResolvedValueOnce({
        content: '{"intent_match":true,"parameter_sane":true,"risk_level":"high","reason":"目标为系统目录"}'
      })
      const result = await dualEngineValidate({
        skill_id: 'high-risk-skill',
        target_file: 'C:/Windows/System32/test.txt',
        operation: '文件写入',
        expected_output: '写入系统目录',
        intent: '修改系统文件'
      }, '修改系统文件')
      expect(result.risk_level).toBe('high')
    })

    it('LLM返回无法解析 → 安全策略阻断(fail-closed)', async () => {
      const { useApiStore } = await import('@/stores/apiStore')
      const store = useApiStore()
      ;(store.chatCompletion as any).mockResolvedValueOnce({
        content: '审核结果：看起来安全'
      })
      const result = await dualEngineValidate({
        skill_id: 'unparseable-skill',
        target_file: 'unparseable.txt',
        operation: '文件写入',
        expected_output: '写入',
        intent: '创建文件'
      }, '创建文件')
      expect(result.intent_match).toBe(false)
      expect(result.parameter_sane).toBe(false)
      expect(result.risk_level).toBe('medium')
      expect(result.reason).toContain('无法解析')
    })

    it('LLM调用失败 → 安全策略阻断(fail-closed)', async () => {
      const { useApiStore } = await import('@/stores/apiStore')
      const store = useApiStore()
      ;(store.chatCompletion as any).mockRejectedValueOnce(new Error('API down'))
      const result = await dualEngineValidate({
        skill_id: 'api-down-skill',
        target_file: 'down.txt',
        operation: '文件写入',
        expected_output: '写入',
        intent: '创建文件'
      }, '创建文件')
      expect(result.intent_match).toBe(false)
      expect(result.parameter_sane).toBe(false)
      expect(result.risk_level).toBe('medium')
      expect(result.reason).toContain('调用失败')
    })
  })
})
