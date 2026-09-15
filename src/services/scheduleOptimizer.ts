import { L2ToolManifest, L2DagStep, ValidationResult, ValidationCacheEntry } from '@/models'
import { contentHash } from './hash'
import { NO_CACHE_REUSE_TOOLS } from './toolRegistry'

export { contentHash }

interface CompiledPrompt {
  template: string
  variableSlots: string[]
  hash: string
  createdAt: number
}

const promptCache = new Map<string, CompiledPrompt>()

export function truncateForLog(content: string, maxLen: number = 200): string {
  if (content.length <= maxLen) return content
  return content.substring(0, maxLen) + '...(已截断，完整内容可从缓存获取)'
}

export function compilePrompt(template: string): CompiledPrompt {
  const existing = promptCache.get(template)
  if (existing) return existing

  const slotRegex = /\{\{(\w+)\}\}/g
  const variableSlots: string[] = []
  let match: RegExpExecArray | null
  while ((match = slotRegex.exec(template)) !== null) {
    if (!variableSlots.includes(match[1])) variableSlots.push(match[1])
  }

  const compiled: CompiledPrompt = {
    template,
    variableSlots,
    hash: contentHash(template),
    createdAt: Date.now()
  }
  promptCache.set(template, compiled)
  return compiled
}

export function fillCompiledPrompt(compiled: CompiledPrompt, variables: Record<string, string>): string {
  let result = compiled.template
  for (const slot of compiled.variableSlots) {
    const value = variables[slot] || ''
    result = result.replaceAll(`{{${slot}}}`, value)
  }
  return result
}

interface ExecutionFingerprint {
  manifestId: string
  inputHash: string
  stepHashes: Record<number, string>
  results: Record<number, string>
  executedAt: number
}

interface ManifestExecutionStats {
  manifestId: string
  successCount: number
  cacheHitCount: number
  lastExecutedAt: number
  autoCompiled: boolean
}

const fingerprintStore: ExecutionFingerprint[] = []
const MAX_FINGERPRINTS = 50
const manifestStats = new Map<string, ManifestExecutionStats>()
const AUTO_COMPILE_THRESHOLD = 10
// #3 收尾：晋级门槛是"真实执行占比"（1-缓存命中率），非缓存命中率
const AUTO_COMPILE_REAL_EXEC_RATE = 0.8

const FP_STORE_KEY = 'execution-fingerprints'
const STATS_STORE_KEY = 'manifest-execution-stats'
let persistDirty = false

function persistToStore(): void {
  if (!persistDirty) return
  persistDirty = false
  try {
    if (window.electronAPI?.storeWrite) {
      const fpData = fingerprintStore.map(f => ({
        manifestId: f.manifestId,
        inputHash: f.inputHash,
        stepHashes: f.stepHashes,
        executedAt: f.executedAt,
        resultHashes: Object.fromEntries(Object.entries(f.results).map(([k, v]) => [k, structHash(v.substring(0, 200))]))
      }))
      window.electronAPI.storeWrite(FP_STORE_KEY, fpData).catch(() => {})
      const statsArr: ManifestExecutionStats[] = []
      manifestStats.forEach(s => statsArr.push(s))
      window.electronAPI.storeWrite(STATS_STORE_KEY, statsArr).catch(() => {})
    }
  } catch { /* non-critical */ }
}

export async function loadPersistedFingerprints(): Promise<void> {
  try {
    if (window.electronAPI?.storeRead) {
      const fpData = await window.electronAPI.storeRead(FP_STORE_KEY) as Array<{ manifestId: string; inputHash: string; stepHashes: Record<number, string>; executedAt: number }> | null
      if (fpData && Array.isArray(fpData)) {
        fingerprintStore.length = 0
        for (const f of fpData.slice(-MAX_FINGERPRINTS)) {
          fingerprintStore.push({ manifestId: f.manifestId, inputHash: f.inputHash, stepHashes: f.stepHashes, results: {}, executedAt: f.executedAt })
        }
      }
      const statsData = await window.electronAPI.storeRead(STATS_STORE_KEY) as ManifestExecutionStats[] | null
      if (statsData && Array.isArray(statsData)) {
        manifestStats.clear()
        for (const s of statsData) {
          manifestStats.set(s.manifestId, s)
        }
      }
    }
  } catch { /* non-critical */ }
}

function structHash(data: string): string {
  return contentHash(data)
}

export function computeInputFingerprint(input: { filePath?: string; inputText?: string; context?: string }): string {
  const parts = [input.filePath || '', input.inputText || '', input.context || '']
  return structHash(parts.join('|'))
}

export function findCachedExecution(manifestId: string, inputFingerprint: string): ExecutionFingerprint | null {
  return fingerprintStore.find(f => f.manifestId === manifestId && f.inputHash === inputFingerprint) || null
}

