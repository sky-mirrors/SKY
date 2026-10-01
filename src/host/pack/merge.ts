import type { PackExecutionManifest } from './types'
import type { L2ToolManifest } from '@/models'

/**
 * 2026-10-01：把已挂载 pack 自带的执行层 manifest 并入路由候选集
 * （用户裁定「下载后自动接到路由，不等待认领」——热插拔的基本语义）。
 *
 * 合并语义（三条边界，与 test/unit/packManifestMerge.spec.ts 一一对应）：
 * 1. pack 同时提供 `routing` 与 `execution` ⇒ 视为**可执行供给**：
 *    同 id 时字段级覆盖内置（pack 优先，identity 合并保留内置的 author/templateId 等），
 *    新 id 直接新增；
 * 2. 只写 `identity`（旧的「认领」写法）⇒ **跳过**，内置表不动 —— 对既有
 *    finance / hr / legal 三个 pack 的向后兼容（它们的 manifests.json 只有 identity，
 *    实现仍在内置表里）；
 * 3. 纯函数：不修改任何入参，返回新数组。
 *
 * 之所以要第 1 条的两字段判定：只有 identity 的「供给」若被当成新 manifest 塞进候选集，
 * 会得到一个缺 routing/execution 的半截 manifest，让下游匹配期炸掉。
 */
export function mergePackManifests(
  builtin: L2ToolManifest[],
  packManifests: PackExecutionManifest[]
): L2ToolManifest[] {
  if (packManifests.length === 0) return builtin.slice()

  const byId = new Map<string, L2ToolManifest>(builtin.map(m => [m.identity.id, m]))

  for (const pm of packManifests) {
    const id = pm?.identity?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (!isExecutableSupply(pm)) continue

    const base = byId.get(id)
    byId.set(
      id,
      base
        ? ({ ...base, ...pm, identity: { ...base.identity, ...pm.identity } } as L2ToolManifest)
        : (pm as unknown as L2ToolManifest)
    )
  }

  return [...byId.values()]
}

/** 可执行供给判定：必须自带 routing 与 execution，否则只算「认领」 */
function isExecutableSupply(pm: PackExecutionManifest): boolean {
  return Boolean(pm.routing && pm.execution)
}
