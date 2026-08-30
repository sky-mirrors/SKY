import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockChatCompletion = vi.fn()

vi.mock('@/stores/debugStore', () => ({
  useDebugStore: () => ({ emitEvent: vi.fn() })
}))

vi.mock('@/stores/apiStore', () => ({
  useApiStore: () => ({
    chatCompletion: mockChatCompletion
  })
}))

import { classifyError } from '@/services/errorClassifier'

describe('errorClassifier', () => {
  beforeEach(() => {
    mockChatCompletion.mockReset()
    mockChatCompletion.mockResolvedValue({
      content: '{"category":"network","action":"retry","fixHint":"重试"}'
    })
  })

  describe('关键词快速分类（不走LLM）', () => {
    it('ECONNREFUSED → network → retry', async () => {
      const r = await classifyError('Error: ECONNREFUSED 127.0.0.1:443', 'http_request', '调用API')
      expect(r.category).toBe('network')
      expect(r.action).toBe('retry')
      expect(mockChatCompletion).not.toHaveBeenCalled()
    })

    it('ETIMEDOUT → network → retry', async () => {
      const r = await classifyError('ETIMEDOUT connection timed out', 'shell_exec', '下载资源')
      expect(r.category).toBe('network')
      expect(r.action).toBe('retry')
    })

    it('ENOTFOUND → network', async () => {
      const r = await classifyError('getaddrinfo ENOTFOUND api.example.com', 'http_request', '请求')
      expect(r.category).toBe('network')
    })

    it('EACCES → permission → abort', async () => {
      const r = await classifyError('Error: EACCES permission denied /etc/hosts', 'shell_exec', '写入文件')
      expect(r.category).toBe('permission')
      expect(r.action).toBe('abort')
    })

    it('EPERM → permission → abort', async () => {
      const r = await classifyError('EPERM operation not permitted', 'shell_exec', '修改权限')
      expect(r.category).toBe('permission')
      expect(r.action).toBe('abort')
    })

    it('timeout → timeout → retry', async () => {
      const r = await classifyError('Request timeout after 30000ms', 'http_request', '远程调用')
      expect(r.category).toBe('timeout')
      expect(r.action).toBe('retry')
    })

    it('超时(中文) → timeout', async () => {
      const r = await classifyError('命令超时(60000ms)，已发送终止信号', 'shell_exec', '执行脚本')
      expect(r.category).toBe('timeout')
    })

    it('SIGKILL → timeout', async () => {
      const r = await classifyError('Process received SIGKILL', 'shell_exec', '执行命令')
      expect(r.category).toBe('timeout')
    })

    it('TypeError → syntax → retry_with_fix', async () => {
      const r = await classifyError('TypeError: Cannot read properties of undefined', 'llm_generate', '生成代码')
      expect(r.category).toBe('syntax')
      expect(r.action).toBe('retry_with_fix')
    })

    it('ENOENT → resource_missing → retry_with_fix', async () => {
      const r = await classifyError('ENOENT: no such file or directory', 'shell_exec', '读取文件')
      expect(r.category).toBe('resource_missing')
      expect(r.action).toBe('retry_with_fix')
    })

    it('MODULE_NOT_FOUND → resource_missing', async () => {
      const r = await classifyError('Error: MODULE_NOT_FOUND cannot find module docx', 'shell_exec', '生成文档')
      expect(r.category).toBe('resource_missing')
      expect(r.fixHint).toContain('安装')
    })

    it('大小写不敏感匹配', async () => {
      const r = await classifyError('NETWORK error occurred', 'shell_exec', '网络操作')
      expect(r.category).toBe('network')
    })

    it('network 错误提示重试', async () => {
      const r = await classifyError('ECONNREFUSED', 'http_request', '调用')
      expect(r.fixHint).toContain('网络')
    })

    it('permission 错误提示权限', async () => {
      const r = await classifyError('EACCES permission denied', 'shell_exec', '写入')
      expect(r.fixHint).toContain('权限')
    })

    it('resource_missing 提示安装', async () => {
      const r = await classifyError('MODULE_NOT_FOUND', 'shell_exec', '执行')
      expect(r.fixHint).toContain('安装')
    })
  })

  describe('走 LLM fallback 的分类 (syntax/logic/unknown/file_format)', () => {
    it('SyntaxError → 关键词快速分类syntax → retry_with_fix', async () => {
      const r = await classifyError('SyntaxError: Unexpected token }', 'shell_exec', '运行脚本')
      expect(r.category).toBe('syntax')
      expect(r.action).toBe('retry_with_fix')
      expect(mockChatCompletion).not.toHaveBeenCalled()
    })

    it('FactGuard → logic → 走LLM → 返回logic分类', async () => {
      mockChatCompletion.mockResolvedValueOnce({
        content: '{"category":"logic","action":"abort","fixHint":"人工确认"}'
      })
      const r = await classifyError('FactGuard: 金额不一致 100 vs 200', 'llm_generate', '提取数据')
      expect(r.category).toBe('logic')
      expect(r.action).toBe('abort')
    })

    it('未知错误 → 走LLM → 返回LLM分类', async () => {
      mockChatCompletion.mockResolvedValueOnce({
        content: '{"category":"unknown","action":"retry","fixHint":"未知错误"}'
      })
      const r = await classifyError('Something went horribly wrong', 'shell_exec', '未知操作')
      expect(r.category).toBe('unknown')
    })

    it('file_format → 走LLM', async () => {
      mockChatCompletion.mockResolvedValueOnce({
        content: '{"category":"file_format","action":"switch_tool","fixHint":"换工具"}'
      })
      const r = await classifyError('xlsx file has invalid format', 'read_file', '解析配置')
      expect(r.category).toBe('file_format')
      expect(r.action).toBe('switch_tool')
    })

    it('LLM调用失败 → 回退到关键词快速分类', async () => {
      mockChatCompletion.mockRejectedValueOnce(new Error('API down'))
      const r = await classifyError('SyntaxError: bad code', 'shell_exec', '执行')
      expect(r.category).toBe('syntax')
      expect(r.action).toBe('retry_with_fix')
    })

    it('LLM返回无法解析 → 回退到关键词快速分类', async () => {
      mockChatCompletion.mockResolvedValueOnce({
        content: '无法理解这个错误'
      })
      const r = await classifyError('SyntaxError: bad code', 'shell_exec', '执行')
      expect(r.category).toBe('syntax')
    })
  })

  describe('关键词优先级', () => {
    it('多关键词同时出现时返回第一个匹配的category', async () => {
      const r = await classifyError('ECONNREFUSED connection error', 'shell_exec', '混合错误')
      expect(r.category).toBe('network')
    })
  })
})