export function saveExecutionFingerprint(
  manifestId: string,
  inputFingerprint: string,
  stepHashes: Record<number, string>,
  results: Record<number, string>,
  fromCache?: boolean,
  sideEffectSteps?: Set<number>
): void {
  const filteredResults: Record<number, string> = {}
  for (const [k, v] of Object.entries(results)) {
    if (!sideEffectSteps?.has(Number(k))) filteredResults[Number(k)] = v
  }
  const existing = fingerprintStore.findIndex(f => f.manifestId === manifestId && f.inputHash === inputFingerprint)
  if (existing >= 0) fingerprintStore.splice(existing, 1)
  fingerprintStore.push({
    manifestId,
    inputHash: inputFingerprint,
    stepHashes,
    results: filteredResults,
    executedAt: Date.now()
  })
  if (fingerprintStore.length > MAX_FINGERPRINTS) fingerprintStore.splice(0, fingerprintStore.length - MAX_FINGERPRINTS)

  let stats = manifestStats.get(manifestId)
  if (!stats) {
    stats = { manifestId, successCount: 0, cacheHitCount: 0, lastExecutedAt: 0, autoCompiled: false }
    manifestStats.set(manifestId, stats)
  }
  stats.successCount++
  if (fromCache) stats.cacheHitCount++
  stats.lastExecutedAt = Date.now()

  if (!stats.autoCompiled && stats.successCount >= AUTO_COMPILE_THRESHOLD) {
    // #3 收尾：autoCompile 晋级门槛写反——原 hitRate≥0.8 让"10 次纯缓存命中"
    // 成为晋级最短路径，与自编译（工作流被真实跑熟）的语义相反；
    // 改为真实执行占比达标才晋级，纯缓存命中的清单永不晋级
    const realExecRate = 1 - stats.cacheHitCount / stats.successCount
    if (realExecRate >= AUTO_COMPILE_REAL_EXEC_RATE) {
      stats.autoCompiled = true
    }
  }
  persistDirty = true
  setTimeout(persistToStore, 2000)
}

export function isManifestAutoCompiled(manifestId: string): boolean {
  return manifestStats.get(manifestId)?.autoCompiled || false
}

export function getManifestStats(manifestId: string): ManifestExecutionStats | null {
  return manifestStats.get(manifestId) || null
}

export interface DataflowIssue {
  step: number
  description: string
  missingVar: string
  severity: 'error' | 'warning'
}

export interface DataflowReport {
  ok: boolean
  issues: DataflowIssue[]
  summary: string
}

const STEP_VAR_REGEX = /step_(\d+)_result/g

export function simulateDataFlow(steps: L2DagStep[]): DataflowReport {
  const issues: DataflowIssue[] = []
  const producingSteps = new Set<number>()
  for (const step of steps) {
    producingSteps.add(step.step)
  }

  const checkedVars = new Set<string>()
  for (const step of steps) {
    const prompt = step.params?.prompt
    if (typeof prompt !== 'string') continue

    const dependSet = new Set(step.depends_on || [])
    let match: RegExpExecArray | null
    STEP_VAR_REGEX.lastIndex = 0
    while ((match = STEP_VAR_REGEX.exec(prompt)) !== null) {
      const sourceStepNum = Number(match[1])
      const varKey = `${step.step}|${match[0]}`
      if (checkedVars.has(varKey)) continue
      checkedVars.add(varKey)

      if (!producingSteps.has(sourceStepNum)) {
        issues.push({
          step: step.step,
          description: `步骤${step.step}引用了不存在的步骤${sourceStepNum}的输出`,
          missingVar: match[0],
          severity: 'error'
        })
      } else if (!dependSet.has(sourceStepNum)) {
        issues.push({
          step: step.step,
          description: `步骤${step.step}使用了步骤${sourceStepNum}的输出，但未在depends_on中声明`,
          missingVar: match[0],
          severity: 'warning'
        })
      }
    }

    const allParams = JSON.stringify(step.params || {})
    STEP_VAR_REGEX.lastIndex = 0
    while ((match = STEP_VAR_REGEX.exec(allParams)) !== null) {
      const sourceStepNum = Number(match[1])
      const varKey = `${step.step}|${match[0]}|p`
      if (checkedVars.has(varKey)) continue
      checkedVars.add(varKey)

      if (!producingSteps.has(sourceStepNum)) {
        issues.push({
          step: step.step,
          description: `步骤${step.step}参数引用了不存在的步骤${sourceStepNum}的输出`,
          missingVar: match[0],
          severity: 'error'
        })
      }
    }
  }

  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')
  const ok = errors.length === 0
  const summary = ok
    ? `✅ 数据流正常：${steps.length}个步骤变量传递完整${warnings.length > 0 ? `，${warnings.length}个警告` : ''}`
    : `❌ 数据流异常：${errors.length}个变量断头`

  return { ok, issues, summary }
}

export function computeStepOutputHash(output: string): string {
  return structHash(output.substring(0, 1000))
}

