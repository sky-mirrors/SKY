import { ActionManifest, ValidationResult } from '@/models'
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

function isWriteOperation(command: string): boolean {
  return /writeFileSync|writeFile|mkdir|mv |cp |rm |del |rename|truncate|unlink/i.test(command)
}

function isHighRiskCommand(command: string): boolean {
  return /rm\s|rmSync|rmdir|unlink|unlinkSync|del\s|erase|format|shred/i.test(command)
}

function extractTargetFile(command: string): string {
  const writeFileSyncMatch = command.match(/writeFileSync\s*\(\s*(?:['"]|\\")([^'"]+?)(?:['"]|\\")/)
  if (writeFileSyncMatch) return writeFileSyncMatch[1]
  const writeFileMatch = command.match(/writeFile\s*\(\s*(?:['"]|\\")([^'"]+?)(?:['"]|\\")/)
  if (writeFileMatch) return writeFileMatch[1]
  const pathMatch = command.match(/(?:['"]|\\")((?:[A-Za-z]:[\\\/]|\/)[^'"]+\.\w+)(?:['"]|\\")/)
  if (pathMatch) return pathMatch[1]
  return '(未知)'
}

export function shouldValidate(step: { tool: string; params?: Record<string, unknown> }, manifestId?: string): boolean {
  if (step.tool !== 'shell_exec') return false
  const cmd = String(step.params?.command || '')
  return isWriteOperation(cmd)
}

export function buildActionManifest(
  manifestId: string,
  step: { tool: string; params?: Record<string, unknown> },
  userInput: string
): ActionManifest {
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
    const result: ValidationResult = { intent_match: true, parameter_sane: true, risk_level: 'high', reason: '检测到删除/销毁类命令' }
    saveValidationCache(cacheKey, result)
    return result
  }

  const prompt = VALIDATOR_PROMPT
    .replace('{{userInput}}', userInput.substring(0, 500))
    .replace('{{actionManifest}}', JSON.stringify(actionManifest))

  try {
    const { useApiStore } = await import('@/stores/apiStore')
    const apiStore = useApiStore()
    const response = await apiStore.chatCompletion(
      [{ role: 'user' as const, content: prompt }],
      true,
      undefined,
      5000
    )

    const content = response.content || ''
    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('info', 'llm', `[双引擎] 审核结果: ${content.substring(0, 200)}`) } catch { /* ignore */ }

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { intent_match: false, parameter_sane: false, risk_level: 'medium', reason: '验证器输出无法解析，安全策略阻断' }
    }

    const parsed = JSON.parse(jsonMatch[0])
    const result: ValidationResult = {
      intent_match: parsed.intent_match !== false,
      parameter_sane: parsed.parameter_sane !== false,
      risk_level: parsed.risk_level || 'low',
      reason: parsed.reason
    }

    saveValidationCache(cacheKey, result)

    return result
  } catch (e) {
    try { (await import('@/stores/debugStore')).useDebugStore().emitEvent('warn', 'llm', `[双引擎] 审核调用失败: ${(e as Error).message}`) } catch { /* ignore */ }
    return { intent_match: false, parameter_sane: false, risk_level: 'medium', reason: '验证器调用失败，安全策略阻断' }
  }
}
