import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { globalBus } from '@/kernel/bus'
import { useDebugStore } from '@/stores/debugStore'
import { registerDebugHandlers } from '@/domains/debug/handlers'

/**
 * /debug 斜杠命令（dialogStore.sendMessage）会 emit 4 条广播：
 *   debug:activate / debug:deactivate / debug:update-environment / debug:unfreeze-buffer
 * 而真正的开关是 debugStore 的方法（App.vue / DialogPanel / DebugWindowPage 直接调）。
 * 若这 4 条无人监听，`/debug` 就只会打印"调试模式已开启"却什么都没发生——谎报。
 */
describe('debug 域：/debug 命令的 4 条频道必须接线到 debugStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    registerDebugHandlers(globalBus)
  })

  it('debug:activate → debugStore.enabled = true', () => {
    const store = useDebugStore()
    expect(store.enabled).toBe(false)
    globalBus.emit('debug:activate', {})
    expect(store.enabled).toBe(true)
  })

  it('debug:deactivate → debugStore.enabled = false', () => {
    const store = useDebugStore()
    globalBus.emit('debug:activate', {})
    expect(store.enabled).toBe(true)
    globalBus.emit('debug:deactivate', {})
    expect(store.enabled).toBe(false)
  })

  it('debug:update-environment → 当前调试会话的 environment 被更新', () => {
    const store = useDebugStore()
    globalBus.emit('debug:activate', {})
    globalBus.emit('debug:update-environment', {
      environment: { model: 'qwen2.5:3b', provider: 'ollama', apiReachable: true, nodeCount: 125, manifestCount: 27 }
    })
    const env = (store as unknown as { currentSession: { environment: Record<string, unknown> } | null }).currentSession?.environment
    expect(env?.model).toBe('qwen2.5:3b')
    expect(env?.nodeCount).toBe(125)
  })

  it('debug:unfreeze-buffer → 冻结缓冲被解除', () => {
    const store = useDebugStore()
    globalBus.emit('debug:activate', {})
    ;(store as unknown as { frozen: boolean }).frozen = true
    globalBus.emit('debug:unfreeze-buffer', {})
    expect((store as unknown as { frozen: boolean }).frozen).toBe(false)
  })
})