export function findDirtySteps(
  manifest: L2ToolManifest,
  cachedFingerprint: ExecutionFingerprint,
  currentStepOutputs: Partial<Record<number, string>>
): Set<number> {
  // P1-14 修复：脏步沿 dependents 向下游传播。原实现反向标记 depends_on 上游——
  // 上游输出未变其缓存仍有效，而真正因输入变化而失效的下游消费者反而不被标脏。
  const dirty = new Set<number>()
  const steps = manifest.execution.dagPlan?.steps || []
  const dependents = new Map<number, number[]>()
  for (const step of steps) {
    for (const dep of step.depends_on || []) {
      const list = dependents.get(dep) || []
      list.push(step.step)
      dependents.set(dep, list)
    }
  }
  const queue: number[] = []
  for (const step of steps) {
    const currentOutput = currentStepOutputs[step.step]
    if (!currentOutput) continue
    if (computeStepOutputHash(currentOutput) !== cachedFingerprint.stepHashes[step.step]) {
      dirty.add(step.step)
      queue.push(step.step)
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const next of dependents.get(cur) || []) {
      if (!dirty.has(next)) {
        dirty.add(next)
        queue.push(next)
      }
    }
  }
  return dirty
}

const MODEL_TIER_CONFIG: Record<string, { maxTokens: number; temperature: number }> = {
  nano: { maxTokens: 512, temperature: 0.1 },
  mini: { maxTokens: 1024, temperature: 0.3 },
  standard: { maxTokens: 4096, temperature: 0.5 },
  pro: { maxTokens: 8192, temperature: 0.7 }
}

export function getTierConfig(tier?: string): { maxTokens: number; temperature: number } {
  return MODEL_TIER_CONFIG[tier || 'standard'] || MODEL_TIER_CONFIG.standard
}

export function computeStepPlan(
  steps: L2DagStep[],
  dirtySteps: Set<number>,
  skipSteps: Set<number>,
  cachedResults: Record<number, string> | null
): { willExecute: L2DagStep[]; willReuse: L2DagStep[]; willSkip: L2DagStep[] } {
  const willExecute: L2DagStep[] = []
  const willReuse: L2DagStep[] = []
  const willSkip: L2DagStep[] = []

  for (const step of steps) {
    if (skipSteps.has(step.step)) {
      willSkip.push(step)
    } else if (dirtySteps.has(step.step)) {
      willExecute.push(step)
    } else if (cachedResults && cachedResults[step.step] && !NO_CACHE_REUSE_TOOLS.has(step.tool)) {
      // P1-15 修复：原仅排除 shell_exec，file_write/create_docx 等副作用工具结果
      // 被跨执行复用=假成功；统一走 NO_CACHE_REUSE_TOOLS
      willReuse.push(step)
    } else {
      willExecute.push(step)
    }
  }

  return { willExecute, willReuse, willSkip }
}

export function formatStepPlanVisualization(
  steps: L2DagStep[],
  plan: { willExecute: L2DagStep[]; willReuse: L2DagStep[]; willSkip: L2DagStep[] },
  parallelGroups: L2DagStep[][]
): string {
  const lines: string[] = []
  for (let g = 0; g < parallelGroups.length; g++) {
    const group = parallelGroups[g]
    const labels = group.map(s => {
      if (plan.willSkip.includes(s)) return `${s.step}. ${s.description} ⏭️跳过`
      if (plan.willReuse.includes(s)) return `${s.step}. ${s.description} ♻️复用缓存`
      return `${s.step}. ${s.description} ▶️执行`
    })
    lines.push(`并行组${g + 1}: ${labels.join(' | ')}`)
  }
  return lines.join('\n')
}

export function computeParallelGroups(steps: L2DagStep[], skipSteps: Set<number>): L2DagStep[][] {
  const active = steps.filter(s => !skipSteps.has(s.step))
  const done = new Set<number>()
  const groups: L2DagStep[][] = []

  while (done.size < active.length) {
    const ready = active.filter(s => {
      if (done.has(s.step)) return false
      return (s.depends_on || []).every(d => done.has(d) || skipSteps.has(d))
    })
    if (ready.length === 0) break
    groups.push(ready)
    for (const s of ready) done.add(s.step)
  }

  return groups
}

const VALIDATION_CACHE_TTL = 24 * 60 * 60 * 1000
const validationCache = new Map<string, ValidationCacheEntry>()

export function getValidationCacheKey(skillId: string, targetFile: string, operation: string, userInput?: string): string {
  // P1-18 修复：审核缓存键必须包含用户输入指纹，否则同一 skill|file|operation
  // 在 24h TTL 内会跨意图复用 intent_match 结论（如"删掉它"与"备份它"同键）
  if (userInput !== undefined && userInput !== '') {
    return `${skillId}|${targetFile}|${operation}|${structHash(userInput.substring(0, 500))}`
  }
  return `${skillId}|${targetFile}|${operation}`
}

export function lookupValidationCache(key: string): ValidationResult | null {
  const entry = validationCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > VALIDATION_CACHE_TTL) {
    validationCache.delete(key)
    return null
  }
  return { ...entry.result, from_cache: true }
}

export function saveValidationCache(key: string, result: ValidationResult): void {
  validationCache.set(key, { key, result: { ...result }, timestamp: Date.now() })
  if (validationCache.size > 500) {
    const oldest = [...validationCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (let i = 0; i < 50; i++) validationCache.delete(oldest[i][0])
  }
}
