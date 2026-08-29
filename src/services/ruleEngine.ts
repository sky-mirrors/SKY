import { L2RuleBasedFallback, L2RuleCondition, L2RuleEntry, L2RuleAction } from '@/models'

function extractNumericValues(text: string): number[] {
  const cleaned = text.replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?/g, '')
  const matches = cleaned.match(/[\d,]+\.?\d*/g) || []
  return matches.map(m => Number(m.replace(/,/g, ''))).filter(n => !isNaN(n) && (n < 1900 || n > 2099))
}

function evaluateCondition(cond: L2RuleCondition, context: Record<string, string>): boolean {
  const fieldValue = context[cond.field] || ''
  switch (cond.operator) {
    case 'gt': {
      const nums = extractNumericValues(fieldValue)
      return nums.some(n => n > Number(cond.value))
    }
    case 'gte': {
      const nums = extractNumericValues(fieldValue)
      return nums.some(n => n >= Number(cond.value))
    }
    case 'lt': {
      const nums = extractNumericValues(fieldValue)
      return nums.some(n => n < Number(cond.value))
    }
    case 'lte': {
      const nums = extractNumericValues(fieldValue)
      return nums.some(n => n <= Number(cond.value))
    }
    case 'eq':
      return fieldValue === String(cond.value) || extractNumericValues(fieldValue).some(n => n === Number(cond.value))
    case 'neq':
      return fieldValue !== String(cond.value) && !extractNumericValues(fieldValue).some(n => n === Number(cond.value))
    case 'contains':
      return fieldValue.includes(String(cond.value))
    case 'not_contains':
      return !fieldValue.includes(String(cond.value))
    case 'regex': {
      try {
        const re = new RegExp(String(cond.value), 'i')
        return re.test(fieldValue)
      } catch {
        return false
      }
    }
    case 'between': {
      const nums = extractNumericValues(fieldValue)
      return nums.some(n => n >= Number(cond.value) && n <= Number(cond.valueMax || cond.value))
    }
    default:
      return false
  }
}

function fillTemplate(template: string, variables: Record<string, string>): string {
  let result = template
  for (const [k, v] of Object.entries(variables)) {
    result = result.replaceAll(`{{${k}}}`, v)
  }
  return result
}

export interface RuleEngineResult {
  matched: boolean
  output: string
  matchedRuleId?: string
  severity?: 'info' | 'warning' | 'error'
  tags?: string[]
}

export function runRuleEngine(
  fallback: L2RuleBasedFallback,
  context: Record<string, string>
): RuleEngineResult {
  if (!fallback.enabled || fallback.rules.length === 0) {
    return { matched: false, output: '' }
  }

  const sorted = [...fallback.rules].sort((a, b) => b.priority - a.priority)

  for (const rule of sorted) {
    const allMatch = rule.conditions.every(c => evaluateCondition(c, context))
    if (allMatch) {
      const output = fillTemplate(rule.action.outputTemplate, context)
      return {
        matched: true,
        output,
        matchedRuleId: rule.id,
        severity: rule.action.severity,
        tags: rule.action.tags
      }
    }
  }

  return { matched: false, output: '' }
}

export function buildRuleContext(
  userInput: { filePath?: string; inputText?: string; context?: string },
  stepResults: Record<number, string>
): Record<string, string> {
  const ctx: Record<string, string> = {
    input: userInput.inputText || '',
    user_file: userInput.filePath || '',
    context: userInput.context || ''
  }
  for (const [num, result] of Object.entries(stepResults)) {
    ctx[`step_${num}_result`] = result
    const nums = extractNumericValues(result)
    if (nums.length > 0) {
      ctx[`step_${num}_amount`] = String(Math.max(...nums))
      ctx[`step_${num}_total`] = String(nums.reduce((a, b) => a + b, 0))
    }
  }
  return ctx
}
