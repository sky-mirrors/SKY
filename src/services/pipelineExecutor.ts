import { Pipeline, PipelineStep, NodeHandler, NodeHandlerContext, ModelGatewayAdapter, MemoryAdapter, KnowledgeAdapter, ProbeSource } from '@/models'
import { hybridSearch, knowledgeAdapter } from './knowledgeBase'
import { memoryAdapter, getContextWindow, addMessage } from './memory'
import { compileToChain } from './promptTranslator'
import { debugLog } from '@/services/debugLog'
import { globalBus } from '@/kernel/bus'
import { beautify } from './resultBeautifier'

const handlerRegistry: Map<string, NodeHandler> = new Map()

export function registerHandler(handler: NodeHandler): void {
  handlerRegistry.set(handler.id, handler)
}

export function getHandler(id: string): NodeHandler | undefined {
  return handlerRegistry.get(id)
}

export function getAllHandlers(): NodeHandler[] {
  return Array.from(handlerRegistry.values())
}

const knowledgeFeederHandler: NodeHandler = {
  id: 'l1-knowledge-feeder',
  inputSchema: [
    { name: 'query', type: 'string', required: true, description: '检索查询' }
  ],
  outputSchema: [
    { name: 'results', type: 'array', required: true, description: '检索结果文本列表' }
  ],
  async run(ctx) {
    const query = (ctx.input.query as string) || ''
    const results = await knowledgeAdapter.search(query, 5)
    ctx.onProgress(`知识库检索: ${query} → ${results.length}条结果`)
    return { results: results.map(r => r.text), source: results.map(r => r.source) }
  }
}

const modelGatewayHandler: NodeHandler = {
  id: 'l1-model-gateway',
  inputSchema: [
    { name: 'prompt', type: 'string', required: true, description: '提示词' },
    { name: 'system', type: 'string', required: false, description: '系统提示词' }
  ],
  outputSchema: [
    { name: 'response', type: 'string', required: true, description: 'AI回复' }
  ],
  async run(ctx) {
    let prompt = (ctx.input.prompt as string) || ''
    const context = (ctx.input._context as string) || ''
    if (!prompt && context) prompt = context
    const system = (ctx.input.system as string) || '你是一个企业AI助手。'
    ctx.onProgress(`调用模型: ${prompt.slice(0, 50)}...`)
    if (!prompt.trim()) return { response: '(无有效输入，跳过模型调用)' }
    const response = await Promise.race([
      ctx.gateway.chatCompletion([
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('模型调用超时(60s)')), 60000))
    ])
    return { response }
  }
}

const taskTranslatorHandler: NodeHandler = {
  id: 'l1-task-translator',
  inputSchema: [
    { name: 'input', type: 'string', required: true, description: '自然语言任务描述' }
  ],
  outputSchema: [
    { name: 'chain', type: 'object', required: true, description: '编译后的PromptChain' }
  ],
  async run(ctx) {
    const input = (ctx.input.input as string) || ''
    ctx.onProgress(`编译任务: ${input.slice(0, 50)}...`)
    const chain = await compileToChain(input)
    return { chain }
  }
}

const workspaceMemoryHandler: NodeHandler = {
  id: 'l1-workspace-memory',
  inputSchema: [
    { name: 'projectId', type: 'string', required: false, description: '项目ID' },
    { name: 'tokenBudget', type: 'number', required: false, description: 'token预算' }
  ],
  outputSchema: [
    { name: 'context', type: 'string', required: true, description: '上下文文本' }
  ],
  async run(ctx) {
    const projectId = (ctx.input.projectId as string) || 'default'
    const tokenBudget = (ctx.input.tokenBudget as number) || 4000
    ctx.onProgress(`加载记忆: ${projectId}`)
    const { messages, summary } = getContextWindow(projectId, tokenBudget)
    const context = summary
      ? `[摘要] ${summary}\n\n${messages.map(m => `${m.role}: ${m.content}`).join('\n')}`
      : messages.map(m => `${m.role}: ${m.content}`).join('\n')
    return { context }
  }
}

