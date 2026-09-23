import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'

const mockDebugStore = {
  enabled: false,
  emitEvent: vi.fn(),
  recordProbe: vi.fn(),
  registerAbortController: vi.fn(),
  clearAbortController: vi.fn()
}

const mockDialogStore = {
  dagPaused: false,
  dagPausedStep: null as number | null,
  awaitingTakeover: false,
  takeoverStepNum: null as number | null,
  addSystemNotice: vi.fn(),
  requestRiskConfirm: vi.fn().mockResolvedValue(true),
  requestTakeover: vi.fn().mockResolvedValue('takeover-result'),
  clearAllPausePoints: vi.fn(),
  awaitingRiskConfirm: false,
  riskAction: null
}

const mockFeedbackStore = {
  addSideEffectManifest: vi.fn(),
  recordFeedback: vi.fn(),
  getWeightModifier: vi.fn().mockReturnValue(0)
}

vi.mock('@/stores/debugStore', () => ({
  useDebugStore: vi.fn(() => mockDebugStore)
}))

vi.mock('@/stores/dialogStore', () => ({
  useDialogStore: vi.fn(() => mockDialogStore)
}))

vi.mock('@/stores/feedbackStore', () => ({
  useFeedbackStore: vi.fn(() => mockFeedbackStore),
  computeQueryFingerprint: vi.fn().mockReturnValue('mock-fingerprint')
}))

vi.mock('@/services/dualEngineValidator', () => ({
  shouldValidate: vi.fn().mockReturnValue(false),
  buildActionManifest: vi.fn().mockReturnValue({ skill_id: 'test', target_file: 'test.txt', operation: '文件写入', expected_output: '', intent: '' }),
  dualEngineValidate: vi.fn().mockResolvedValue({ intent_match: true, parameter_sane: true, risk_level: 'low' })
}))

vi.mock('@/services/errorClassifier', () => ({
  classifyError: vi.fn().mockResolvedValue({ category: 'unknown', action: 'abort', fixHint: '' })
}))

vi.mock('@/services/factGuard', () => ({
  extractEntities: vi.fn().mockReturnValue([]),
  shouldTrigger: vi.fn().mockReturnValue(false),
  runFactGuard: vi.fn().mockReturnValue({ ok: true, conflicts: [], hallucinatedEntities: [], severity: 'ok', correctedOutput: null, summary: 'ok' }),
  runFactGuardV2: vi.fn().mockReturnValue({ ok: true, conflicts: [], hallucinatedEntities: [], severity: 'ok', correctedOutput: null, summary: 'ok', layer1Entities: [], layer2ConstraintResults: [], layer3CrossDocResults: [], allConstraintResults: [] })
}))

vi.mock('@/services/ruleEngine', () => ({
  runRuleEngine: vi.fn().mockReturnValue({ matched: false, output: '' }),
  buildRuleContext: vi.fn().mockReturnValue({})
}))

vi.mock('@/services/dagCheckpoint', () => ({
  saveCheckpoint: vi.fn(),
  removeCheckpoint: vi.fn(),
  getCheckpoint: vi.fn().mockResolvedValue(null),
  createCheckpointId: vi.fn().mockReturnValue('cp-mock')
}))

vi.mock('@/services/knowledgeBase', () => ({
  searchKnowledge: vi.fn().mockResolvedValue(['知识1', '知识2'])
}))

vi.mock('@/services/secureStore', () => ({
  storeGet: vi.fn().mockResolvedValue(null),
  storeSet: vi.fn().mockResolvedValue(undefined)
}))

import {
  callToolDirectWithTier,
  executeStep,
  executeMacro,
  resolveDirectPrompt,
  formatLineage,
  computeLineageSavings,
  evaluateCondition,
  resolveParams,
  extractStepResult
} from '@/services/macroExecutor'

import { L2ToolManifest, L2DagStep } from '@/models'

const originalWindow = globalThis.window

