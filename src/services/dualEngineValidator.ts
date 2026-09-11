import { ActionManifest, ValidationResult } from '@/models'
import { getLLM } from '@/kernel/plugins/llm'
import { getValidationCacheKey, lookupValidationCache, saveValidationCache } from './scheduleOptimizer'

const VALIDATOR_PROMPT = `【审核任务】
你是一个严谨的安全审计官。请审核以下即将执行的动作是否安全、参数是否匹配。

当前上下文环境：
- 用户原话：{{userInput}}
- 要执行的动作：{{actionManifest}}

请回答以下3个问题（只输出JSON，不要输出任何其他内容）：
1. "intent_match": 该动作是否准确响应用户原话的核心意图？（true/false）
2. "parameter_sane": 目标文件路径后缀名是否匹配操作类型？（true/false，只检查后缀，不检查文件名特殊字符）
3. "risk_level": 评估风险等级（"low"/"medium"/"high"）

如果任一答案为false，或风险等级为high，请在"reason"字段说明具体怀疑点。
输出格式：{"intent_match":true,"parameter_sane":true,"risk_level":"low"}`

const DANGEROUS_PATHS: RegExp[] = [
  /\/etc\/passwd/i,
  /\/etc\/shadow/i,
  /C:\\Windows/i,
  /C:\\Program\s*Files/i,
  /C:\\System32/i,
  /\.\.[\/\\]/,
  /\/root\//i,
  /\/var\/log/i,
  /\/boot\//i,
  /\/proc\//i,
]

const DANGEROUS_URL_PATTERNS: RegExp[] = [
  /localhost/i,
  /127\.0\.0\.1/i,
  /0\.0\.0\.0/i,
  /169\.254\.169\.254/i,
  /file:\/\//i,
  /ftp:\/\//i,
  /\[::1\]/i,
]

function isPathSafe(filePath: string): boolean {
  for (const pattern of DANGEROUS_PATHS) {
    if (pattern.test(filePath)) return false
  }
  return true
}

function isUrlSafe(url: string): boolean {
  for (const pattern of DANGEROUS_URL_PATTERNS) {
    if (pattern.test(url)) return false
  }
  return true
}

function isWriteOperation(command: string): boolean {
  return /writeFileSync|writeFile|mkdir|mv |cp |rm |del |rename|truncate|unlink/i.test(command)
}

function isHighRiskCommand(command: string): boolean {
  return /rm\s|rmSync|rmdir|unlink|unlinkSync|del\s|erase|format|shred/i.test(command)
}

function extractTargetFile(command: string): string {
  const sq = "'((?:[^'\\\\]|\\\\.)+?)'"
  const dq = '"((?:[^"\\\\]|\\\\.)+?)"'
  const edq = '\\\\"((?:[^"\\\\]|\\\\.)+?)\\\\"'
  const writeFileSyncRe = new RegExp(`writeFileSync\\s*\\(\\s*(?:${sq}|${dq}|${edq})`)
  const writeFileSyncMatch = command.match(writeFileSyncRe)
  if (writeFileSyncMatch) return writeFileSyncMatch[1] ?? writeFileSyncMatch[2] ?? writeFileSyncMatch[3]
  const writeFileRe = new RegExp(`writeFile\\s*\\(\\s*(?:${sq}|${dq}|${edq})`)
  const writeFileMatch = command.match(writeFileRe)
  if (writeFileMatch) return writeFileMatch[1] ?? writeFileMatch[2] ?? writeFileMatch[3]
  const pathRe = new RegExp(`(?:${sq}|${dq}|${edq})((?:[A-Za-z]:[\\\\/]|/)[^'"\\\\]+\\.[A-Za-z]\\w+)(?:${sq}|${dq}|${edq})`)
  const pathMatch = command.match(pathRe)
  if (pathMatch) return pathMatch[1] ?? pathMatch[2] ?? pathMatch[3]
  return '(未知)'
}

function extractFilePath(params: Record<string, unknown> | undefined): string {
  return String(params?.path || params?.filePath || params?.file || params?.target || '')
}

function extractUrl(params: Record<string, unknown> | undefined): string {
  return String(params?.url || params?.endpoint || params?.uri || '')
}

export function shouldValidate(step: { tool: string; params?: Record<string, unknown> }, manifestId?: string): boolean {
  if (step.tool === 'shell_exec') {
    const cmd = String(step.params?.command || '')
    return isWriteOperation(cmd)
  }
  if (step.tool === 'file_write') return true
  if (step.tool === 'http_request') return true
  if (step.tool === 'read_file') return true
  return false
}

export function isPathUnsafe(filePath: string): boolean {
  return !isPathSafe(filePath)
}

export function isUrlUnsafe(url: string): boolean {
  return !isUrlSafe(url)
}

