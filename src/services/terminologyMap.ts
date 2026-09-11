import type { CommandPaletteResult } from '@/models'

const TERMINOLOGY_MAP: Record<string, { technical: string; plain: string }> = {
  circuitBreaker: { technical: '熔断器', plain: '连接保护' },
  debugProbe: { technical: '调试探针', plain: '执行记录' },
  gravityWeight: { technical: '引力权重', plain: '显示优先级' },
  l0RuleHit: { technical: 'L0规则命中', plain: '快速模式匹配' },
  l05KeywordMatch: { technical: 'L0.5关键词匹配', plain: '关键词识别' },
  smartRouter: { technical: 'SmartRouter', plain: '智能路由' },
  fingerprintCache: { technical: '执行指纹缓存', plain: '结果缓存' },
  semanticCache: { technical: '语义缓存', plain: '相似问题缓存' },
  dagPipeline: { technical: 'DAG流水线', plain: '多步工作流' },
  raap: { technical: 'RaaP', plain: '分步执行计划' },
  cascadeDegrade: { technical: '级联降级', plain: '自动降级处理' },
  factGuard: { technical: 'FactGuard', plain: '事实校验' },
  constraintConfirm: { technical: 'ConstraintConfirmCard', plain: '高风险操作确认' },
  macroExecution: { technical: '宏执行', plain: '组合执行' },
  pipelineExecutor: { technical: 'Pipeline Executor', plain: '工作流引擎' },
  macroExecutor: { technical: 'Macro Executor', plain: '组合执行器' },
  dualEngineValidator: { technical: 'DualEngineValidator', plain: '双重安全审核' },
  zeroTokenLearner: { technical: 'Zero-Token Learner', plain: '智能节省学习' },
  piniaStore: { technical: 'Pinia Store', plain: '数据存储' },
  ipcCommunication: { technical: 'IPC通信', plain: '进程间通信' },
}

export function t(termKey: string, style: 'technical' | 'plain' = 'plain'): string {
  const entry = TERMINOLOGY_MAP[termKey]
  if (!entry) return termKey
  return entry[style] ?? entry.plain
}

export function getAllTerms(): Record<string, { technical: string; plain: string }> {
  return { ...TERMINOLOGY_MAP }
}
