import { PackLoader } from './pack/loader'

/**
 * pack 运行时（P3.5 约束主路径切换，R12）：
 * 生产唯一 PackLoader 实例；App 挂载时 initPackRuntime()（幂等）装载全部内置 pack，
 * 约束生产注入路径自此由 pack 管线接管（内置 LEGAL/FINANCE 数组退役为等价对照基线）。
 * 单 pack 挂载失败仅告警并继续（PackLoader 内部已发 pack:mount-failed，事务回滚不污染 KB）。
 */

export const packLoader = new PackLoader()

/** P1-13：语义缓存 packId 归因入口（未挂载/无匹配 domain 时返回 undefined） */
export function getPackIdForDomain(domain: string): string | undefined {
  return packLoader.getPackIdForDomain(domain)
}

/** M16：manifest→packId 归因转发（pack execution/manifests.json 声明；未声明/未挂载返回 undefined） */
export function getPackIdForManifest(manifestId: string): string | undefined {
  return packLoader.getPackIdForManifest(manifestId)
}

/** M16：pack 竞标权重转发（manifest.weight ?? 1.0） */
export function getPackWeight(packId: string): number {
  return packLoader.getWeight(packId)
}

/** A2-9：pack 已注入约束 id 集转发（快照副本；未挂载返回空数组） */
export function getMountedConstraintIds(packId: string): string[] {
  return packLoader.getMountedConstraintIds(packId)
}

let initPromise: Promise<void> | null = null

export function initPackRuntime(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      for (const packId of packLoader.listPackIds()) {
        const result = await packLoader.mountPack(packId)
        if (!result.ok) {
          console.warn(`[pack-runtime] pack ${packId} 挂载失败: ${result.error.phase}/${result.error.reason}，已跳过`)
        }
      }
    })().catch(err => {
      // 失败允许重试（下次调用重新初始化；已挂载 pack 会以 already-mounted 告警跳过）
      initPromise = null
      throw err
    })
  }
  return initPromise
}
