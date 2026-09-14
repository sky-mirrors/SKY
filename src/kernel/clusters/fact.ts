import type { FactCheckInput, FactCheckResult, KernelContext } from '../types'
import { extractEntities } from '@/services/nerExtractor'
import { runFactGuardV2, shouldTrigger } from '@/services/factGuard'
import { runCrossDocValidation } from '@/services/crossDocValidator'

export function check(input: FactCheckInput, context?: KernelContext): FactCheckResult {
  if (!shouldTrigger(input.manifestRoles, input.llmOutput)) {
    return { severity: 'ok', conflicts: [], autoCorrected: false }
  }

  const outputEntities = extractEntities(input.llmOutput)
  const result = runFactGuardV2(
    input.sourceEntities as any,
    outputEntities as any,
    input.llmOutput,
    input.documents,
  )

  return {
    severity: result.severity as any,
    conflicts: (result.conflicts ?? []).map((c: any) => ({
      type: c.type,
      source: c.source?.raw ?? '',
      output: c.output?.raw ?? '',
      severity: c.severity,
    })),
    autoCorrected: result.correctedOutput != null,
    correctedText: result.correctedOutput ?? undefined,
    constraintResults: result.allConstraintResults,
  }
}

export function extractEntitiesFromText(text: string): any[] {
  return extractEntities(text)
}

export function crossDocCheck(documents: Array<{ docId: string; text: string }>): any[] {
  return runCrossDocValidation(documents)
}
