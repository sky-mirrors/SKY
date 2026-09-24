import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vault } from '@/vault'
import { globalBus } from '@/kernel/bus'

const mockLLM = {
  chatCompletion: vi.fn(),
  chatCompletionStream: vi.fn(),
  listModels: vi.fn().mockResolvedValue([])
}

vi.mock('@/kernel/plugins/llm', () => ({
  getLLM: vi.fn(() => mockLLM)
}))

vi.mock('@/stores/debugStore', () => ({
  useDebugStore: () => ({ emitEvent: vi.fn() })
}))

import { shouldValidate, buildActionManifest, dualEngineValidate, isPathUnsafe, isUrlUnsafe } from '@/services/dualEngineValidator'
import { getValidationCacheKey, lookupValidationCache, saveValidationCache } from '@/services/scheduleOptimizer'

describe('dualEngineValidator', () => {
  beforeEach(() => {
    vault.clearCache()
    mockLLM.chatCompletion.mockReset()
    vi.stubGlobal('window', {
      electronAPI: {
        vaultRead: vi.fn().mockResolvedValue(null),
        vaultWrite: vi.fn().mockResolvedValue(undefined),
        vaultDelete: vi.fn().mockResolvedValue(undefined),
        vaultList: vi.fn().mockResolvedValue([])
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    globalBus.clear()
  })

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

    it('file_write → 需要验证', () => {
      expect(shouldValidate({ tool: 'file_write', params: { path: '/home/user/doc.txt', content: 'hello' } })).toBe(true)
    })

    it('http_request → 需要验证', () => {
      expect(shouldValidate({ tool: 'http_request', params: { url: 'https://api.example.com/data' } })).toBe(true)
    })

    // G-6（2026-09-24）契约变更：读类不再无差别审计——审核 prompt 看不到文件内容，
    // 对一次本地读近乎纯开销。改为只有**敏感路径**才审（fail-closed 方向不放松）。
    it('read_file + 普通路径 → 不需要验证（G-6 收窄）', () => {
      expect(shouldValidate({ tool: 'read_file', params: { path: '/home/user/doc.txt' } })).toBe(false)
    })

    it('read_file + 敏感路径 → 需要验证（收窄不放松 fail-closed）', () => {
      expect(shouldValidate({ tool: 'read_file', params: { path: '/etc/passwd' } })).toBe(true)
    })

    it('非验证工具 → 不需要验证', () => {
      expect(shouldValidate({ tool: 'llm_generate', params: { prompt: '写一段代码' } })).toBe(false)
    })

    it('search_knowledge → 不需要验证', () => {
      expect(shouldValidate({ tool: 'search_knowledge', params: { query: '民法典' } })).toBe(false)
    })

    it('shell_exec 无参数 → 不需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec' })).toBe(false)
    })

    it('P1-19: shell_exec + cat 敏感路径 → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'cat /etc/passwd' } })).toBe(true)
    })

    it('P1-19: shell_exec + type Windows 系统文件 → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'type C:\\Windows\\system.ini' } })).toBe(true)
    })

    it('P1-19: shell_exec + curl 内网地址 → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'curl http://169.254.169.254/latest/meta-data/' } })).toBe(true)
    })

    it('P1-19: shell_exec + curl localhost → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'curl http://localhost:8080/admin' } })).toBe(true)
    })

    it('P1-19: shell_exec + file:// 协议 → 需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'cat file:///etc/shadow' } })).toBe(true)
    })

    it('P1-19: shell_exec + 普通绝对路径读 → 不需要验证', () => {
      expect(shouldValidate({ tool: 'shell_exec', params: { command: 'cat /home/user/notes.txt' } })).toBe(false)
    })
  })

  describe('isPathUnsafe', () => {
    it('C:\\Windows 路径不安全', () => {
      expect(isPathUnsafe('C:\\Windows\\system.ini')).toBe(true)
    })

    it('C:\\System32 路径不安全', () => {
      expect(isPathUnsafe('C:\\System32\\config')).toBe(true)
    })

    it('/etc/passwd 不安全', () => {
      expect(isPathUnsafe('/etc/passwd')).toBe(true)
    })

    it('路径穿越 .. 不安全', () => {
      expect(isPathUnsafe('../../../etc/passwd')).toBe(true)
    })

    it('/home/user/doc.txt 安全', () => {
      expect(isPathUnsafe('/home/user/doc.txt')).toBe(false)
    })

    it('普通相对路径安全', () => {
      expect(isPathUnsafe('output/result.txt')).toBe(false)
    })
  })

  describe('isUrlUnsafe', () => {
    it('localhost 不安全', () => {
      expect(isUrlUnsafe('http://localhost:8080/api')).toBe(true)
    })

    it('127.0.0.1 不安全', () => {
      expect(isUrlUnsafe('http://127.0.0.1/admin')).toBe(true)
    })

    it('云元数据 169.254.169.254 不安全', () => {
      expect(isUrlUnsafe('http://169.254.169.254/latest/meta-data/')).toBe(true)
    })

    it('file:// 协议不安全', () => {
      expect(isUrlUnsafe('file:///etc/passwd')).toBe(true)
    })

    it('https://api.example.com 安全', () => {
      expect(isUrlUnsafe('https://api.example.com/data')).toBe(false)
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

    it('file_write 安全路径 → operation=文件写入', () => {
      const m = buildActionManifest('test', {
        tool: 'file_write',
        params: { path: '/home/user/output.txt', content: 'hello' }
      }, '写文件')
      expect(m.operation).toBe('文件写入')
      expect(m.target_file).toBe('/home/user/output.txt')
      expect(m.isHighRisk).toBe(false)
    })

    it('file_write 危险路径 → operation=危险路径文件写入', () => {
      const m = buildActionManifest('test', {
        tool: 'file_write',
        params: { path: 'C:\\Windows\\hack.dll', content: 'bad' }
      }, '写系统文件')
      expect(m.operation).toBe('危险路径文件写入')
      expect(m.isHighRisk).toBe(true)
    })

    it('http_request 安全URL → operation=HTTP请求', () => {
      const m = buildActionManifest('test', {
        tool: 'http_request',
        params: { url: 'https://api.example.com/data' }
      }, '请求数据')
      expect(m.operation).toBe('HTTP请求')
      expect(m.isHighRisk).toBe(false)
    })

    it('http_request 危险URL → operation=危险URL请求', () => {
      const m = buildActionManifest('test', {
        tool: 'http_request',
        params: { url: 'http://169.254.169.254/latest/meta-data/' }
      }, '请求元数据')
      expect(m.operation).toBe('危险URL请求')
      expect(m.isHighRisk).toBe(true)
    })

    it('read_file 危险路径 → operation=危险路径文件读取', () => {
      const m = buildActionManifest('test', {
        tool: 'read_file',
        params: { path: '/etc/shadow' }
      }, '读密码文件')
      expect(m.operation).toBe('危险路径文件读取')
      expect(m.isHighRisk).toBe(true)
    })

    it('read_file 安全路径 → operation=文件读取', () => {
      const m = buildActionManifest('test', {
        tool: 'read_file',
        params: { path: '/home/user/notes.txt' }
      }, '读笔记')
      expect(m.operation).toBe('文件读取')
      expect(m.isHighRisk).toBe(false)
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

    it('node -e 混合引号(外双内单含转义单引号) → extractTargetFile仍提取路径', () => {
      const m = buildActionManifest('test', {
        tool: 'shell_exec',
        params: { command: "node -e \"require('fs').writeFileSync('C:/Users/test\\\\doc.txt','x')\"" }
      }, '写文件')
      expect(m.target_file).toBe('C:/Users/test\\\\doc.txt')
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

    it('危险路径文件写入 → 直接返回high', async () => {
      const result = await dualEngineValidate({
        skill_id: 'test',
        target_file: 'C:\\Windows\\hack.dll',
        operation: '危险路径文件写入',
        expected_output: '写入',
        intent: '写系统文件',
        isHighRisk: true
      }, '写系统文件')
      expect(result.risk_level).toBe('high')
      expect(result.parameter_sane).toBe(false)
      expect(result.reason).toContain('危险路径')
    })

    it('危险URL请求 → 直接返回high', async () => {
      const result = await dualEngineValidate({
        skill_id: 'test',
        target_file: 'http://169.254.169.254/latest/meta-data/',
        operation: '危险URL请求',
        expected_output: '请求',
        intent: '请求元数据',
        isHighRisk: true
      }, '请求元数据')
      expect(result.risk_level).toBe('high')
      expect(result.reason).toContain('危险URL')
    })

    it('危险路径文件读取 → 直接返回high', async () => {
      const result = await dualEngineValidate({
        skill_id: 'test',
        target_file: '/etc/shadow',
        operation: '危险路径文件读取',
        expected_output: '读取',
        intent: '读密码文件',
        isHighRisk: true
      }, '读密码文件')
      expect(result.risk_level).toBe('high')
      expect(result.reason).toContain('危险路径')
    })

    it('高风险结果会缓存', async () => {
      const key = getValidationCacheKey('test', '/tmp/old', 'rm -rf /tmp/old', '删除')
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
      const key = getValidationCacheKey('test-skill', 'test.txt', '文件写入', '创建测试文件')
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

    it('P1-18: 相同动作不同用户输入不共享缓存', async () => {
      const first: any = { intent_match: true, parameter_sane: true, risk_level: 'low' }
      saveValidationCache(getValidationCacheKey('skill-a', 'a.txt', '文件写入', '备份这个文件'), first)
      const miss = lookupValidationCache(getValidationCacheKey('skill-a', 'a.txt', '文件写入', '删掉这个文件'))
      expect(miss).toBeNull()
    })

    it('P1-18: 缓存键包含 userInput 指纹分量', () => {
      const withInput = getValidationCacheKey('skill', 'a.txt', '文件写入', '读一下内容')
      const withoutInput = getValidationCacheKey('skill', 'a.txt', '文件写入')
      expect(withInput).not.toBe(withoutInput)
      expect(withInput.startsWith('skill|a.txt|文件写入|')).toBe(true)
    })
  })

  describe('dualEngineValidate - LLM审核', () => {
    it('LLM返回全通过 → risk_level=low', async () => {
      mockLLM.chatCompletion.mockResolvedValueOnce({
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
      mockLLM.chatCompletion.mockResolvedValueOnce({
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
      mockLLM.chatCompletion.mockResolvedValueOnce({
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
      mockLLM.chatCompletion.mockResolvedValueOnce({
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
      mockLLM.chatCompletion.mockRejectedValueOnce(new Error('API down'))
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

    it('LLM返回缺少intent_match字段 → fail-closed默认false', async () => {
      mockLLM.chatCompletion.mockResolvedValueOnce({
        content: '{"parameter_sane":true,"risk_level":"low"}'
      })
      const result = await dualEngineValidate({
        skill_id: 'missing-fields-skill',
        target_file: 'missing.txt',
        operation: '文件写入',
        expected_output: '写入',
        intent: '创建文件'
      }, '创建文件')
      expect(result.intent_match).toBe(false)
      expect(result.parameter_sane).toBe(true)
    })

    it('LLM返回缺少risk_level字段 → fail-closed默认medium', async () => {
      mockLLM.chatCompletion.mockResolvedValueOnce({
        content: '{"intent_match":true,"parameter_sane":true}'
      })
      const result = await dualEngineValidate({
        skill_id: 'no-risk-skill',
        target_file: 'norisk.txt',
        operation: '文件写入',
        expected_output: '写入',
        intent: '创建文件'
      }, '创建文件')
      expect(result.risk_level).toBe('medium')
    })

    it('LLM返回risk_level=invalid → fail-closed默认medium', async () => {
      mockLLM.chatCompletion.mockResolvedValueOnce({
        content: '{"intent_match":true,"parameter_sane":true,"risk_level":"critical"}'
      })
      const result = await dualEngineValidate({
        skill_id: 'invalid-risk-skill',
        target_file: 'invalid.txt',
        operation: '文件写入',
        expected_output: '写入',
        intent: '创建文件'
      }, '创建文件')
      expect(result.risk_level).toBe('medium')
    })
  })
})
