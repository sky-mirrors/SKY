import { defineStore } from 'pinia'
import { ref } from 'vue'
import { globalBus } from '@/kernel/bus'
import { vault } from '@/vault'
import { kernelRegistry } from '@/host/kernelRuntime'
import { packLoader } from '@/host/packRuntime'
import { useDialogStore } from '@/stores/dialogStore'

/**
 * 热插拔运行时状态镜像（R16 工作台右栏数据源）：
 * - kernelRegistry / packLoader / funnel 主路径开关的单例状态快照 + 总线事件镜像
 * - 事件驱动（bus 事件推送 + refresh() 主动拉取双通道），eventLog 上限 50 条
 * - 纯 store 层（node 环境可单测），组件只读不订阅总线
 */

export interface HotplugEvent {
  ts: number
  kind: 'kernel' | 'pack' | 'funnel'
  text: string
  level: 'info' | 'warn' | 'error'
}

export interface FunnelRoutedRecord {
  handled: boolean
  kind: string
  source?: string
  intent?: string
  autoExecutable?: boolean
  ts: number
}

const EVENT_LOG_LIMIT = 50

export const useHotplugStore = defineStore('hotplug', () => {
  const activeKernelId = ref('')
  const kernelState = ref('idle')
  const kernelInFlight = ref(0)
  const kernelQueueLen = ref(0)
  const allPackIds = ref<string[]>([])
  const mountedPackIds = ref<string[]>([])
  const funnelMainEnabled = ref(true)
  const lastRouted = ref<FunnelRoutedRecord | null>(null)
  const eventLog = ref<HotplugEvent[]>([])

  let disposers: Array<() => void> = []
  let initialized = false

  function pushEvent(kind: HotplugEvent['kind'], text: string, level: HotplugEvent['level'] = 'info'): void {
    eventLog.value.unshift({ ts: Date.now(), kind, text, level })
    if (eventLog.value.length > EVENT_LOG_LIMIT) {
      eventLog.value.length = EVENT_LOG_LIMIT
    }
  }

  /** 单例状态快照（init 时 + 每个 bus 事件后刷新） */
  function refresh(): void {
    activeKernelId.value = kernelRegistry.getActiveId() ?? ''
    kernelState.value = kernelRegistry.getState()
    kernelInFlight.value = kernelRegistry.inFlightCount()
    kernelQueueLen.value = kernelRegistry.queueLength()
    allPackIds.value = packLoader.listPackIds()
    mountedPackIds.value = packLoader.listMounted().map(m => m.id)
  }

  async function refreshFunnelFlag(): Promise<void> {
    try {
      funnelMainEnabled.value = (await vault.read('config', 'holo-funnel-main')) !== '0'
    } catch {
      funnelMainEnabled.value = true
    }
  }

  /** 工作台导航开关：写 vault + 清 dialogStore 闭包缓存，立即生效（无需重载） */
  function toggleFunnelMain(): void {
    const next = !funnelMainEnabled.value
    vault.writeThrough('config', 'holo-funnel-main', next ? '1' : '0')
    funnelMainEnabled.value = next
    useDialogStore().refreshFunnelMainFlag()
    pushEvent('funnel', next ? 'funnel 主路径已开启' : 'funnel 主路径已关闭（回滚旧六层内联）', next ? 'info' : 'warn')
  }

  /** 订阅总线事件（幂等；App 挂载工作台时调用一次） */
  function init(): void {
    if (initialized) return
    initialized = true
    refresh()
    refreshFunnelFlag()

    disposers.push(
      globalBus.on('kernel:activated', p => {
        refresh()
        pushEvent('kernel', `内核激活：${(p as { id: string }).id}`)
      }),
      globalBus.on('kernel:switched', p => {
        refresh()
        const d = p as { from?: string; to: string }
        pushEvent('kernel', `内核切换：${d.from ?? '(空)'} → ${d.to}`)
      }),
      globalBus.on('kernel:fatal', p => {
        refresh()
        pushEvent('kernel', `内核空缺（${(p as { failedId: string }).failedId} 挂载失败且旧内核不可用）`, 'error')
      }),
      globalBus.on('kernel:zombie', p => {
        const d = p as { id: string; error: string }
        pushEvent('kernel', `内核僵尸：${d.id}（${d.error}）`, 'error')
      }),
      globalBus.on('kernel:mount-failed', p => {
        pushEvent('kernel', `内核挂载失败：${(p as { id: string }).id}`, 'warn')
      }),
      globalBus.on('kernel:switch-cancelled', p => {
        pushEvent('kernel', `内核切换取消在途请求 #${(p as { requestId: number }).requestId}`, 'warn')
      }),
      globalBus.on('pack:mounted', p => {
        refresh()
        pushEvent('pack', `pack 挂载：${(p as { packId: string }).packId}`)
      }),
      globalBus.on('pack:unmounted', p => {
        refresh()
        pushEvent('pack', `pack 卸载：${(p as { packId: string }).packId}`)
      }),
      globalBus.on('pack:reloaded', p => {
        refresh()
        const d = p as { packId: string; durationMs: number }
        pushEvent('pack', `pack 热重载：${d.packId}（${d.durationMs}ms）`)
      }),
      globalBus.on('pack:mount-failed', p => {
        refresh()
        const d = p as { packId: string; phase: string; reason: string }
        pushEvent('pack', `pack 挂载失败：${d.packId}（${d.phase}/${d.reason}）`, 'error')
      }),
      globalBus.on('funnel:routed', p => {
        const d = p as FunnelRoutedRecord
        lastRouted.value = d
        if (d.kind === 'funnel-disabled') {
          pushEvent('funnel', '路由：旧六层内联（funnel 主路径已关闭）', 'warn')
          return
        }
        pushEvent('funnel', `路由：funnel${d.source ? `(${d.source})` : ''} → ${d.kind}${d.handled ? '' : '（回退旧路径）'}`, d.handled ? 'info' : 'warn')
      })
    )
  }

  /** 退订 + 复位（测试用；生产不调） */
  function dispose(): void {
    for (const d of disposers) {
      try { d() } catch { /* best-effort */ }
    }
    disposers = []
    initialized = false
    eventLog.value = []
    lastRouted.value = null
  }

  return {
    activeKernelId,
    kernelState,
    kernelInFlight,
    kernelQueueLen,
    allPackIds,
    mountedPackIds,
    funnelMainEnabled,
    lastRouted,
    eventLog,
    init,
    dispose,
    refresh,
    refreshFunnelFlag,
    toggleFunnelMain
  }
})