const resultBeautifierHandler: NodeHandler = {
  id: 'l1-result-beautifier',
  inputSchema: [
    { name: 'content', type: 'string', required: true, description: 'Markdown内容' },
    { name: 'format', type: 'string', required: false, description: '输出格式(html/email/docx/pptx)' }
  ],
  outputSchema: [
    { name: 'output', type: 'string', required: true, description: '格式化后的内容' }
  ],
  async run(ctx) {
    const content = (ctx.input.content as string) || ''
    const format = (ctx.input.format as string) || 'html'
    ctx.onProgress(`美化输出: ${format}`)
    const output = beautify(content, format as 'html' | 'email' | 'docx' | 'pptx')
    return { output }
  }
}

const pipelineBuilderHandler: NodeHandler = {
  id: 'l1-pipeline-builder',
  inputSchema: [
    { name: 'task', type: 'string', required: true, description: '自然语言任务' }
  ],
  outputSchema: [
    { name: 'plan', type: 'object', required: true, description: '执行计划' }
  ],
  async run(ctx) {
    const task = (ctx.input.task as string) || ''
    ctx.onProgress(`编排流水线: ${task.slice(0, 50)}...`)
    const chain = await compileToChain(task)
    return { plan: chain }
  }
}

registerHandler(knowledgeFeederHandler)
registerHandler(modelGatewayHandler)
registerHandler(taskTranslatorHandler)
registerHandler(workspaceMemoryHandler)
registerHandler(resultBeautifierHandler)
registerHandler(pipelineBuilderHandler)

interface DagNode {
  id: string
  stepIndex: number
  deps: string[]
}

function topologicalSort(nodes: DagNode[]): string[] {
  const inDegree: Record<string, number> = {}
  const adj: Record<string, string[]> = {}
  for (const node of nodes) {
    inDegree[node.id] = node.deps.length
    adj[node.id] = []
  }
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (adj[dep]) adj[dep].push(node.id)
    }
  }

  const queue: string[] = []
  for (const node of nodes) {
    if (inDegree[node.id] === 0) queue.push(node.id)
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    sorted.push(id)
    for (const next of adj[id] || []) {
      inDegree[next]--
      if (inDegree[next] === 0) queue.push(next)
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error('Pipeline DAG has cycles')
  }
  return sorted
}

const CHECKPOINT_KEY = 'holo-pipeline-checkpoints'

interface PipelineCheckpoint {
  pipelineId: string
  completedSteps: string[]
  results: Record<string, Record<string, unknown>>
  startedAt: number
  lastStepAt: number
}

function saveCheckpoint(cp: PipelineCheckpoint) {
  try {
    const all: PipelineCheckpoint[] = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || '[]')
    const idx = all.findIndex(c => c.pipelineId === cp.pipelineId)
    if (idx >= 0) all[idx] = cp
    else all.push(cp)
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(all))
  } catch { /* ignore */ }
}

function loadCheckpoint(pipelineId: string): PipelineCheckpoint | null {
  try {
    const all: PipelineCheckpoint[] = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || '[]')
    return all.find(c => c.pipelineId === pipelineId) ?? null
  } catch (err) {
    debugLog(`[pipelineExecutor] 加载检查点失败: ${String(err).substring(0, 100)}`)
    return null
  }
}

function clearCheckpoint(pipelineId: string) {
  try {
    const all: PipelineCheckpoint[] = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) || '[]')
    const filtered = all.filter(c => c.pipelineId !== pipelineId)
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(filtered))
  } catch { /* ignore */ }
}

