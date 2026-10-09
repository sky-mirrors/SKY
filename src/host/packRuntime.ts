import { PackLoader, createBuiltinPackSource } from './pack/loader'
import { loadUserPackTree, createUserPackSource, createHybridPackSource } from './pack/userPackSource'
import type { PackExecutionManifest } from './pack/types'

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

/**
 * 2026-10-01：汇总已挂载 pack 自带的执行层 manifest（路由候选集装配用）。
 * 用户裁定「下载后自动接到路由，不等待认领」——装配点把它并入 ctx.allL2Manifests，
 * pack 提供的工具即刻可被漏斗匹配；卸载后自动消失（热插拔可逆）。
 */
export function getPackExecutionManifests(): PackExecutionManifest[] {
  return packLoader.getExecutionManifests()
}

let initPromise: Promise<void> | null = null

export function initPackRuntime(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // 2026-10-01（用户诉求：「领域包应该用户下载后自动接到路由」）：
      // 先把用户 pack 预加载进内存并切到「内置 + 用户」混合源，再统一挂载。
      await installUserPacks()

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

/**
 * 读 `{userData}/holostarmap-packs/<packId>/` 下的用户 pack 并并入数据源。
 * fail-safe：无 IPC 能力 / 目录不存在 / 解析失败 ⇒ 静默保持内置源（用户 pack 是增量能力，
 * 绝不能因为一个坏目录让内置 finance/hr/legal 挂不上）。
 */
async function installUserPacks(): Promise<void> {
  try {
    if (typeof window === 'undefined') return
    const userData = await window.electronAPI?.getUserDataPath?.()
    if (!userData) return
    const tree = await loadUserPackTree(`${userData}/holostarmap-packs`)
    const ids = Object.keys(tree)
    if (ids.length === 0) return
    packLoader.setSource(createHybridPackSource(createBuiltinPackSource(), createUserPackSource(tree)))
    console.info(`[pack-runtime] 已加载 ${ids.length} 个用户 pack：${ids.join('、')}`)
  } catch (err) {
    console.warn('[pack-runtime] 用户 pack 加载失败（不影响内置 pack）：', err)
  }
}

/**
 * 重新读取磁盘上的用户包并挂载（领域包编辑器保存后调用，免去重启应用）。
 *
 * 为什么不复用 `initPackRuntime()`：后者用 `initPromise` 做了「一次性初始化」缓存，
 * 已经有 promise 时直接返回，**不会重跑 installUserPacks**，因此拿不到新写入的包。
 *
 * 幂等性：`mountPack` 对已挂载的包会以 already-mounted 告警跳过，重复调用安全。
 * 返回本次成功挂载的包 id 列表（含既有包——mountPack 对其返回 ok）。
 */
export async function reloadUserPacks(): Promise<{ ok: boolean; packs: string[] }> {
  try {
    await installUserPacks()
    const packs: string[] = []
    for (const packId of packLoader.listPackIds()) {
      const result = await packLoader.mountPack(packId)
      if (result.ok) packs.push(packId)
    }
    console.info(`[pack-runtime] 用户包已重载，当前挂载：${packs.join('、')}`)
    return { ok: true, packs }
  } catch (err) {
    console.warn('[pack-runtime] 用户包重载失败：', err)
    return { ok: false, packs: [] }
  }
}