let llmChatCompletionFn: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vault.clearCache()
  mockDebugStore.enabled = false

  llmChatCompletionFn = vi.fn().mockResolvedValue({ content: 'mocked-llm-response', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } })

  const shellExecFn = vi.fn().mockResolvedValue({ success: true, stdout: 'shell-output', stderr: '', code: 0 })
  const fileReadFn = vi.fn().mockResolvedValue({ success: true, content: 'file-content', size: 100, isBinary: false, encoding: 'utf-8' })
  const httpFetchFn = vi.fn().mockResolvedValue({ success: true, status: 200, body: 'http-body' })
  const fileWriteFn = vi.fn().mockResolvedValue({ success: true, path: 'C:\\Users\\Test\\Desktop\\out.txt' })
  const createDocxFn = vi.fn().mockResolvedValue({ success: true, path: 'C:\\Users\\Test\\Desktop\\out.docx' })

  ;(globalThis as any).window = {
    electronAPI: {
      shellExec: shellExecFn,
      fileRead: fileReadFn,
      httpFetch: httpFetchFn,
      fileWrite: fileWriteFn,
      createDocx: createDocxFn,
      vaultRead: vi.fn().mockResolvedValue(null),
      vaultWrite: vi.fn().mockResolvedValue(undefined),
      vaultDelete: vi.fn().mockResolvedValue(undefined),
      vaultList: vi.fn().mockResolvedValue([])
    }
  }
  ;(globalThis as any).process = { env: { USERPROFILE: 'C:\\Users\\Test', HOME: '/home/test', APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' } }

  globalBus.registerHandler('debug:get-step-cost', () => undefined)
  globalBus.on('debug:log-probe', () => {})
  globalBus.on('debug:register-abort', () => {})
  globalBus.on('debug:clear-abort', () => {})
  globalBus.registerHandler('api:chat-completion', (data: any) => llmChatCompletionFn(data))
  globalBus.registerHandler('mcp:get-connections', () => [{ id: 'test-server', name: 'Test Server', isConnected: true, tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }], config: {}, status: 'connected' }])
  globalBus.registerHandler('mcp:call-tool', () => 'mcp-tool-result')
  globalBus.registerHandler('dialog:confirm-risk', () => true)
})

afterEach(() => {
  ;(globalThis as any).window = originalWindow
  globalBus.clear()
})

describe('callToolDirectWithTier - shell_exec', () => {
  it('调用shellExec并返回stdout', async () => {
    const result = await callToolDirectWithTier('shell_exec', { command: 'echo hello' })
    expect(result).toContain('shell-output')
    expect((globalThis as any).window.electronAPI.shellExec).toHaveBeenCalled()
  })

  it('USER_INPUT环境变量被正确注入', async () => {
    await callToolDirectWithTier(
      'shell_exec', { command: 'echo test' },
      undefined, undefined, undefined, { 1: 'step1-result' },
      { inputText: '用户原始输入' }
    )
    const callArgs = (globalThis as any).window.electronAPI.shellExec.mock.calls[0][0]
    expect(callArgs.env.USER_INPUT).toBe('用户原始输入')
  })

  it('stepResults注入为STEP_N_RESULT环境变量', async () => {
    await callToolDirectWithTier(
      'shell_exec', { command: 'echo test' },
      undefined, undefined, undefined, { 1: '分析结果', 2: '总结内容' },
      { inputText: 'input' }
    )
    const callArgs = (globalThis as any).window.electronAPI.shellExec.mock.calls[0][0]
    expect(callArgs.env.STEP_1_RESULT).toBe('分析结果')
    expect(callArgs.env.STEP_2_RESULT).toBe('总结内容')
    expect(callArgs.env.ANALYSIS).toBe('总结内容')
  })

  it('ANALYSIS取最后一个stepResult', async () => {
    await callToolDirectWithTier(
      'shell_exec', { command: 'echo test' },
      undefined, undefined, undefined, { 5: '较早步骤', 10: '最新步骤' },
      { inputText: 'input' }
    )
    const callArgs = (globalThis as any).window.electronAPI.shellExec.mock.calls[0][0]
    expect(callArgs.env.ANALYSIS).toBe('最新步骤')
  })

  it('shell执行失败返回错误信息', async () => {
    ;(globalThis as any).window.electronAPI.shellExec.mockResolvedValueOnce({
      success: false, stdout: '', stderr: 'Error: command not found', code: 127
    })
    const result = await callToolDirectWithTier('shell_exec', { command: 'badcommand' })
    expect(result).toContain('exit code 127')
    expect(result).toContain('command not found')
  })

  it('无electronAPI时抛出异常', async () => {
    ;(globalThis as any).window.electronAPI = null
    await expect(callToolDirectWithTier('shell_exec', { command: 'echo test' }))
      .rejects.toThrow('shell_exec not available')
  })

  it('USER_INPUT截断至8000字符', async () => {
    const longInput = 'x'.repeat(10000)
    await callToolDirectWithTier(
      'shell_exec', { command: 'echo test' },
      undefined, undefined, undefined, {},
      { inputText: longInput }
    )
    const callArgs = (globalThis as any).window.electronAPI.shellExec.mock.calls[0][0]
    expect(callArgs.env.USER_INPUT.length).toBe(8000)
  })
})