export async function executePipeline(
  pipeline: Pipeline,
  onProgress?: (stepId: string, msg: string) => void,
  resumeFromCheckpoint: boolean = false
): Promise<Record<string, string>> {
  const gateway = globalBus.request<ModelGatewayAdapter>('llm:get-gateway', {})

  const pipelineAbortController = new AbortController()
  globalBus.emit('debug:register-abort', pipelineAbortController)

  const stepMap = new Map(pipeline.steps.map((s, i) => [`step-${i}`, s]))
  const dagNodes: DagNode[] = pipeline.steps.map((step, i) => ({
    id: `step-${i}`,
    stepIndex: i,
    deps: i > 0 && pipeline.mode === 'serial' ? [`step-${i - 1}`] : []
  }))

  const sorted = topologicalSort(dagNodes)

  let completedSteps: string[] = []
  const results: Record<string, Record<string, unknown>> = {}
  const stringResults: Record<string, string> = {}

  if (resumeFromCheckpoint) {
    const cp = loadCheckpoint(pipeline.id)
    if (cp) {
      completedSteps = cp.completedSteps
      Object.assign(results, cp.results)
      for (const [key, val] of Object.entries(cp.results)) {
        stringResults[key] = JSON.stringify(val)
      }
    }
  }

  try {
    for (const stepId of sorted) {
    if (completedSteps.includes(stepId)) continue

    const step = stepMap.get(stepId)
    if (!step) continue

    const stepIndex = dagNodes.find(n => n.id === stepId)?.stepIndex ?? 0

    const handler = getHandler(step.toolId)
    if (!handler) {
      const fallback = `Tool ${step.toolId} not registered`
      stringResults[step.outputKey] = fallback
      results[step.outputKey] = { response: fallback }
      completedSteps.push(stepId)
      continue
    }

    const previousContext = Object.entries(results)
      .map(([k, v]) => `[${k}]: ${JSON.stringify(v)}`)
      .join('\n')

    const input: Record<string, unknown> = { ...step.params }
    if (previousContext) {
      input._context = previousContext
    }

    const ctx: NodeHandlerContext = {
      input,
      signal: pipelineAbortController.signal,
      onProgress: (msg: string) => {
        onProgress?.(stepId, msg)
      },
      gateway,
      memory: memoryAdapter,
      knowledge: knowledgeAdapter
    }

    try {
      const result = await handler.run(ctx)
      results[step.outputKey] = result
      const resultKeys = Object.keys(result)
      if (typeof result.response === 'string') {
        stringResults[step.outputKey] = result.response
      } else if (resultKeys.length === 1) {
        const soleVal = result[resultKeys[0]]
        stringResults[step.outputKey] = typeof soleVal === 'string' ? soleVal : JSON.stringify(result)
      } else {
        stringResults[step.outputKey] = JSON.stringify(result)
      }

      if (step.toolId === 'l1-model-gateway' && result.response) {
        addMessage('default', { role: 'assistant', content: result.response as string, timestamp: Date.now() })
      }

      completedSteps.push(stepId)
      saveCheckpoint({
        pipelineId: pipeline.id,
        completedSteps: [...completedSteps],
        results: { ...results },
        startedAt: Date.now(),
        lastStepAt: Date.now()
      })

      try {
        const source: ProbeSource = step.toolId === 'l1-model-gateway' ? 'llm' : step.toolId === 'l1-workspace-memory' ? 'knowledge' : 'mcp'
        globalBus.emit('debug:log-probe', {
          id: `probe-pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          stepNum: stepIndex,
          manifestId: `pipeline-${pipeline.id}`,
          source,
          sourceDetail: `流水线步骤: ${step.toolId}`,
          toolName: step.toolId,
          inputSnapshot: input,
          outputSnapshot: stringResults[step.outputKey] || '',
          timestamp: Date.now(),
          durationMs: 0
        })
      } catch { /* non-critical */ }

      onProgress?.(stepId, `✓ ${step.toolId}`)
    } catch (err) {
      try {
        globalBus.emit('debug:log-probe', {
          id: `probe-pipe-err-${Date.now()}`,
          stepNum: stepIndex,
          manifestId: `pipeline-${pipeline.id}`,
          source: 'error',
          sourceDetail: String(err),
          toolName: step.toolId,
          inputSnapshot: input,
          outputSnapshot: '',
          timestamp: Date.now(),
          durationMs: 0,
          errorStack: err instanceof Error ? err.stack : undefined
          })
      } catch { /* non-critical */ }
      onProgress?.(stepId, `✗ ${step.toolId}: ${String(err)}`)
      stringResults[step.outputKey] = `Error: ${String(err)}`
      throw err
    }
  }

    clearCheckpoint(pipeline.id)
    return stringResults
  } finally {
    globalBus.emit('debug:clear-abort', {})
  }
}