export function buildActionManifest(
  manifestId: string,
  step: { tool: string; params?: Record<string, unknown> },
  userInput: string
): ActionManifest {
  if (step.tool === 'shell_exec') {
    const cmd = String(step.params?.command || '')
    const targetFile = extractTargetFile(cmd)
    const isHigh = isHighRiskCommand(cmd)
    return {
      skill_id: manifestId,
      target_file: targetFile,
      operation: isHigh ? '高风险删除/覆盖' : '文件写入',
      expected_output: `操作目标: ${targetFile}`,
      intent: userInput.substring(0, 200),
      isHighRisk: isHigh
    }
  }

  if (step.tool === 'file_write') {
    const filePath = extractFilePath(step.params)
    const pathUnsafe = !isPathSafe(filePath)
    return {
      skill_id: manifestId,
      target_file: filePath,
      operation: pathUnsafe ? '危险路径文件写入' : '文件写入',
      expected_output: `写入目标: ${filePath}`,
      intent: userInput.substring(0, 200),
      isHighRisk: pathUnsafe
    }
  }

  if (step.tool === 'http_request') {
    const url = extractUrl(step.params)
    const urlUnsafe = !isUrlSafe(url)
    return {
      skill_id: manifestId,
      target_file: url,
      operation: urlUnsafe ? '危险URL请求' : 'HTTP请求',
      expected_output: `请求目标: ${url}`,
      intent: userInput.substring(0, 200),
      isHighRisk: urlUnsafe
    }
  }

  if (step.tool === 'read_file') {
    const filePath = extractFilePath(step.params)
    const pathUnsafe = !isPathSafe(filePath)
    return {
      skill_id: manifestId,
      target_file: filePath,
      operation: pathUnsafe ? '危险路径文件读取' : '文件读取',
      expected_output: `读取目标: ${filePath}`,
      intent: userInput.substring(0, 200),
      isHighRisk: pathUnsafe
    }
  }

  return {
    skill_id: manifestId,
    target_file: '(未知)',
    operation: step.tool,
    expected_output: '',
    intent: userInput.substring(0, 200),
    isHighRisk: false
  }
}

export async function dualEngineValidate(
  actionManifest: ActionManifest,
  userInput: string
): Promise<ValidationResult> {
  const cacheKey = getValidationCacheKey(actionManifest.skill_id, actionManifest.target_file, actionManifest.operation)
  const cached = lookupValidationCache(cacheKey)
  if (cached) {
    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('info', 'cache', `[双引擎] 审核缓存命中: ${cacheKey.substring(0, 40)}`) } catch { /* ignore */ }
    return cached
  }

  if (actionManifest.isHighRisk) {
    const reason = actionManifest.operation === '危险路径文件写入'
      ? `检测到危险路径写入: ${actionManifest.target_file}`
      : actionManifest.operation === '危险URL请求'
        ? `检测到危险URL请求: ${actionManifest.target_file}`
        : actionManifest.operation === '危险路径文件读取'
          ? `检测到危险路径读取: ${actionManifest.target_file}`
          : '检测到删除/销毁类命令'
    const result: ValidationResult = { intent_match: true, parameter_sane: false, risk_level: 'high', reason }
    saveValidationCache(cacheKey, result)
    return result
  }

  const prompt = VALIDATOR_PROMPT
    .replace('{{userInput}}', userInput.substring(0, 500))
    .replace('{{actionManifest}}', JSON.stringify(actionManifest))

  try {
    const llm = getLLM()
    const response = await llm.chatCompletion(
      [{ role: 'user', content: prompt }],
      { stream: true, taskType: 'classify', callerId: 'dualEngineValidator', maxTokens: 5000 }
    )

    const content = response.content || ''
    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('info', 'llm', `[双引擎] 审核结果: ${content.substring(0, 200)}`) } catch { /* ignore */ }

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { intent_match: false, parameter_sane: false, risk_level: 'medium', reason: '验证器输出无法解析，安全策略阻断' }
    }

    const parsed = JSON.parse(jsonMatch[0])
    const result: ValidationResult = {
      intent_match: parsed.intent_match === true,
      parameter_sane: parsed.parameter_sane === true,
      risk_level: (parsed.risk_level === 'low' || parsed.risk_level === 'medium' || parsed.risk_level === 'high') ? parsed.risk_level : 'medium',
      reason: parsed.reason
    }

    saveValidationCache(cacheKey, result)

    return result
  } catch (e) {
    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('warn', 'llm', `[双引擎] 审核调用失败: ${(e as Error).message}`) } catch { /* ignore */ }
    return { intent_match: false, parameter_sane: false, risk_level: 'medium', reason: '验证器调用失败，安全策略阻断' }
  }
}
