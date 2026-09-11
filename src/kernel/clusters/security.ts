import type { SecurityCheckInput, SecurityCheckResult, KernelContext } from '../types'
import { shouldValidate, isPathUnsafe, isUrlUnsafe, dualEngineValidate, buildActionManifest } from '@/services/dualEngineValidator'

export async function check(input: SecurityCheckInput, context?: KernelContext): Promise<SecurityCheckResult> {
  if (input.targetPath && isPathUnsafe(input.targetPath)) {
    return { safe: false, riskLevel: 'high', reason: `unsafe-path: ${input.targetPath}` }
  }
  if (input.targetUrl && isUrlUnsafe(input.targetUrl)) {
    return { safe: false, riskLevel: 'high', reason: `unsafe-url: ${input.targetUrl}` }
  }

  let dualEngineResult: SecurityCheckResult['dualEngineResult']
  if (shouldValidate({ tool: input.action, params: input.params }, input.manifestId)) {
    const actionManifest = buildActionManifest(input.manifestId ?? '', { tool: input.action, params: input.params }, input.userInput)
    const validation = await dualEngineValidate(actionManifest, input.userInput)
    dualEngineResult = {
      intent_match: validation.intent_match,
      parameter_sane: validation.parameter_sane,
      risk_level: validation.risk_level,
    }
    if (validation.risk_level === 'high') {
      return { safe: false, riskLevel: 'high', reason: 'dual-engine-high-risk', dualEngineResult }
    }
  }

  return {
    safe: dualEngineResult?.parameter_sane !== false,
    riskLevel: (dualEngineResult?.risk_level as any) ?? 'low',
    dualEngineResult,
  }
}

export function shouldFactCheck(manifestRoles: string[], contextText: string): boolean {
  const { shouldTrigger } = require('@/services/factGuard')
  return shouldTrigger(manifestRoles, contextText)
}

export function quickSafetyCheck(targetPath?: string, targetUrl?: string): SecurityCheckResult {
  if (targetPath && isPathUnsafe(targetPath)) {
    return { safe: false, riskLevel: 'high', reason: `unsafe-path: ${targetPath}` }
  }
  if (targetUrl && isUrlUnsafe(targetUrl)) {
    return { safe: false, riskLevel: 'high', reason: `unsafe-url: ${targetUrl}` }
  }
  return { safe: true, riskLevel: 'low' }
}