describe('callToolDirectWithTier - read_file', () => {
  it('调用fileRead并返回文件内容', async () => {
    const result = await callToolDirectWithTier('read_file', { path: '/tmp/test.txt' })
    expect(result).toContain('file-content')
    expect((globalThis as any).window.electronAPI.fileRead).toHaveBeenCalledWith('/tmp/test.txt', 200000)
  })

  it('file_path参数也能用', async () => {
    const result = await callToolDirectWithTier('read_file', { file_path: '/tmp/doc.txt' })
    expect(result).toContain('file-content')
  })

  it('缺少path参数抛出异常', async () => {
    await expect(callToolDirectWithTier('read_file', {}))
      .rejects.toThrow('missing path')
  })

  it('文件读取失败抛出异常', async () => {
    ;(globalThis as any).window.electronAPI.fileRead.mockResolvedValueOnce({
      success: false, error: 'File not found'
    })
    await expect(callToolDirectWithTier('read_file', { path: '/missing.txt' }))
      .rejects.toThrow('File not found')
  })

  it('二进制文件返回不带header', async () => {
    ;(globalThis as any).window.electronAPI.fileRead.mockResolvedValueOnce({
      success: true, content: 'binary-data', size: 1024, isBinary: true
    })
    const result = await callToolDirectWithTier('read_file', { path: '/img.png' })
    expect(result).not.toContain('[文件:')
    expect(result).toBe('binary-data')
  })

  it('文本文件返回带header', async () => {
    ;(globalThis as any).window.electronAPI.fileRead.mockResolvedValueOnce({
      success: true, content: 'hello world', size: 11, isBinary: false, encoding: 'utf-8'
    })
    const result = await callToolDirectWithTier('read_file', { path: '/test.txt' })
    expect(result).toContain('[文件: /test.txt')
  })
})

describe('callToolDirectWithTier - http_request', () => {
  it('调用httpFetch并返回响应', async () => {
    const result = await callToolDirectWithTier('http_request', { url: 'https://api.example.com', method: 'GET' })
    expect(result).toContain('HTTP 200')
    expect(result).toContain('http-body')
  })

  it('缺少url抛出异常', async () => {
    await expect(callToolDirectWithTier('http_request', {}))
      .rejects.toThrow('missing url')
  })

  it('http请求失败抛出异常', async () => {
    ;(globalThis as any).window.electronAPI.httpFetch.mockResolvedValueOnce({
      success: false, error: 'Connection refused', status: 0
    })
    await expect(callToolDirectWithTier('http_request', { url: 'http://fail.com' }))
      .rejects.toThrow()
  })

  it('默认method为GET', async () => {
    await callToolDirectWithTier('http_request', { url: 'https://api.example.com' })
    const callArgs = (globalThis as any).window.electronAPI.httpFetch.mock.calls[0][0]
    expect(callArgs.method).toBe('GET')
  })

  it('无electronAPI时抛出异常', async () => {
    ;(globalThis as any).window.electronAPI = null
    await expect(callToolDirectWithTier('http_request', { url: 'https://test.com' }))
      .rejects.toThrow('http_request not available')
  })
})

