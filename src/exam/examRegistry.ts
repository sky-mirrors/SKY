// EXAM-1：考试流量注册表（原 ACCEPTANCE-SPEC「考试器实现约束」；见 docs/60-测试与验收.md）。
// 主路径发题入口（dialogStore.sendMessage）无 taskType 通道——主路径与宏执行路径的
// LLM 调用只携带 traceId，apiStore 依此注册表反查 exam 流量做学习回路隔离
// （语义缓存/预算/ZOL），但 record-cost 照常发射：监考归因依赖 traceId 成本流，
// 考试行为等价真实使用（学习不污染、记账正常）。
const examTraceIds = new Set<string>()

export function registerExamTrace(traceId: string): void {
  if (traceId) examTraceIds.add(traceId)
}

export function releaseExamTrace(traceId: string): void {
  examTraceIds.delete(traceId)
}

export function clearExamTraces(): void {
  examTraceIds.clear()
}

export function isExamTraceId(traceId?: string): boolean {
  return !!traceId && examTraceIds.has(traceId)
}

export function activeExamTraceCount(): number {
  return examTraceIds.size
}
