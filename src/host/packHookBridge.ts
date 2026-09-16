import { globalBus } from '@/kernel/bus'
import type { HoloEventBus } from '@/kernel/bus'
import type { HookContext, VetoGatePosition, VetoResult } from '@/kernel/hooks'
import type { DefaultKernelPlugin } from '@/kernels/default/plugin'
import type { ConstraintCheckContext, ConstraintResult } from '@/models'
import { getConstraintById } from '@/services/domainConstraints'
import { extractEntities } from '@/services/nerExtractor'
import type { PackLoader } from './pack/loader'
import type { PackLifecycleEvent, PackManifest } from './pack/types'
import { packLoader } from './packRuntime'
import { kernelRegistry } from './kernelRuntime'

/**
 * A2-9 / 规格 5.4：pack veto 钩子桥。
 *
 * 把 pack 声明的 capabilities.hooks.veto 落地为激活内核 HookRunner 中的 VetoHook：
 * - pack:mounted → 注册（每声明 gate 一条，pluginId=packId，hasPermission=true——mount 时 M1 校验已过）
 * - pack:unmounted → unregisterPlugin
 * - kernel:activated / kernel:switched → 全量重放（M4 换内核 = HookRunner 重建，钩子表清空）
 * - check 只读检查：直接调 constraint.check(ctx)，不经过 runConstraints（避免 recordConstraintTrigger 计数副作用）
 * - fail-open 铁律：桥内任何失败只 console.warn，不阻塞 pack mount / 内核激活 / 主流程
 */

/** 内核侧鸭子接口：只要有 getHooks 即可注册（前向兼容非 DefaultKernelPlugin 内核） */
type VetoCapableKernel = { id: string } & Partial<Pick<DefaultKernelPlugin, 'getHooks'>>

export interface BridgeRegistryLike {
  getActive(): VetoCapableKernel | undefined
}

export interface PackHookBridgeOptions {
  loader?: PackLoader
  registry?: BridgeRegistryLike
  bus?: HoloEventBus
}

/** payload 归一为文本：pre-output 门传 string；pre-execute 门传 TaskPlan 对象（序列化文本） */
function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload === null || payload === undefined) return ''
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

/** 严重度映射：error→block、warning→warn、info→不构成 veto */
function packVetoCheck(packId: string, loader: PackLoader): (payload: unknown, ctx: HookContext) => VetoResult {
  return (payload: unknown): VetoResult => {
    const text = payloadToText(payload)
    const checkCtx: ConstraintCheckContext = {
      entities: [],
      sourceText: text,
      outputText: text,
      stepResults: {},
      manifestRoles: []
    }
    try {
      checkCtx.entities = extractEntities(text)
    } catch { /* 实体抽取失败 → 空实体集继续（关键词触发器仍可用） */ }

    let worst: 'block' | 'warn' | null = null
    let reason = ''
    let humanJudgmentPrompt: string | undefined
    for (const id of loader.getMountedConstraintIds(packId)) {
      const constraint = getConstraintById(id)
      if (!constraint) continue
      if (constraint.status !== 'active' && constraint.status !== 'testing') continue
      let result: ConstraintResult | null
      try {
        // 只读检查：绕开 runConstraints 的 recordConstraintTrigger 计数副作用
        result = constraint.check(checkCtx)
      } catch {
        continue
      }
      if (!result || !result.triggered) continue
      const prompt = result.humanJudgmentPrompt || constraint.humanJudgmentPrompt
      if (result.severity === 'error') {
        if (worst !== 'block') {
          worst = 'block'
          reason = result.message
        }
      } else if (result.severity === 'warning' && worst === null) {
        worst = 'warn'
        reason = result.message
      } else {
        // info 级命中 → 不构成 veto
        continue
      }
      if (prompt && !humanJudgmentPrompt) humanJudgmentPrompt = prompt
    }

    if (worst === null) return { veto: false, severity: 'warn', reason: '' }
    return { veto: true, severity: worst, reason, ...(humanJudgmentPrompt ? { humanJudgmentPrompt } : {}) }
  }
}

export class PackHookBridge {
  private readonly loader: PackLoader
  private readonly registry: BridgeRegistryLike
  private readonly bus: HoloEventBus
  private disposers: Array<() => void> = []
  private started = false

  constructor(opts: PackHookBridgeOptions = {}) {
    this.loader = opts.loader ?? packLoader
    this.registry = opts.registry ?? kernelRegistry
    this.bus = opts.bus ?? globalBus
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.disposers.push(this.loader.onLifecycle(e => this.onPackLifecycle(e)))
    this.disposers.push(this.bus.on('kernel:activated', () => this.replayAll()))
    this.disposers.push(this.bus.on('kernel:switched', () => this.replayAll()))
    // 覆盖"pack 先挂载、bridge 后启动"时序（反向时序由激活/切换事件重放覆盖）
    this.replayAll()
  }

  stop(): void {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch { /* non-critical */ }
    }
    this.disposers = []
    this.started = false
  }

  /** kernel:activated / kernel:switched → 重放全部已挂载 pack（新 HookRunner 为空表） */
  replayAll(): void {
    try {
      const mounted = this.loader.listMounted()
      for (const manifest of mounted) {
        this.registerPack(manifest)
      }
    } catch (err) {
      console.warn(`[pack-hook-bridge] replay failed: ${(err as Error).message}`)
    }
  }

  private onPackLifecycle(e: PackLifecycleEvent): void {
    try {
      if (e.type === 'pack:mounted') this.registerPackById(e.packId)
      else if (e.type === 'pack:unmounted') this.unregisterPack(e.packId)
      // pack:reloaded 由其内部的 mounted/unmounted 事件对覆盖；mount-failed 无需处理
    } catch (err) {
      console.warn(`[pack-hook-bridge] lifecycle handler failed (${e.type}): ${(err as Error).message}`)
    }
  }

  private registerPackById(packId: string): void {
    const manifest = this.loader.listMounted().find(m => m.id === packId)
    if (!manifest) return
    this.registerPack(manifest)
  }

  /** 注册单个 pack 的 veto 声明（先注销同 id 旧钩子，保证重放幂等） */
  registerPack(manifest: PackManifest): void {
    const gates = manifest.capabilities?.hooks?.veto ?? []
    if (gates.length === 0) return
    const kernel = this.registry.getActive()
    if (!kernel || typeof kernel.getHooks !== 'function') return
    try {
      const hooks = kernel.getHooks()
      hooks.unregisterPlugin(manifest.id)
      for (const position of gates) {
        hooks.registerVeto({
          pluginId: manifest.id,
          position: position as VetoGatePosition,
          hasPermission: true,
          check: packVetoCheck(manifest.id, this.loader)
        })
      }
    } catch (err) {
      console.warn(`[pack-hook-bridge] register veto hooks failed (pack=${manifest.id}): ${(err as Error).message}`)
    }
  }

  private unregisterPack(packId: string): void {
    try {
      const kernel = this.registry.getActive()
      if (!kernel || typeof kernel.getHooks !== 'function') return
      kernel.getHooks().unregisterPlugin(packId)
    } catch (err) {
      console.warn(`[pack-hook-bridge] unregister veto hooks failed (pack=${packId}): ${(err as Error).message}`)
    }
  }
}

let defaultBridge: PackHookBridge | null = null

/** App 启动接入：在 initKernelRuntime() 与 initPackRuntime() 完成后调用（幂等） */
export function initPackHookBridge(): void {
  if (defaultBridge) return
  defaultBridge = new PackHookBridge()
  defaultBridge.start()
}