describe('callToolDirectWithTier - llm_generate', () => {
  it('调用chatCompletion bus并返回结果', async () => {
    llmChatCompletionFn.mockResolvedValueOnce({
      content: 'LLM分析结果', toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    })
    const result = await callToolDirectWithTier('llm_generate', { prompt: '分析这个' }, 'standard')
    expect(result).toBe('LLM分析结果')
  })

  it('缺少prompt抛出异常', async () => {
    await expect(callToolDirectWithTier('llm_generate', {}, 'standard'))
      .rejects.toThrow('missing prompt')
  })

  it('tier降级: standard→mini→nano→失败', async () => {
    llmChatCompletionFn
      .mockRejectedValueOnce(new Error('API error at standard'))
      .mockRejectedValueOnce(new Error('API error at mini'))
      .mockRejectedValueOnce(new Error('API error at nano'))

    await expect(callToolDirectWithTier('llm_generate', { prompt: 'test' }, 'standard'))
      .rejects.toThrow()
    expect(llmChatCompletionFn).toHaveBeenCalledTimes(3)
  })

  it('tier降级standard→mini成功', async () => {
    llmChatCompletionFn
      .mockRejectedValueOnce(new Error('standard failed'))
      .mockResolvedValueOnce({ content: 'mini-success', toolCalls: [] })

    const result = await callToolDirectWithTier('llm_generate', { prompt: 'test' }, 'standard')
    expect(result).toBe('mini-success')
    expect(llmChatCompletionFn).toHaveBeenCalledTimes(2)
  })

  it('外部AbortSignal立即抛出AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(callToolDirectWithTier('llm_generate', { prompt: 'test' }, 'standard', undefined, controller.signal))
      .rejects.toThrow()
  })

  // 2026-09-23 契约变更：空正文不再立即当最终答案——推理模型可能把整份 maxTokens 花在
  // reasoning_content 上（插桩实测同一 prompt / 同一档位 / 同一预算下，contentLen 一次 359、一次 0），
  // 故 `callToolDirectWithTier` 现在会翻倍预算重试，只有**持续为空**才回落到默认文本。
  it('持续无输出（重试后仍空）才返回默认文本', async () => {
    llmChatCompletionFn.mockResolvedValue({ content: '', toolCalls: [] })
    const result = await callToolDirectWithTier('llm_generate', { prompt: 'test' }, 'standard')
    expect(result).toBe('(LLM无输出)')
  })

  it('首次空输出 ⇒ 翻倍预算重试并拿到正文（不再把空当最终答案）', async () => {
    llmChatCompletionFn.mockResolvedValueOnce({ content: '', toolCalls: [] })
    const result = await callToolDirectWithTier('llm_generate', { prompt: 'test' }, 'standard')
    expect(result).toBe('mocked-llm-response')
    expect(llmChatCompletionFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('callToolDirectWithTier - knowledge_search', () => {
  it('返回检索结果', async () => {
    const result = await callToolDirectWithTier('knowledge_search', { query: '测试查询' })
    expect(result).toContain('知识1')
    expect(result).toContain('知识2')
  })

  it('检索失败抛出异常', async () => {
    const { searchKnowledge } = await import('@/services/knowledgeBase')
    ;(searchKnowledge as any).mockRejectedValueOnce(new Error('search failed'))
    await expect(callToolDirectWithTier('knowledge_search', { query: 'fail' }))
      .rejects.toThrow('知识库检索失败')
  })

  it('空结果返回默认文本', async () => {
    const { searchKnowledge } = await import('@/services/knowledgeBase')
    ;(searchKnowledge as any).mockResolvedValueOnce([])
    const result = await callToolDirectWithTier('knowledge_search', { query: 'empty' })
    expect(result).toBe('(未检索到相关内容)')
  })
})

describe('callToolDirectWithTier - MCP tool', () => {
  it('调用mcp:call-tool bus并返回结果', async () => {
    const result = await callToolDirectWithTier('test-server___read_file', { path: '/tmp/test.txt' })
    expect(result).toBe('mcp-tool-result')
  })

  it('无效工具名(无___分隔)抛出异常', async () => {
    await expect(callToolDirectWithTier('invalid_tool_name', {}))
      .rejects.toThrow('无效工具名')
  })

  it('MCP连接未找到抛出异常', async () => {
    await expect(callToolDirectWithTier('missing-server___tool', {}))
      .rejects.toThrow('MCP连接未找到')
  })
})

describe('callToolDirectWithTier - P1-D2 空产物如实标注', () => {
  it('file_write 有内容正常返回', async () => {
    const result = await callToolDirectWithTier('file_write', { filePath: 'C:\\Users\\Test\\Desktop\\out.txt', content: '实际内容' })
    expect(result).toBe('文件已写入: C:\\Users\\Test\\Desktop\\out.txt')
    expect(result).not.toContain('⚠️')
  })

  it('file_write 空内容返回⚠️空文件标注', async () => {
    const result = await callToolDirectWithTier('file_write', { filePath: 'C:\\Users\\Test\\Desktop\\out.txt', content: '' })
    expect(result).toContain('文件已写入')
    expect(result).toContain('⚠️ 空文件')
  })

  it('file_write 纯空白内容同样标注', async () => {
    const result = await callToolDirectWithTier('file_write', { filePath: 'C:\\Users\\Test\\Desktop\\out.txt', content: '   \n  ' })
    expect(result).toContain('⚠️ 空文件')
  })

  it('create_docx 有标题正常返回', async () => {
    const result = await callToolDirectWithTier('create_docx', { filePath: 'C:\\Users\\Test\\Desktop\\out.docx', title: '标题' })
    expect(result).toBe('docx文件已创建: C:\\Users\\Test\\Desktop\\out.docx')
    expect(result).not.toContain('⚠️')
  })

  it('create_docx 无标题无内容返回⚠️空文档标注', async () => {
    const result = await callToolDirectWithTier('create_docx', { filePath: 'C:\\Users\\Test\\Desktop\\out.docx' })
    expect(result).toContain('docx文件已创建')
    expect(result).toContain('⚠️ 空文档')
  })

  it('shell_exec Desktop 产物 0 字节 → FILE_EMPTY ⚠️标注', async () => {
    const cmd = 'node -e "require(\'fs\').writeFileSync(process.env.USERPROFILE+\'\\\\Desktop\\\\新建文档.docx\',Buffer.from(\'\'))"'
    ;(globalThis as any).window.electronAPI.shellExec
      .mockResolvedValueOnce({ success: true, stdout: '文件已保存', stderr: '', code: 0 })
      .mockResolvedValueOnce({ success: true, stdout: 'FILE_EMPTY:C:\\Users\\Test\\Desktop\\新建文档.docx', stderr: '', code: 0 })
    const result = await callToolDirectWithTier('shell_exec', { command: cmd })
    expect(result).toContain('⚠️')
    expect(result).toContain('空文件')
    expect(result).toContain('新建文档.docx')
  })

  it('shell_exec Desktop 产物存在且非空 → 正常返回', async () => {
    const cmd = 'node -e "require(\'fs\').writeFileSync(process.env.USERPROFILE+\'\\\\Desktop\\\\新建文档.docx\',Buffer.from(\'x\'))"'
    ;(globalThis as any).window.electronAPI.shellExec
      .mockResolvedValueOnce({ success: true, stdout: '文件已保存', stderr: '', code: 0 })
      .mockResolvedValueOnce({ success: true, stdout: 'FILE_EXISTS:C:\\Users\\Test\\Desktop\\新建文档.docx', stderr: '', code: 0 })
    const result = await callToolDirectWithTier('shell_exec', { command: cmd })
    expect(result).toBe('文件已保存: 新建文档.docx')
  })
})

describe('evaluateCondition', () => {
  it('$.output.amount > 100 当结果包含200时返回true', () => {
    const result = evaluateCondition('$.output.amount > 100', { 1: '金额为200元' })
    expect(result).toBe(true)
  })

  it('$.output.amount > 100 当结果只含50时返回false', () => {
    const result = evaluateCondition('$.output.amount > 100', { 1: '金额为50元' })
    expect(result).toBe(false)
  })

  it('$.output.contains("错误") 匹配时返回true', () => {
    const result = evaluateCondition('$.output.contains("错误")', { 1: '执行出现错误' })
    expect(result).toBe(true)
  })

  it('$.output.contains("错误") 不匹配时返回false', () => {
    const result = evaluateCondition('$.output.contains("错误")', { 1: '执行成功' })
    expect(result).toBe(false)
  })

  it('无法识别的表达式默认返回true', () => {
    const result = evaluateCondition('some.unknown.expr', { 1: '任意内容' })
    expect(result).toBe(true)
  })
})

describe('extractStepResult', () => {
  const allSteps: L2DagStep[] = [
    { step: 1, tool: 'llm_generate', description: '分析', depends_on: [], params: { prompt: '分析' }, expectedOutput: '分析结果' },
    { step: 2, tool: 'llm_generate', description: '总结', depends_on: [1], params: { prompt: '总结' }, expectedOutput: '总结', outputExtract: '$.summary', modelTier: 'mini' as any }
  ]

  it('无outputExtract时按tier截断(nano=300)', () => {
    const consumer: L2DagStep = { step: 2, tool: 'llm_generate', description: '消费', depends_on: [1], params: {}, expectedOutput: '', modelTier: 'nano' as any }
    const result = extractStepResult('很长的内容'.repeat(100), consumer, 1, allSteps)
    expect(result.length).toBeLessThanOrEqual(300)
  })

  it('无outputExtract时standard截断800', () => {
    const consumer: L2DagStep = { step: 2, tool: 'llm_generate', description: '消费', depends_on: [1], params: {}, expectedOutput: '', modelTier: 'standard' as any }
    const result = extractStepResult('x'.repeat(1000), consumer, 1, allSteps)
    expect(result.length).toBeLessThanOrEqual(800)
  })

  it('outputExtract提取JSON路径', () => {
    const consumer: L2DagStep = { step: 2, tool: 'llm_generate', description: '消费', depends_on: [1], params: {}, expectedOutput: '', outputExtract: '$.summary' }
    const sourceResult = JSON.stringify({ summary: '这是摘要', detail: '这是详情' })
    const result = extractStepResult(sourceResult, consumer, 1, [{ step: 1, tool: 'llm_generate', description: '', depends_on: [], params: {}, expectedOutput: '', outputExtract: '$.summary' } as L2DagStep])
    expect(result).toBe('这是摘要')
  })

  it('outputExtract提取嵌套路径', () => {
    const consumer: L2DagStep = { step: 2, tool: 'llm_generate', description: '消费', depends_on: [1], params: {}, expectedOutput: '', outputExtract: '$.data.items.0' }
    const sourceResult = JSON.stringify({ data: { items: ['第一项', '第二项'] } })
    const result = extractStepResult(sourceResult, consumer, 1, [{ step: 1, tool: 'llm_generate', description: '', depends_on: [], params: {}, expectedOutput: '', outputExtract: '$.data.items.0' } as L2DagStep])
    expect(result).toBe('第一项')
  })

  it('outputExtract JSON解析失败时回退到截断', () => {
    const consumer: L2DagStep = { step: 2, tool: 'llm_generate', description: '消费', depends_on: [1], params: {}, expectedOutput: '', outputExtract: '$.summary' }
    const result = extractStepResult('纯文本没有JSON', consumer, 1, [{ step: 1, tool: 'llm_generate', description: '', depends_on: [], params: {}, expectedOutput: '', outputExtract: '$.summary' } as L2DagStep])
    expect(result.length).toBeLessThanOrEqual(500)
  })
})

describe('resolveDirectPrompt', () => {
  const mockManifest: L2ToolManifest = {
    identity: { id: 'test-direct', name: '测试直调', version: '1.0', description: '测试', author: 'test', targetRoles: [] },
    routing: { keywords: [], targetRoles: [] },
    execution: {
      mode: 'direct',
      paramMapping: { bindings: [], slots: [
        { name: 'input_text', source: 'input_text', description: '用户输入', required: true },
        { name: 'context', source: 'context', description: '上下文', required: false }
      ]},
      directCall: { promptTemplate: '请处理: {{input_text}}\n上下文: {{context}}', maxTokens: 1024 }
    },
    cacheMeta: { estimatedTokenSaving: 0, lastUsed: 0, useCount: 0 },
    ruleBasedFallback: { enabled: false, targetStep: undefined, rules: [], defaultAction: { outputTemplate: '', severity: 'info' } }
  }

  it('正确解析直调prompt模板', () => {
    const result = resolveDirectPrompt(mockManifest, { inputText: '用户请求', context: '额外上下文' })
    expect(result).not.toBeNull()
    expect(result!.prompt).toContain('用户请求')
    expect(result!.prompt).toContain('额外上下文')
    expect(result!.maxTokens).toBe(1024)
  })

  it('mode非direct返回null', () => {
    const nonDirect = { ...mockManifest, execution: { ...mockManifest.execution, mode: 'macro' as const } }
    const result = resolveDirectPrompt(nonDirect, { inputText: 'test' })
    expect(result).toBeNull()
  })

  it('空userInput用空字符串填充', () => {
    const result = resolveDirectPrompt(mockManifest, {})
    expect(result).not.toBeNull()
    expect(result!.prompt).toContain('请处理:')
  })
})

describe('formatLineage + computeLineageSavings', () => {
  it('formatLineage格式化执行血缘', () => {
    const lineage = [
      { step: 1, source: 'rule_engine' as const, tool: 'llm_generate', ruleId: 'rule-1' },
      { step: 2, source: 'llm_mini' as const, tool: 'llm_generate', tier: 'mini' },
      { step: 3, source: 'cache_reuse' as const, tool: 'read_file' },
      { step: 4, source: 'tool_call' as const, tool: 'shell_exec' }
    ]
    const text = formatLineage(lineage)
    expect(text).toContain('步骤1')
    expect(text).toContain('规则引擎')
    expect(text).toContain('步骤2')
    expect(text).toContain('LLM Mini')
    expect(text).toContain('步骤3')
    expect(text).toContain('缓存复用')
  })

  it('computeLineageSavings: LLM步骤=2, 零token步骤=2', () => {
    const lineage = [
      { step: 1, source: 'llm_standard' as const, tool: 'llm_generate' },
      { step: 2, source: 'rule_engine' as const, tool: 'llm_generate' },
      { step: 3, source: 'cache_reuse' as const, tool: 'shell_exec' },
      { step: 4, source: 'llm_mini' as const, tool: 'llm_generate' }
    ]
    const savings = computeLineageSavings(lineage)
    expect(savings.llmSteps).toBe(2)
    expect(savings.zeroTokenSteps).toBe(2)
    expect(savings.tokensSaved).toBeGreaterThan(0)
  })

  it('全LLM步骤: zeroTokenSteps=0', () => {
    const lineage = [
      { step: 1, source: 'llm_pro' as const, tool: 'llm_generate' },
      { step: 2, source: 'llm_standard' as const, tool: 'llm_generate' }
    ]
    const savings = computeLineageSavings(lineage)
    expect(savings.zeroTokenSteps).toBe(0)
    expect(savings.tokensSaved).toBe(0)
  })
})

describe('resolveParams', () => {
  const mockManifest: L2ToolManifest = {
    identity: { id: 'test-resolve', name: '参数解析', version: '1.0', description: '测试', author: 'test', targetRoles: [] },
    routing: { keywords: [], targetRoles: [] },
    execution: {
      mode: 'macro',
      paramMapping: {
        bindings: [
          { targetStep: 2, slotName: 'input_text', targetParam: 'query' }
        ],
        slots: [
          { name: 'input_text', source: 'input_text', description: '用户输入', required: true }
        ]
      },
      dagPlan: {
        steps: [
          { step: 1, tool: 'llm_generate', description: '分析', depends_on: [], params: { prompt: '分析: {{input}}' }, expectedOutput: '分析结果' },
          { step: 2, tool: 'llm_generate', description: '总结', depends_on: [1], params: { prompt: '基于: {{step_1_result}}\n处理: {{query}}' }, expectedOutput: '总结' }
        ],
        fallbackStrategy: 'abort'
      }
    },
    cacheMeta: { estimatedTokenSaving: 0, lastUsed: 0, useCount: 0 },
    ruleBasedFallback: { enabled: false, targetStep: undefined, rules: [], defaultAction: { outputTemplate: '', severity: 'info' } }
  }

  it('slot绑定注入input_text到targetParam', () => {
    const step = mockManifest.execution.dagPlan!.steps[1]
    const result = resolveParams(step, mockManifest, { inputText: '用户问题' }, {})
    expect(result.query).toBe('用户问题')
  })

  it('{{step_1_result}}被替换为步骤结果', () => {
    const step = mockManifest.execution.dagPlan!.steps[1]
    const result = resolveParams(step, mockManifest, { inputText: 'test' }, { 1: '分析输出' })
    expect(result.prompt).toContain('分析输出')
    expect(result.prompt).not.toContain('{{step_1_result}}')
  })

  it('{{input}}被替换为userInput.inputText', () => {
    const step = mockManifest.execution.dagPlan!.steps[0]
    const result = resolveParams(step, mockManifest, { inputText: '原始输入' }, {})
    expect(result.prompt).toContain('原始输入')
  })
})
