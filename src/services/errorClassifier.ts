import type { RiskLevel } from '@/models'

export type ErrorCategory = 'network' | 'file_format' | 'permission' | 'timeout' | 'syntax' | 'resource_missing' | 'logic' | 'unknown'

export interface ErrorClassification {
  category: ErrorCategory
  action: 'retry' | 'switch_tool' | 'abort' | 'retry_with_fix'
  fixHint?: string
  retryCount?: number
}

const ERROR_KEYWORDS: Record<ErrorCategory, string[]> = {
  syntax: ['SyntaxError', 'TypeError', 'ReferenceError', 'unexpected', 'is not defined', 'Cannot read propert', 'is not a function', 'exit code'],
  network: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'fetch failed', 'fetchfailed', 'network', 'socket hang up', 'DNS', 'EAI_AGAIN'],
  permission: ['EACCES', 'EPERM', 'permission denied', 'access denied', 'not authorized', 'forbidden'],
  timeout: ['timeout', 'timed out', 'timeouterror', 'deadline exceeded', 'SIGKILL', '超时'],
  resource_missing: ['ENOENT', 'MODULE_NOT_FOUND', 'not found', 'no such file', 'does not exist', 'cannot find module', '找不到'],
  file_format: ['xlsx', 'csv', 'parse error', 'invalid format', 'malformed', 'encoding', 'decode', 'not a valid'],
  logic: ['FactGuard', 'intent_match', 'parameter_sane', '不一致', '冲突', 'mismatch'],
  unknown: []
}

const CATEGORY_FIX_HINTS: Record<ErrorCategory, string> = {
  network: '网络问题，建议稍后重试',
  file_format: '文件格式不兼容，建议换用其他工具解析',
  permission: '权限不足，建议检查文件/目录权限',
  timeout: '执行超时，建议减小数据量或增加超时时间',
  syntax: '脚本语法错误，建议修复脚本逻辑',
  resource_missing: '缺少依赖，建议先安装所需模块',
  logic: '逻辑冲突，建议人工确认',
  unknown: '未知错误'
}

const CATEGORY_ACTIONS: Record<ErrorCategory, ErrorClassification['action']> = {
  network: 'retry',
  file_format: 'switch_tool',
  permission: 'abort',
  timeout: 'retry',
  syntax: 'retry_with_fix',
  resource_missing: 'retry_with_fix',
  logic: 'abort',
  unknown: 'retry'
}

function classifyByKeywords(errorMsg: string): ErrorCategory {
  const lower = errorMsg.toLowerCase()
  for (const [cat, keywords] of Object.entries(ERROR_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) return cat as ErrorCategory
    }
  }
  return 'unknown'
}

const CLASSIFY_PROMPT = `【错误分类任务】
以下是一个工具执行失败的错误信息。请分类并建议后续动作。

错误信息：{{errorMsg}}
工具名称：{{toolName}}
步骤描述：{{stepDesc}}

只输出JSON：
{"category":"network|file_format|permission|timeout|syntax|resource_missing|logic|unknown","action":"retry|switch_tool|abort|retry_with_fix","fixHint":"简短修复建议"}`

export async function classifyError(
  errorMsg: string,
  toolName: string,
  stepDesc: string
): Promise<ErrorClassification> {
  const keywordResult = classifyByKeywords(errorMsg)
  const quickResult: ErrorClassification = {
    category: keywordResult,
    action: CATEGORY_ACTIONS[keywordResult],
    fixHint: CATEGORY_FIX_HINTS[keywordResult]
  }

  if (keywordResult !== 'unknown' && keywordResult !== 'file_format' && keywordResult !== 'logic') {
    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('info', 'schedule', `[错误分类] 关键词快速分类: ${keywordResult} → ${quickResult.action}`) } catch { /* ignore */ }
    return quickResult
  }

  try {
    const { useApiStore } = await import('@/stores/apiStore')
    const apiStore = useApiStore()
    const prompt = CLASSIFY_PROMPT
      .replace('{{errorMsg}}', errorMsg.substring(0, 500))
      .replace('{{toolName}}', toolName)
      .replace('{{stepDesc}}', stepDesc.substring(0, 200))

    const response = await apiStore.chatCompletion(
      [{ role: 'user' as const, content: prompt }],
      true,
      undefined,
      5000,
      undefined,
      { taskType: 'classify', callerId: 'errorClassifier' }
    )

    const content = response.content || ''
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return quickResult

    const parsed = JSON.parse(jsonMatch[0])
    const result: ErrorClassification = {
      category: parsed.category || 'unknown',
      action: parsed.action || 'retry',
      fixHint: parsed.fixHint || quickResult.fixHint
    }

    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('info', 'schedule', `[错误分类] LLM分类: ${result.category} → ${result.action} | ${result.fixHint || ''}`) } catch { /* ignore */ }
    return result
  } catch {
    return quickResult
  }
}

const CATEGORY_USER_LABEL: Record<ErrorCategory, string> = {
  network: '网络错误',
  timeout: '超时',
  syntax: '内部错误',
  permission: '权限不足',
  resource_missing: '资源不存在',
  file_format: '文件格式错误',
  logic: '逻辑冲突',
  unknown: '执行异常'
}

export function classifyErrorForUser(err: string): string {
  const exitMatch = err.match(/exit code (\d+)/i)
  if (exitMatch) return `退出码${exitMatch[1]}`
  const category = classifyByKeywords(err)
  return CATEGORY_USER_LABEL[category]
}
