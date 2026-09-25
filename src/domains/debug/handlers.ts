import type { HoloEventBus } from '@/kernel/bus'
import { useDebugStore } from '@/stores/debugStore'
import type { ConsoleCategory, ConsoleLogLevel, ProbeSnapshot } from '@/models'

// HoloEventBus.emit() 只达 bus.on() 监听器、registerHandler() 仅 request() 可达；
// debug:* 频道全部走 emit() 发布，故除 registerHandler 外必须桥接 on()（HMR 重挂载先释放旧订阅）

const VALID_CATEGORIES: ConsoleCategory[] = ['system', 'raap', 'llm', 'shell', 'cache', 'rule', 'dialog', 'feedback', 'factguard', 'tool', 'schedule']

type Disposer = (() => void) | null

let _disposeProbe: Disposer = null
let _disposeRecordCost: Disposer = null
let _disposeLogEvent: Disposer = null
let _disposeRegisterAbort: Disposer = null
let _disposeClearAbort: Disposer = null
let _disposeActivate: Disposer = null
let _disposeDeactivate: Disposer = null
let _disposeEnv: Disposer = null
let _disposeUnfreeze: Disposer = null

type DebugEnvironment = { model: string; provider: string; apiReachable: boolean; nodeCount: number; manifestCount: number }

export function registerDebugHandlers(bus: HoloEventBus) {
  const probeHandler = (payload: { snapshot?: ProbeSnapshot; message?: string; level?: ConsoleLogLevel; domain?: ConsoleCategory; detail?: string; traceId?: string }) => {
    const store = useDebugStore()
    if (payload?.snapshot) {
      store.recordProbe(payload.snapshot)
    } else if (payload?.message) {
      store.emitEvent(payload.level ?? 'info', payload.domain ?? 'dialog', payload.message, payload.detail, payload.traceId)
    }
  }
  bus.registerHandler('debug:log-probe', probeHandler)
  _disposeProbe?.()
  _disposeProbe = bus.on('debug:log-probe', probeHandler as (payload: unknown) => unknown)

  // P1-39：stepCosts 查询——probeStep 经 request() 调用，registerHandler 即可达
  bus.registerHandler('debug:get-step-cost', (payload: { stepNum?: number }) => {
    const store = useDebugStore()
    return store.stepCosts[payload?.stepNum ?? -1] ?? undefined
  })

  // P1-40：record-cost 经 emit() 发布 → 必须 on() 桥接（带 tier/category/traceId/local 落记账）
  // M17/M20：local=true 为本地 Ollama 调用，费用记 0
  // G-5：cacheHitTokens 透传真实值（原链路硬编码 0）
  const recordCostHandler = (payload: { promptTokens: number; completionTokens: number; totalTokens: number; category?: string; tier?: string; traceId?: string; local?: boolean; cacheHitTokens?: number }) => {
    if (!payload || typeof payload.promptTokens !== 'number') return
    const store = useDebugStore()
    store.recordTokenUsage(payload.promptTokens, payload.completionTokens, payload.totalTokens, payload.category, payload.tier, payload.traceId, payload.local, payload.cacheHitTokens)
  }
  bus.registerHandler('debug:record-cost', recordCostHandler)
  _disposeRecordCost?.()
  _disposeRecordCost = bus.on('debug:record-cost', recordCostHandler as (payload: unknown) => unknown)

  // P1-45：log-event 经 emit() 发布 → on() 桥接；tag 须映射到合法 ConsoleCategory
  const logEventHandler = (payload: { level?: ConsoleLogLevel; tag?: string; message?: string; detail?: string; traceId?: string }) => {
    if (!payload?.message) return
    const store = useDebugStore()
    const tag = payload.tag as ConsoleCategory | undefined
    const category = tag && VALID_CATEGORIES.includes(tag) ? tag : 'system'
    store.emitEvent(payload.level ?? 'info', category, payload.message, payload.detail, payload.traceId)
  }
  bus.registerHandler('debug:log-event', logEventHandler)
  _disposeLogEvent?.()
  _disposeLogEvent = bus.on('debug:log-event', logEventHandler as (payload: unknown) => unknown)

  // P1-45：register-abort / clear-abort 经 emit() 发布 → on() 桥接（payload 为 AbortController 实例）
  const registerAbortHandler = (payload: unknown) => {
    if (payload instanceof AbortController) {
      useDebugStore().registerAbortController(payload)
    }
  }
  bus.registerHandler('debug:register-abort', registerAbortHandler)
  _disposeRegisterAbort?.()
  _disposeRegisterAbort = bus.on('debug:register-abort', registerAbortHandler)

  // B-09：带 payload（AbortController）时只注销该任务自己的控制器；
  // 无 payload 保持旧语义（清空全部），供全局终止使用
  const clearAbortHandler = (payload: unknown) => {
    const store = useDebugStore()
    if (payload instanceof AbortController) {
      store.unregisterAbortController(payload)
    } else {
      store.clearAbortController()
    }
  }
  bus.registerHandler('debug:clear-abort', clearAbortHandler)
  _disposeClearAbort?.()
  _disposeClearAbort = bus.on('debug:clear-abort', clearAbortHandler)

  bus.registerHandler('debug:is-enabled', () => {
    const store = useDebugStore()
    return store.enabled
  })

  // 2026-09-25（机制体检）：`/debug` 斜杠命令（dialogStore.sendMessage）emit 的 4 条广播
  // 此前**全仓无人监听** ⇒ 命令只打印"🔍 调试模式已开启 — 输入 /debug 关闭"却什么都没发生（谎报），
  // 真正的开关是 debugStore 的方法（App.vue / DialogPanel / DebugWindowPage 直接调）。
  // 按本文件既定模式桥接 bus → store（emit 只达 on()；HMR 重挂载先释放旧订阅）。
  const activateHandler = () => {
    useDebugStore().activate()
  }
  bus.registerHandler('debug:activate', activateHandler)
  _disposeActivate?.()
  _disposeActivate = bus.on('debug:activate', activateHandler)

  const deactivateHandler = () => {
    useDebugStore().deactivate()
  }
  bus.registerHandler('debug:deactivate', deactivateHandler)
  _disposeDeactivate?.()
  _disposeDeactivate = bus.on('debug:deactivate', deactivateHandler)

  const envHandler = (payload: { environment?: DebugEnvironment }) => {
    if (payload?.environment) useDebugStore().updateEnvironment(payload.environment)
  }
  bus.registerHandler('debug:update-environment', envHandler)
  _disposeEnv?.()
  _disposeEnv = bus.on('debug:update-environment', envHandler as (payload: unknown) => unknown)

  const unfreezeHandler = () => {
    useDebugStore().unfreezeBuffer()
  }
  bus.registerHandler('debug:unfreeze-buffer', unfreezeHandler)
  _disposeUnfreeze?.()
  _disposeUnfreeze = bus.on('debug:unfreeze-buffer', unfreezeHandler)
}
