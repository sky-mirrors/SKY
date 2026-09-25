/**
 * L1 能力注册表与 requiredL1 完整性审计（G-11 修复，2026-09-25）
 *
 * G-11 现状（快照 §〇 已核实）：`src/data/l2Manifests.ts` 的 `routing.requiredL1` 声明了 27 处、
 * 共 9 个不同 L1 节点 id，但**全仓零消费者**——声明纯装饰。逐条核对后还发现：
 *   - `l1-media-ops` **全仓零定义**（悬空引用）：唯一声明它的 manifest「音视频处理」本应指向真实存在的
 *     `media_process` 原生工具能力，但该 id 从未在任何地方登记；
 *   - `l1-doc-convert` / `l1-image-ops` 只由 `checkL1Capability` 产出为 `nodeId`，无节点定义。
 *
 * 本模块给出 requiredL1 的**权威定义点**：任何 manifest 声明的 L1 能力都必须落在此表，否则视为悬空引用。
 * 挂载期由 `auditRequiredL1` 以 warn 形式暴露（fail-visible，绝不静默），并在 `finalizeRaapPlan` 把
 * requiredL1 消费进 `plan.needs`（声明进入真实产出，不再只写不读）。
 */

export const L1_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  'l1-model-gateway': '大模型网关（生成/翻译/改写）',
  'l1-knowledge-feeder': '知识库检索注入',
  'l1-task-translator': '任务翻译与参数解析',
  'l1-pipeline-builder': '管道/DAG 编排',
  'l1-workspace-memory': '工作区记忆',
  'l1-result-beautifier': '结果美化与排版',
  'l1-doc-convert': '文档转 PDF（应用内渲染）',
  'l1-image-ops': '图片批量处理',
  'l1-media-ops': '音视频处理'
})

export function isKnownL1Capability(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(L1_CAPABILITIES, id)
}

export interface RequiredL1Violation {
  manifestId: string
  manifestName: string
  missing: string[]
}

interface ManifestLike {
  identity?: { id?: string; name?: string }
  routing?: { requiredL1?: string[] }
}

/**
 * 审计 requiredL1 完整性：返回引用了**未登记** L1 能力的 manifest（无违规则返回空数组）。
 * 纯函数，供挂载期校验与单测使用。
 */
export function auditRequiredL1(manifests: ManifestLike[]): RequiredL1Violation[] {
  const out: RequiredL1Violation[] = []
  for (const m of manifests || []) {
    const req = m?.routing?.requiredL1
    if (!req || req.length === 0) continue
    const missing = req.filter(id => !isKnownL1Capability(id))
    if (missing.length > 0) {
      out.push({
        manifestId: m.identity?.id || '(unknown)',
        manifestName: m.identity?.name || '(unknown)',
        missing
      })
    }
  }
  return out
}

/** 把 requiredL1 声明映射为可读标签（plan.needs 展示用）；未登记的 id 原样保留，便于暴露问题。 */
export function describeRequiredL1(ids: string[] | undefined): string[] {
  if (!ids || ids.length === 0) return []
  return ids.map(id => L1_CAPABILITIES[id] ?? id)
}
